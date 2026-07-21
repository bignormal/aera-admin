package operations

import (
	"bytes"
	"context"
	"errors"
	"testing"
	"time"

	"github.com/bignormal/aera-admin/internal/admin"
	"github.com/bignormal/aera-admin/internal/audit"
	"github.com/bignormal/aera-admin/internal/rbac"
	"github.com/bignormal/aera-admin/internal/testkit"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

func TestEnqueueTxReturnsSameOperationForSameSemanticRequest(t *testing.T) {
	postgres := testkit.Postgres(t)
	auditService, err := audit.NewService(postgres)
	if err != nil {
		t.Fatal(err)
	}
	actor := seedOperator(t, postgres)
	repository, err := newRepository(postgres, bytes.Repeat([]byte{9}, 32), auditService, fixedClock)
	if err != nil {
		t.Fatal(err)
	}
	request := EnqueueRequest{
		Actor: actor, Action: RevokeSession, TargetID: uuid.New(), ExpectedRevision: 4,
		BrowserIdempotencyKey: "019f0000-0000-7000-8000-000000000021",
		Reason:                admin.ActionReason{Code: "suspected_compromise", Meta: actor.Meta},
	}
	first, err := repository.Enqueue(context.Background(), request)
	if err != nil {
		t.Fatal(err)
	}
	second, err := repository.Enqueue(context.Background(), request)
	if err != nil {
		t.Fatal(err)
	}
	if first.OperationID != second.OperationID || first.State != StateQueued {
		t.Fatalf("results = %+v %+v", first, second)
	}
	var idempotencyCount, outboxCount, auditCount int
	if err := postgres.QueryRow(context.Background(), `SELECT count(*) FROM admin_idempotency_records WHERE operation_id = $1`, first.OperationID).Scan(&idempotencyCount); err != nil {
		t.Fatal(err)
	}
	if err := postgres.QueryRow(context.Background(), `SELECT count(*) FROM admin_outbox WHERE operation_id = $1`, first.OperationID).Scan(&outboxCount); err != nil {
		t.Fatal(err)
	}
	if err := postgres.QueryRow(context.Background(), `SELECT count(*) FROM admin_audit_events WHERE operation_id = $1`, first.OperationID).Scan(&auditCount); err != nil {
		t.Fatal(err)
	}
	if idempotencyCount != 1 || outboxCount != 1 || auditCount != 1 {
		t.Fatalf("counts = idempotency:%d outbox:%d audit:%d", idempotencyCount, outboxCount, auditCount)
	}
}

func TestEnqueueTxRejectsIdempotencyKeyReuseForDifferentRequest(t *testing.T) {
	postgres := testkit.Postgres(t)
	auditService, err := audit.NewService(postgres)
	if err != nil {
		t.Fatal(err)
	}
	actor := seedOperator(t, postgres)
	repository, err := newRepository(postgres, bytes.Repeat([]byte{9}, 32), auditService, fixedClock)
	if err != nil {
		t.Fatal(err)
	}
	request := EnqueueRequest{
		Actor: actor, Action: RevokeDevice, TargetID: uuid.New(), ExpectedRevision: 4,
		BrowserIdempotencyKey: "019f0000-0000-7000-8000-000000000022",
		Reason:                admin.ActionReason{Code: "lost_device", Meta: actor.Meta},
	}
	if _, err := repository.Enqueue(context.Background(), request); err != nil {
		t.Fatal(err)
	}
	request.TargetID = uuid.New()
	if _, err := repository.Enqueue(context.Background(), request); !errors.Is(err, ErrIdempotencyKeyReused) {
		t.Fatalf("Enqueue() error = %v", err)
	}
}

func seedActor(t *testing.T, postgres *pgxpool.Pool, role rbac.Role) admin.Actor {
	t.Helper()
	id := uuid.New()
	_, err := postgres.Exec(context.Background(), `
		INSERT INTO admin_users (id, display_name, role, status, security_version, created_at, updated_at)
		VALUES ($1, 'Operation Test Actor', $2, 'active', 1, now(), now())
	`, id, role)
	if err != nil {
		t.Fatal(err)
	}
	return admin.Actor{AdminID: id, Role: role, Meta: admin.RequestMeta{RequestID: "req-operation", UserAgent: "operations-test"}}
}

func seedOperator(t *testing.T, postgres *pgxpool.Pool) admin.Actor {
	t.Helper()
	return seedActor(t, postgres, rbac.Operator)
}

func fixedClock() time.Time {
	return time.Date(2026, 7, 22, 8, 0, 0, 0, time.UTC)
}
