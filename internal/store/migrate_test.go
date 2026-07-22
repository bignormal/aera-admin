package store

import (
	"bytes"
	"context"
	"fmt"
	"os"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/bignormal/aera-admin/internal/rbac"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

func TestMigrateCreatesConstrainedSecuritySchema(t *testing.T) {
	postgres := testPostgres(t)
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()

	if err := Migrate(ctx, postgres); err != nil {
		t.Fatalf("Migrate() error = %v", err)
	}
	if err := Migrate(ctx, postgres); err != nil {
		t.Fatalf("second Migrate() error = %v", err)
	}

	for _, table := range []string{
		"schema_migrations",
		"admin_users",
		"admin_identities",
		"admin_password_credentials",
		"admin_totp_credentials",
		"admin_recovery_codes",
		"admin_sessions",
		"admin_invitations",
		"admin_audit_events",
		"admin_audit_checkpoints",
		"reason_codes",
		"admin_security_settings",
		"admin_settings_idempotency",
	} {
		assertTableExists(t, ctx, postgres, table)
	}

	assertCheckConstraint(t, ctx, postgres, "admin_users", "admin_users_role_check")
	assertCheckConstraint(t, ctx, postgres, "admin_users", "admin_users_status_check")
	assertUniqueColumns(t, ctx, postgres, "admin_identities", "admin_identities_lookup_key", []string{"lookup_key_id", "lookup_hmac"})
	assertColumnType(t, ctx, postgres, "admin_audit_events", "previous_hash", "bytea")
	assertCheckConstraintContains(t, ctx, postgres, "admin_invitations", "admin_invitations_totp_secret_check", "num_nonnulls")
	assertCheckConstraintContains(t, ctx, postgres, "admin_invitations", "admin_invitations_totp_secret_check", "consumed_at")
	assertCheckConstraint(t, ctx, postgres, "admin_sessions", "admin_sessions_mfa_method_check")
	assertColumnType(t, ctx, postgres, "admin_sessions", "totp_authenticated_at", "timestamp with time zone")
	assertCheckConstraint(t, ctx, postgres, "admin_sessions", "admin_sessions_totp_time_check")

	var migrationCount int
	var checksumLength int
	if err := postgres.QueryRow(ctx, `SELECT count(*), max(octet_length(checksum)) FROM schema_migrations`).Scan(&migrationCount, &checksumLength); err != nil {
		t.Fatalf("read schema migration ledger: %v", err)
	}
	if migrationCount != 6 || checksumLength != 32 {
		t.Fatalf("migration ledger count/checksum length = %d/%d, want 6/32", migrationCount, checksumLength)
	}

	var reasonCodeCount int
	if err := postgres.QueryRow(ctx, `SELECT count(*) FROM reason_codes WHERE active`).Scan(&reasonCodeCount); err != nil {
		t.Fatalf("count seeded reason codes: %v", err)
	}
	if reasonCodeCount < 8 {
		t.Fatalf("active seeded reason codes = %d, want at least 8", reasonCodeCount)
	}
	var idleMinutes, absoluteHours, retentionDays int
	var settingsRevision int64
	if err := postgres.QueryRow(ctx, `
		SELECT session_idle_minutes, session_absolute_hours, audit_retention_days, revision
		FROM admin_security_settings
		WHERE settings_key = 'global'
	`).Scan(&idleMinutes, &absoluteHours, &retentionDays, &settingsRevision); err != nil {
		t.Fatalf("read seeded administrator security settings: %v", err)
	}
	if idleMinutes != 30 || absoluteHours != 8 || retentionDays != 730 || settingsRevision != 1 {
		t.Fatalf("seeded security policy = %d/%d/%d r%d, want 30/8/730 r1", idleMinutes, absoluteHours, retentionDays, settingsRevision)
	}
	var protectedReasonCount int
	if err := postgres.QueryRow(ctx, `
		SELECT count(*)
		FROM reason_codes
		WHERE code IN ('security_policy_change', 'reason_catalog_change')
		  AND category = 'security' AND active AND revision = 1
	`).Scan(&protectedReasonCount); err != nil {
		t.Fatalf("read protected settings reasons: %v", err)
	}
	if protectedReasonCount != 2 {
		t.Fatalf("protected settings reason count = %d, want 2", protectedReasonCount)
	}
	if _, err := postgres.Exec(ctx, `UPDATE reason_codes SET code = 'renamed_reason' WHERE code = 'session_cleanup'`); err == nil {
		t.Fatal("reason code update unexpectedly succeeded")
	}
	if _, err := postgres.Exec(ctx, `UPDATE reason_codes SET category = 'account' WHERE code = 'session_cleanup'`); err == nil {
		t.Fatal("reason category update unexpectedly succeeded")
	}
	assertUniqueColumns(t, ctx, postgres, "admin_settings_idempotency", "admin_settings_idempotency_actor_key", []string{
		"actor_admin_id", "action", "idempotency_key_hmac",
	})
	assertIndexExists(t, ctx, postgres, "admin_audit_events_event_created_idx")
	assertIndexExists(t, ctx, postgres, "admin_audit_events_outcome_created_idx")
	assertIndexExists(t, ctx, postgres, "admin_audit_events_reason_created_idx")

	settingsActorID := uuid.New()
	seedActiveAdministrator(t, ctx, postgres, settingsActorID, rbac.SuperAdmin)
	keyHMAC := bytes.Repeat([]byte{3}, 32)
	requestHash := bytes.Repeat([]byte{4}, 32)
	insertSettingsIdempotency := func(operationID uuid.UUID) error {
		_, err := postgres.Exec(ctx, `
			INSERT INTO admin_settings_idempotency (
				operation_id, actor_admin_id, action, idempotency_key_hmac, request_hash,
				response_status, response_body, created_at, expires_at
			) VALUES ($1, $2, 'update_security_policy', $3, $4, 200, '{"revision":2}', now(), now() + interval '24 hours')
		`, operationID, settingsActorID, keyHMAC, requestHash)
		return err
	}
	if err := insertSettingsIdempotency(uuid.New()); err != nil {
		t.Fatalf("insert settings idempotency record: %v", err)
	}
	if err := insertSettingsIdempotency(uuid.New()); err == nil {
		t.Fatal("duplicate settings idempotency key unexpectedly succeeded")
	}
	assertColumnType(t, ctx, postgres, "admin_invitations", "totp_ciphertext", "bytea")

	if _, err := postgres.Exec(ctx, `UPDATE schema_migrations SET checksum = $1`, bytes.Repeat([]byte{9}, 32)); err != nil {
		t.Fatalf("modify migration checksum for drift test: %v", err)
	}
	if err := Migrate(ctx, postgres); err == nil {
		t.Fatal("Migrate() accepted a changed checksum")
	}
}

func TestMigrateCreatesConstrainedCloudControlSchema(t *testing.T) {
	postgres := testPostgres(t)
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()

	if err := Migrate(ctx, postgres); err != nil {
		t.Fatalf("Migrate() error = %v", err)
	}
	for _, table := range []string{
		"approval_requests",
		"approval_events",
		"admin_idempotency_records",
		"admin_outbox",
	} {
		assertTableExists(t, ctx, postgres, table)
	}
	assertCheckConstraint(t, ctx, postgres, "approval_requests", "approval_requests_approval_status_check")
	assertCheckConstraint(t, ctx, postgres, "approval_requests", "approval_requests_execution_status_check")
	assertCheckConstraint(t, ctx, postgres, "admin_outbox", "admin_outbox_status_check")
	assertUniqueColumns(t, ctx, postgres, "admin_idempotency_records", "admin_idempotency_actor_key", []string{
		"actor_admin_id", "action", "idempotency_key_hmac",
	})

	actorID := uuid.New()
	seedActiveAdministrator(t, ctx, postgres, actorID, rbac.Operator)
	requestID := uuid.New()
	_, err := postgres.Exec(ctx, `
		INSERT INTO approval_requests (
			id, action, target_user_id, target_snapshot, requested_by_admin_id, requested_by_role,
			reason_code, expected_revision, approval_status, execution_status, expires_at,
			created_at, updated_at, version
		) VALUES ($1, 'disable_user', $2, $3, $4, 'operator', 'policy_violation', 7,
			'pending_review', 'not_started', now() + interval '24 hours', now(), now(), 1)
	`, requestID, uuid.New(), `{"user_id":"019f0000-0000-7000-8000-000000000001","masked_email":"a***@example.test"}`, actorID)
	if err != nil {
		t.Fatalf("insert approval request: %v", err)
	}

	eventID := uuid.New()
	_, err = postgres.Exec(ctx, `
		INSERT INTO approval_events (
			id, approval_request_id, actor_admin_id, actor_role, event_type,
			before_status, after_status, request_id, created_at
		) VALUES ($1, $2, $3, 'operator', 'created', '', 'pending_review', 'req-schema', now())
	`, eventID, requestID, actorID)
	if err != nil {
		t.Fatalf("insert approval event: %v", err)
	}
	if _, err := postgres.Exec(ctx, `UPDATE approval_events SET event_type = 'cancelled' WHERE id = $1`, eventID); err == nil {
		t.Fatal("approval event update unexpectedly succeeded")
	}
	if _, err := postgres.Exec(ctx, `DELETE FROM approval_events WHERE id = $1`, eventID); err == nil {
		t.Fatal("approval event delete unexpectedly succeeded")
	}
}

func TestAdminAuditEventsAreAppendOnly(t *testing.T) {
	postgres := testPostgres(t)
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()

	if err := Migrate(ctx, postgres); err != nil {
		t.Fatalf("Migrate() error = %v", err)
	}

	id := "00000000-0000-4000-8000-000000000001"
	previousHash := bytes.Repeat([]byte{1}, 32)
	eventHash := bytes.Repeat([]byte{2}, 32)
	if _, err := postgres.Exec(ctx, `
		INSERT INTO admin_audit_events (
			id, event_type, object_type, outcome, request_id,
			previous_hash, event_hash, created_at
		) VALUES ($1, 'security.test', 'migration', 'success', 'request-test', $2, $3, now())
	`, id, previousHash, eventHash); err != nil {
		t.Fatalf("insert audit event: %v", err)
	}

	if _, err := postgres.Exec(ctx, `UPDATE admin_audit_events SET note = 'changed' WHERE id = $1`, id); err == nil {
		t.Fatal("updating an audit event succeeded, want append-only rejection")
	}
	if _, err := postgres.Exec(ctx, `DELETE FROM admin_audit_events WHERE id = $1`, id); err == nil {
		t.Fatal("deleting an audit event succeeded, want append-only rejection")
	}
}

func testPostgres(t *testing.T) *pgxpool.Pool {
	t.Helper()
	databaseURL := os.Getenv("AERA_ADMIN_TEST_DATABASE_URL")
	if databaseURL == "" {
		t.Skip("AERA_ADMIN_TEST_DATABASE_URL is not configured")
	}

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	adminPool, err := OpenPostgreSQL(ctx, databaseURL)
	if err != nil {
		t.Fatalf("open integration PostgreSQL: %v", err)
	}

	schema := fmt.Sprintf("aera_admin_test_%d", time.Now().UnixNano())
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

	t.Cleanup(func() {
		postgres.Close()
		cleanupCtx, cleanupCancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cleanupCancel()
		if _, err := adminPool.Exec(cleanupCtx, "DROP SCHEMA "+identifier+" CASCADE"); err != nil {
			t.Errorf("drop isolated test schema: %v", err)
		}
		adminPool.Close()
	})
	return postgres
}

func seedActiveAdministrator(t *testing.T, ctx context.Context, postgres *pgxpool.Pool, id uuid.UUID, role rbac.Role) {
	t.Helper()
	_, err := postgres.Exec(ctx, `
		INSERT INTO admin_users (id, display_name, role, status, security_version, created_at, updated_at)
		VALUES ($1, 'Schema Actor', $2, 'active', 1, now(), now())
	`, id, role)
	if err != nil {
		t.Fatalf("seed active administrator: %v", err)
	}
}

func assertTableExists(t *testing.T, ctx context.Context, postgres *pgxpool.Pool, table string) {
	t.Helper()
	var exists bool
	if err := postgres.QueryRow(ctx, `
		SELECT EXISTS (
			SELECT 1
			FROM information_schema.tables
			WHERE table_schema = current_schema() AND table_name = $1
		)
	`, table).Scan(&exists); err != nil {
		t.Fatalf("check table %s: %v", table, err)
	}
	if !exists {
		t.Errorf("table %s does not exist", table)
	}
}

func assertCheckConstraint(t *testing.T, ctx context.Context, postgres *pgxpool.Pool, table, constraint string) {
	t.Helper()
	var exists bool
	if err := postgres.QueryRow(ctx, `
		SELECT EXISTS (
			SELECT 1
			FROM pg_constraint c
			JOIN pg_class r ON r.oid = c.conrelid
			JOIN pg_namespace n ON n.oid = r.relnamespace
			WHERE n.nspname = current_schema()
			  AND r.relname = $1
			  AND c.conname = $2
			  AND c.contype = 'c'
		)
	`, table, constraint).Scan(&exists); err != nil {
		t.Fatalf("check constraint %s.%s: %v", table, constraint, err)
	}
	if !exists {
		t.Errorf("check constraint %s.%s does not exist", table, constraint)
	}
}

func assertCheckConstraintContains(t *testing.T, ctx context.Context, postgres *pgxpool.Pool, table, constraint, fragment string) {
	t.Helper()
	var definition string
	if err := postgres.QueryRow(ctx, `
		SELECT pg_get_constraintdef(c.oid)
		FROM pg_constraint c
		JOIN pg_class r ON r.oid = c.conrelid
		JOIN pg_namespace n ON n.oid = r.relnamespace
		WHERE n.nspname = current_schema() AND r.relname = $1 AND c.conname = $2
	`, table, constraint).Scan(&definition); err != nil {
		t.Fatalf("read check constraint %s.%s: %v", table, constraint, err)
	}
	if !strings.Contains(definition, fragment) {
		t.Errorf("check constraint %s.%s = %q, want fragment %q", table, constraint, definition, fragment)
	}
}

func assertUniqueColumns(t *testing.T, ctx context.Context, postgres *pgxpool.Pool, table, constraint string, want []string) {
	t.Helper()
	rows, err := postgres.Query(ctx, `
		SELECT a.attname
		FROM pg_constraint c
		JOIN pg_class r ON r.oid = c.conrelid
		JOIN pg_namespace n ON n.oid = r.relnamespace
		JOIN unnest(c.conkey) WITH ORDINALITY AS key(attnum, position) ON true
		JOIN pg_attribute a ON a.attrelid = r.oid AND a.attnum = key.attnum
		WHERE n.nspname = current_schema()
		  AND r.relname = $1
		  AND c.conname = $2
		  AND c.contype = 'u'
		ORDER BY key.position
	`, table, constraint)
	if err != nil {
		t.Fatalf("query unique constraint %s.%s: %v", table, constraint, err)
	}
	defer rows.Close()

	var got []string
	for rows.Next() {
		var column string
		if err := rows.Scan(&column); err != nil {
			t.Fatalf("scan unique constraint %s.%s: %v", table, constraint, err)
		}
		got = append(got, column)
	}
	if err := rows.Err(); err != nil {
		t.Fatalf("read unique constraint %s.%s: %v", table, constraint, err)
	}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("unique constraint %s.%s columns = %v, want %v", table, constraint, got, want)
	}
}

func assertColumnType(t *testing.T, ctx context.Context, postgres *pgxpool.Pool, table, column, want string) {
	t.Helper()
	var got string
	if err := postgres.QueryRow(ctx, `
		SELECT data_type
		FROM information_schema.columns
		WHERE table_schema = current_schema() AND table_name = $1 AND column_name = $2
	`, table, column).Scan(&got); err != nil {
		t.Fatalf("read column type %s.%s: %v", table, column, err)
	}
	if got != want {
		t.Errorf("column type %s.%s = %q, want %q", table, column, got, want)
	}
}

func assertIndexExists(t *testing.T, ctx context.Context, postgres *pgxpool.Pool, index string) {
	t.Helper()
	var exists bool
	if err := postgres.QueryRow(ctx, `
		SELECT EXISTS (
			SELECT 1
			FROM pg_indexes
			WHERE schemaname = current_schema() AND indexname = $1
		)
	`, index).Scan(&exists); err != nil {
		t.Fatalf("check index %s: %v", index, err)
	}
	if !exists {
		t.Errorf("index %s does not exist", index)
	}
}
