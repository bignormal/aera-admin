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

	"github.com/bignormal/aera-admin/internal/config"
	"github.com/bignormal/aera-admin/internal/httpapi"
	"github.com/bignormal/aera-admin/internal/store"
	"github.com/bignormal/aera-admin/internal/webui"
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

	handler := httpapi.New(httpapi.Dependencies{PostgreSQL: postgres, Redis: redisStore, Web: webui.EmbeddedHandler()})
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
