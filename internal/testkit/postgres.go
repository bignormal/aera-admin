package testkit

import (
	"context"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/bignormal/aera-admin/internal/store"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

func Postgres(t testing.TB) *pgxpool.Pool {
	t.Helper()
	databaseURL := os.Getenv("AERA_ADMIN_TEST_DATABASE_URL")
	if databaseURL == "" {
		t.Skip("AERA_ADMIN_TEST_DATABASE_URL is not configured")
	}

	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	adminPool, err := store.OpenPostgreSQL(ctx, databaseURL)
	if err != nil {
		t.Fatalf("open integration PostgreSQL: %v", err)
	}

	schema := "aera_admin_test_" + strings.ReplaceAll(uuid.NewString(), "-", "")
	identifier := pgx.Identifier{schema}.Sanitize()
	if _, err := adminPool.Exec(ctx, "CREATE SCHEMA "+identifier); err != nil {
		adminPool.Close()
		t.Fatalf("create isolated test schema: %v", err)
	}

	config, err := pgxpool.ParseConfig(databaseURL)
	if err != nil {
		adminPool.Close()
		t.Fatalf("parse integration PostgreSQL URL: %v", err)
	}
	config.ConnConfig.RuntimeParams["search_path"] = schema
	postgres, err := pgxpool.NewWithConfig(ctx, config)
	if err != nil {
		adminPool.Close()
		t.Fatalf("open isolated test schema: %v", err)
	}
	if err := postgres.Ping(ctx); err != nil {
		postgres.Close()
		adminPool.Close()
		t.Fatalf("ping isolated test schema: %v", err)
	}
	if err := store.Migrate(ctx, postgres); err != nil {
		postgres.Close()
		_, _ = adminPool.Exec(context.Background(), "DROP SCHEMA "+identifier+" CASCADE")
		adminPool.Close()
		t.Fatalf("migrate isolated test schema: %v", err)
	}

	t.Cleanup(func() {
		postgres.Close()
		cleanupCtx, cleanupCancel := context.WithTimeout(context.Background(), 15*time.Second)
		defer cleanupCancel()
		if _, err := adminPool.Exec(cleanupCtx, "DROP SCHEMA "+identifier+" CASCADE"); err != nil {
			t.Errorf("drop isolated test schema: %v", err)
		}
		adminPool.Close()
	})
	return postgres
}
