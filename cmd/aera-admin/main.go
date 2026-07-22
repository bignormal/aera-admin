package main

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/bignormal/aera-admin/internal/admin"
	"github.com/bignormal/aera-admin/internal/approval"
	adminaudit "github.com/bignormal/aera-admin/internal/audit"
	"github.com/bignormal/aera-admin/internal/audithttp"
	adminauth "github.com/bignormal/aera-admin/internal/auth"
	"github.com/bignormal/aera-admin/internal/cloudadmin"
	"github.com/bignormal/aera-admin/internal/cloudcontrol"
	"github.com/bignormal/aera-admin/internal/config"
	"github.com/bignormal/aera-admin/internal/httpapi"
	"github.com/bignormal/aera-admin/internal/officialagent"
	"github.com/bignormal/aera-admin/internal/operations"
	"github.com/bignormal/aera-admin/internal/secure"
	adminsettings "github.com/bignormal/aera-admin/internal/settings"
	"github.com/bignormal/aera-admin/internal/store"
	"github.com/bignormal/aera-admin/internal/webui"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/redis/go-redis/v9"
)

const (
	dependencyTimeout = 5 * time.Second
	migrationTimeout  = 30 * time.Second
	shutdownTimeout   = 10 * time.Second
)

func main() {
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	if err := run(ctx, os.LookupEnv); err != nil {
		slog.Error("Aera Admin stopped", "error", err)
		os.Exit(1)
	}
}

func run(ctx context.Context, lookup config.LookupEnv) error {
	settings, err := config.Load(lookup)
	if err != nil {
		return fmt.Errorf("load configuration: %w", err)
	}
	postgresCtx, cancelPostgres := context.WithTimeout(ctx, dependencyTimeout)
	postgres, err := store.OpenPostgreSQL(postgresCtx, settings.DatabaseURL)
	cancelPostgres()
	if err != nil {
		return err
	}
	defer postgres.Close()
	migrateCtx, cancelMigrate := context.WithTimeout(ctx, migrationTimeout)
	if err := store.Migrate(migrateCtx, postgres); err != nil {
		cancelMigrate()
		return err
	}
	cancelMigrate()
	redisCtx, cancelRedis := context.WithTimeout(ctx, dependencyTimeout)
	redisStore, err := store.OpenRedis(redisCtx, store.RedisConfig{Address: settings.RedisAddr})
	cancelRedis()
	if err != nil {
		return err
	}
	defer func() { _ = redisStore.Close() }()
	runtime, err := buildAdminRuntime(settings, postgres, redisStore.Client())
	if err != nil {
		return err
	}

	handler := httpapi.New(httpapi.Dependencies{
		PostgreSQL: postgres,
		Redis:      redisStore,
		API:        runtime.API,
		Web:        webui.EmbeddedHandler(),
		Production: settings.Environment == "production",
	})
	server := newHTTPServer(settings.ListenAddr, handler)
	runtimeCtx, cancelRuntime := context.WithCancel(ctx)
	defer cancelRuntime()
	serveResult := make(chan error, 1)
	workerResult := make(chan error, 1)
	go func() {
		serveResult <- server.ListenAndServe()
	}()
	go func() {
		workerResult <- runtime.Worker.Run(runtimeCtx)
	}()
	shutdown := func() error {
		shutdownCtx, cancelShutdown := context.WithTimeout(context.Background(), shutdownTimeout)
		defer cancelShutdown()
		return server.Shutdown(shutdownCtx)
	}

	select {
	case err := <-serveResult:
		cancelRuntime()
		if errors.Is(err, http.ErrServerClosed) {
			return nil
		}
		return fmt.Errorf("serve Aera Admin: %w", err)
	case err := <-workerResult:
		cancelRuntime()
		_ = shutdown()
		if err == nil && ctx.Err() != nil {
			return nil
		}
		if err == nil {
			return errors.New("Admin Outbox Worker stopped unexpectedly")
		}
		return fmt.Errorf("run Admin Outbox Worker: %w", err)
	case <-ctx.Done():
		cancelRuntime()
		if err := shutdown(); err != nil {
			return errors.New("shut down Aera Admin")
		}
		return nil
	}
}

type adminRuntime struct {
	API    http.Handler
	Worker *operations.Worker
}

func buildAdminRuntime(settings config.Config, postgres *pgxpool.Pool, redisClient *redis.Client) (adminRuntime, error) {
	passwords, err := secure.DefaultPasswordHasher()
	if err != nil {
		return adminRuntime{}, err
	}
	identities, err := secure.NewIdentityCodec(secure.IdentityCodecConfig{
		ActiveEncryptionKeyID: settings.IdentityEncryptionKeys.ActiveKeyID,
		EncryptionKeys:        settings.IdentityEncryptionKeys.Keys,
		ActiveLookupKeyID:     settings.IdentityLookupKeys.ActiveKeyID,
		LookupKeys:            settings.IdentityLookupKeys.Keys,
	})
	if err != nil {
		return adminRuntime{}, err
	}
	totpSecrets, err := secure.NewSecretCodec(secure.SecretCodecConfig{
		ActiveKeyID: settings.TOTPEncryptionKeys.ActiveKeyID,
		Keys:        settings.TOTPEncryptionKeys.Keys,
	})
	if err != nil {
		return adminRuntime{}, err
	}
	auditService, err := adminaudit.NewService(postgres)
	if err != nil {
		return adminRuntime{}, err
	}
	settingsStore, err := adminsettings.NewStore(postgres)
	if err != nil {
		return adminRuntime{}, err
	}
	adminService, err := admin.NewService(admin.ServiceConfig{
		PostgreSQL: postgres, Passwords: passwords, Identities: identities,
		TOTPSecrets: totpSecrets, TOTP: secure.DefaultTOTP(), Audit: auditService,
		Reasons: settingsStore, PublicURL: settings.PublicURL,
	})
	if err != nil {
		return adminRuntime{}, err
	}
	authService, err := adminauth.NewService(adminauth.ServiceConfig{
		PostgreSQL: postgres, Redis: redisClient, RedisPrefix: "aera-admin:" + settings.Environment + ":",
		Passwords: passwords, Identities: identities, TOTPSecrets: totpSecrets, TOTP: secure.DefaultTOTP(), Audit: auditService,
		SessionHMACKey: settings.SessionHMACKey, CSRFHMACKey: settings.CSRFHMACKey,
		SessionPolicy: settingsStore,
	})
	if err != nil {
		return adminRuntime{}, err
	}
	authHandler := adminauth.NewHandler(authService)
	administratorHandler := admin.NewHandlerWithActivationLimiter(adminService, authService)
	settingsService, err := adminsettings.NewService(adminsettings.ServiceConfig{
		Store: settingsStore, Audit: auditService, HMACKey: settings.OperationHMACKey,
		Clock: time.Now, LiveSessions: authService,
	})
	if err != nil {
		return adminRuntime{}, err
	}
	settingsHandler := adminsettings.NewHandler(settingsService)
	cloudClient, err := cloudadmin.NewHTTPClient(settings.CloudAdmin, time.Now)
	if err != nil {
		return adminRuntime{}, err
	}
	operationService, err := operations.NewService(operations.ServiceConfig{
		PostgreSQL: postgres,
		HMACKey:    settings.OperationHMACKey,
		Cloud:      cloudClient,
		Audit:      auditService,
		Clock:      time.Now,
	})
	if err != nil {
		return adminRuntime{}, err
	}
	approvalService, err := approval.NewService(approval.ServiceConfig{
		PostgreSQL: postgres,
		Cloud:      cloudClient,
		Operations: operationService,
		Audit:      auditService,
		Reasons:    settingsStore,
		Clock:      time.Now,
	})
	if err != nil {
		return adminRuntime{}, err
	}
	officialService, err := officialagent.NewService(officialagent.ServiceConfig{
		PostgreSQL: postgres,
		Cloud:      cloudClient,
		Operations: operationService,
		Audit:      auditService,
		Reasons:    settingsStore,
		Clock:      time.Now,
	})
	if err != nil {
		return adminRuntime{}, err
	}
	executionSink, err := operations.CombineExecutionSinks(approvalService, officialService)
	if err != nil {
		return adminRuntime{}, err
	}
	worker, err := operations.NewWorker(operations.WorkerConfig{
		Operations:    operationService,
		Cloud:         cloudClient,
		ExecutionSink: executionSink,
		Clock:         time.Now,
		PollInterval:  time.Second,
		BatchSize:     8,
		Lease:         30 * time.Second,
	})
	if err != nil {
		return adminRuntime{}, err
	}
	cloudService, err := cloudcontrol.NewService(cloudcontrol.ServiceConfig{
		PostgreSQL: postgres,
		Redis:      redisClient,
		Cloud:      cloudClient,
		Operations: operationService,
		Approvals:  approvalService,
		Audit:      auditService,
		Reasons:    settingsStore,
		Clock:      time.Now,
	})
	if err != nil {
		return adminRuntime{}, err
	}
	auditHandler := audithttp.NewHandler(auditService)
	cloudHandler := cloudcontrol.NewHandler(cloudService)
	officialHandler := officialagent.NewHandler(officialService)
	router := newAdminRouter(authHandler, administratorHandler, cloudHandler, auditHandler, settingsHandler, officialHandler)
	browserSecurity, err := adminauth.NewBrowserSecurity(adminauth.BrowserSecurityConfig{
		Service: authService, PublicURL: settings.PublicURL, SourceIPHMACKey: settings.SessionHMACKey,
		TrustedProxyCIDRs: settings.TrustedProxyCIDRs,
	})
	if err != nil {
		return adminRuntime{}, err
	}
	return adminRuntime{API: browserSecurity.Wrap(router), Worker: worker}, nil
}

func newAdminRouter(authHandler, administratorHandler, cloudHandler, auditHandler, settingsHandler, officialHandler http.Handler) *http.ServeMux {
	router := http.NewServeMux()
	for _, path := range []string{"/auth/login", "/auth/totp/verify", "/auth/step-up", "/auth/logout", "/me"} {
		router.Handle(path, authHandler)
	}
	for _, path := range []string{"/auth/activation/prepare", "/auth/activate", "/admin-users", "/admin-users/"} {
		router.Handle(path, administratorHandler)
	}
	for _, path := range []string{
		"/cloud-users", "/cloud-users/", "/cloud-devices/", "/cloud-sessions/",
		"/approval-requests", "/approval-requests/", "/operations/", "/system/health",
	} {
		router.Handle(path, cloudHandler)
	}
	router.Handle("/audit-events", auditHandler)
	for _, path := range []string{"/system/settings", "/system/settings/", "/system/reason-codes", "/system/reason-codes/"} {
		router.Handle(path, settingsHandler)
	}
	for _, path := range []string{
		"/official-agents", "/official-agents/", "/official-agent-drafts", "/official-agent-drafts/",
		"/official-agent-submissions", "/official-agent-submissions/", "/official-agent-versions",
		"/official-agent-releases", "/official-agent-releases/", "/official-agent-rollback-requests",
		"/official-agent-rollback-requests/", "/official-agent-audit-events",
	} {
		router.Handle(path, officialHandler)
	}
	return router
}

func newHTTPServer(address string, handler http.Handler) *http.Server {
	return &http.Server{
		Addr:              address,
		Handler:           handler,
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       15 * time.Second,
		WriteTimeout:      30 * time.Second,
		IdleTimeout:       60 * time.Second,
	}
}
