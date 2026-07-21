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
	adminaudit "github.com/bignormal/aera-admin/internal/audit"
	adminauth "github.com/bignormal/aera-admin/internal/auth"
	"github.com/bignormal/aera-admin/internal/config"
	"github.com/bignormal/aera-admin/internal/httpapi"
	"github.com/bignormal/aera-admin/internal/secure"
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
	adminAPI, err := buildAdminAPI(settings, postgres, redisStore.Client())
	if err != nil {
		return err
	}

	handler := httpapi.New(httpapi.Dependencies{PostgreSQL: postgres, Redis: redisStore, API: adminAPI, Web: webui.EmbeddedHandler()})
	server := newHTTPServer(settings.ListenAddr, handler)
	serveResult := make(chan error, 1)
	go func() {
		serveResult <- server.ListenAndServe()
	}()

	select {
	case err := <-serveResult:
		if errors.Is(err, http.ErrServerClosed) {
			return nil
		}
		return fmt.Errorf("serve Aera Admin: %w", err)
	case <-ctx.Done():
		shutdownCtx, cancelShutdown := context.WithTimeout(context.Background(), shutdownTimeout)
		defer cancelShutdown()
		if err := server.Shutdown(shutdownCtx); err != nil {
			return errors.New("shut down Aera Admin")
		}
		return nil
	}
}

func buildAdminAPI(settings config.Config, postgres *pgxpool.Pool, redisClient *redis.Client) (http.Handler, error) {
	passwords, err := secure.DefaultPasswordHasher()
	if err != nil {
		return nil, err
	}
	identities, err := secure.NewIdentityCodec(secure.IdentityCodecConfig{
		ActiveEncryptionKeyID: settings.IdentityEncryptionKeys.ActiveKeyID,
		EncryptionKeys:        settings.IdentityEncryptionKeys.Keys,
		ActiveLookupKeyID:     settings.IdentityLookupKeys.ActiveKeyID,
		LookupKeys:            settings.IdentityLookupKeys.Keys,
	})
	if err != nil {
		return nil, err
	}
	totpSecrets, err := secure.NewSecretCodec(secure.SecretCodecConfig{
		ActiveKeyID: settings.TOTPEncryptionKeys.ActiveKeyID,
		Keys:        settings.TOTPEncryptionKeys.Keys,
	})
	if err != nil {
		return nil, err
	}
	auditService, err := adminaudit.NewService(postgres)
	if err != nil {
		return nil, err
	}
	adminService, err := admin.NewService(admin.ServiceConfig{
		PostgreSQL: postgres, Passwords: passwords, Identities: identities,
		TOTPSecrets: totpSecrets, TOTP: secure.DefaultTOTP(), Audit: auditService,
		PublicURL: settings.PublicURL,
	})
	if err != nil {
		return nil, err
	}
	authService, err := adminauth.NewService(adminauth.ServiceConfig{
		PostgreSQL: postgres, Redis: redisClient, RedisPrefix: "aera-admin:" + settings.Environment + ":",
		Passwords: passwords, Identities: identities, TOTPSecrets: totpSecrets, TOTP: secure.DefaultTOTP(), Audit: auditService,
		SessionHMACKey: settings.SessionHMACKey, CSRFHMACKey: settings.CSRFHMACKey,
	})
	if err != nil {
		return nil, err
	}
	authHandler := adminauth.NewHandler(authService)
	administratorHandler := admin.NewHandlerWithActivationLimiter(adminService, authService)
	router := http.NewServeMux()
	for _, path := range []string{"/auth/login", "/auth/totp/verify", "/auth/step-up", "/auth/logout", "/me"} {
		router.Handle(path, authHandler)
	}
	for _, path := range []string{"/auth/activation/prepare", "/auth/activate", "/admin-users", "/admin-users/"} {
		router.Handle(path, administratorHandler)
	}
	browserSecurity, err := adminauth.NewBrowserSecurity(adminauth.BrowserSecurityConfig{
		Service: authService, PublicURL: settings.PublicURL, SourceIPHMACKey: settings.SessionHMACKey,
		TrustedProxyCIDRs: settings.TrustedProxyCIDRs,
	})
	if err != nil {
		return nil, err
	}
	return browserSecurity.Wrap(router), nil
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
