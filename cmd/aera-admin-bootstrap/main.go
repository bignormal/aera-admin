package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"io"
	"log/slog"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/bignormal/aera-admin/internal/admin"
	adminaudit "github.com/bignormal/aera-admin/internal/audit"
	"github.com/bignormal/aera-admin/internal/config"
	"github.com/bignormal/aera-admin/internal/rbac"
	"github.com/bignormal/aera-admin/internal/secure"
	adminsettings "github.com/bignormal/aera-admin/internal/settings"
	"github.com/bignormal/aera-admin/internal/store"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

const bootstrapDependencyTimeout = 30 * time.Second

type invocation struct {
	Email       string
	DisplayName string
}

type bootstrapService interface {
	BootstrapInvite(context.Context, admin.InviteRequest) (admin.InvitationResult, error)
}

func main() {
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	if err := run(ctx, os.Args[1:], os.LookupEnv, os.Stdout); err != nil {
		slog.Error("Aera Admin bootstrap failed", "error", err)
		os.Exit(1)
	}
}

func run(ctx context.Context, args []string, lookup config.LookupEnv, output io.Writer) error {
	parsed, err := parseInvocation(args)
	if err != nil {
		return err
	}
	settings, err := config.Load(lookup)
	if err != nil {
		return fmt.Errorf("load configuration: %w", err)
	}
	connectCtx, cancelConnect := context.WithTimeout(ctx, bootstrapDependencyTimeout)
	postgres, err := store.OpenPostgreSQL(connectCtx, settings.DatabaseURL)
	cancelConnect()
	if err != nil {
		return err
	}
	defer postgres.Close()
	migrateCtx, cancelMigrate := context.WithTimeout(ctx, bootstrapDependencyTimeout)
	err = store.Migrate(migrateCtx, postgres)
	cancelMigrate()
	if err != nil {
		return err
	}
	service, err := buildBootstrapService(settings, postgres)
	if err != nil {
		return err
	}
	return execute(ctx, parsed, service, output)
}

func parseInvocation(args []string) (invocation, error) {
	if len(args) == 0 || args[0] != "invite-super-admin" {
		return invocation{}, errors.New("usage: aera-admin-bootstrap invite-super-admin --email <value> --display-name <value>")
	}
	flags := flag.NewFlagSet("invite-super-admin", flag.ContinueOnError)
	flags.SetOutput(io.Discard)
	email := flags.String("email", "", "internal administrator email")
	displayName := flags.String("display-name", "", "administrator display name")
	if err := flags.Parse(args[1:]); err != nil || flags.NArg() != 0 || *email == "" || *displayName == "" {
		return invocation{}, errors.New("usage: aera-admin-bootstrap invite-super-admin --email <value> --display-name <value>")
	}
	return invocation{Email: *email, DisplayName: *displayName}, nil
}

func execute(ctx context.Context, parsed invocation, service bootstrapService, output io.Writer) error {
	if service == nil || output == nil {
		return errors.New("bootstrap execution is unavailable")
	}
	requestID := "req-bootstrap-" + uuid.NewString()
	result, err := service.BootstrapInvite(ctx, admin.InviteRequest{
		Email: parsed.Email, DisplayName: parsed.DisplayName, Role: rbac.SuperAdmin,
		Reason: admin.ActionReason{
			Code: "staff_change", Note: "administrator bootstrap initialization",
			Meta: admin.RequestMeta{RequestID: requestID, UserAgent: "aera-admin-bootstrap/1"},
		},
	})
	if err != nil {
		return err
	}
	if result.ActivationURL == "" {
		return errors.New("bootstrap activation URL is unavailable")
	}
	if _, err := fmt.Fprintln(output, result.ActivationURL); err != nil {
		return errors.New("bootstrap activation URL could not be written")
	}
	return nil
}

func buildBootstrapService(settings config.Config, postgres *pgxpool.Pool) (*admin.Service, error) {
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
	settingsStore, err := adminsettings.NewStore(postgres)
	if err != nil {
		return nil, err
	}
	return admin.NewService(admin.ServiceConfig{
		PostgreSQL: postgres, Passwords: passwords, Identities: identities,
		TOTPSecrets: totpSecrets, TOTP: secure.DefaultTOTP(), Audit: auditService,
		Reasons: settingsStore, PublicURL: settings.PublicURL,
	})
}
