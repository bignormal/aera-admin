package operations

import (
	"bytes"
	"context"
	"slices"
	"testing"
	"time"

	"github.com/bignormal/aera-admin/internal/admin"
	"github.com/bignormal/aera-admin/internal/audit"
	"github.com/bignormal/aera-admin/internal/cloudadmin"
	"github.com/bignormal/aera-admin/internal/rbac"
	"github.com/bignormal/aera-admin/internal/testkit"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

func TestWorkerReconcilesUnknownResultWithoutChangingOperationID(t *testing.T) {
	postgres := testkit.Postgres(t)
	fixture := newWorkerFixture(t, postgres)
	accepted := fixture.enqueue(t, RevokeSession)
	fixture.cloud.commandErrors = []error{cloudadmin.ErrUnavailable}
	fixture.cloud.operationResults = []cloudResult{{operation: cloudadmin.Operation{
		ID: accepted.OperationID, Status: cloudadmin.OperationSucceeded,
		UpdatedAt: fixture.clock().Add(time.Second),
	}}}

	if err := fixture.worker.RunOnce(context.Background()); err != nil {
		t.Fatal(err)
	}
	first, err := fixture.operations.Get(context.Background(), fixture.actor, accepted.OperationID)
	if err != nil {
		t.Fatal(err)
	}
	if first.State != StateReconciling {
		t.Fatalf("first state = %s", first.State)
	}

	fixture.advance(2 * time.Second)
	if err := fixture.worker.RunOnce(context.Background()); err != nil {
		t.Fatal(err)
	}
	final, err := fixture.operations.Get(context.Background(), fixture.actor, accepted.OperationID)
	if err != nil {
		t.Fatal(err)
	}
	if final.State != StateSucceeded {
		t.Fatalf("final state = %s", final.State)
	}
	if !slices.Equal(fixture.cloud.commandOperationIDs, []uuid.UUID{accepted.OperationID}) ||
		!slices.Equal(fixture.cloud.queriedOperationIDs, []uuid.UUID{accepted.OperationID}) {
		t.Fatalf("operation IDs = commands:%v queries:%v", fixture.cloud.commandOperationIDs, fixture.cloud.queriedOperationIDs)
	}
}

func TestWorkerRecoversExpiredLeaseAfterRestart(t *testing.T) {
	postgres := testkit.Postgres(t)
	fixture := newWorkerFixture(t, postgres)
	accepted := fixture.enqueue(t, RevokeDevice)
	fixture.advance(2 * time.Minute)
	_, err := postgres.Exec(context.Background(), `
		UPDATE admin_outbox SET status = 'executing', lease_until = $2, updated_at = $2
		WHERE operation_id = $1
	`, accepted.OperationID, fixture.clock().Add(-time.Minute))
	if err != nil {
		t.Fatal(err)
	}
	fixture.cloud.operationResults = []cloudResult{{operation: cloudadmin.Operation{
		ID: accepted.OperationID, Status: cloudadmin.OperationSucceeded, UpdatedAt: fixture.clock(),
	}}}
	if err := fixture.worker.RunOnce(context.Background()); err != nil {
		t.Fatal(err)
	}
	result, err := fixture.operations.Get(context.Background(), fixture.actor, accepted.OperationID)
	if err != nil || result.State != StateSucceeded {
		t.Fatalf("result = %+v, %v", result, err)
	}
	if !slices.Equal(fixture.cloud.queriedOperationIDs, []uuid.UUID{accepted.OperationID}) {
		t.Fatalf("reconciled operation IDs = %v", fixture.cloud.queriedOperationIDs)
	}
}

func TestCleanupExpiredDeletesOnlyTerminalOperationPairs(t *testing.T) {
	postgres := testkit.Postgres(t)
	fixture := newWorkerFixture(t, postgres)
	completed := fixture.enqueue(t, RevokeSession)
	if err := fixture.worker.RunOnce(context.Background()); err != nil {
		t.Fatal(err)
	}
	pending := fixture.enqueue(t, RevokeDevice)
	fixture.advance(31 * 24 * time.Hour)
	deleted, err := fixture.operations.repository.CleanupExpired(context.Background(), fixture.clock(), 16)
	if err != nil || deleted != 1 {
		t.Fatalf("CleanupExpired() = %d, %v", deleted, err)
	}
	for _, table := range []string{"admin_outbox", "admin_idempotency_records"} {
		var completedCount, pendingCount int
		if err := postgres.QueryRow(context.Background(), `SELECT count(*) FROM `+table+` WHERE operation_id = $1`, completed.OperationID).Scan(&completedCount); err != nil {
			t.Fatal(err)
		}
		if err := postgres.QueryRow(context.Background(), `SELECT count(*) FROM `+table+` WHERE operation_id = $1`, pending.OperationID).Scan(&pendingCount); err != nil {
			t.Fatal(err)
		}
		if completedCount != 0 || pendingCount != 1 {
			t.Fatalf("%s completed/pending = %d/%d", table, completedCount, pendingCount)
		}
	}
}

type cloudResult struct {
	operation cloudadmin.Operation
	err       error
}

type workerCloudStub struct {
	cloudadmin.DisabledClient
	commandErrors       []error
	commandResults      []cloudadmin.Operation
	operationResults    []cloudResult
	commandOperationIDs []uuid.UUID
	queriedOperationIDs []uuid.UUID
	now                 func() time.Time
}

func (stub *workerCloudStub) Health(context.Context) (cloudadmin.Health, error) {
	return cloudadmin.Health{Configured: true, Availability: cloudadmin.Available, CheckedAt: stub.now()}, nil
}

func (stub *workerCloudStub) command(meta cloudadmin.CommandMeta) (cloudadmin.Operation, error) {
	stub.commandOperationIDs = append(stub.commandOperationIDs, meta.OperationID)
	if len(stub.commandErrors) > 0 {
		err := stub.commandErrors[0]
		stub.commandErrors = stub.commandErrors[1:]
		return cloudadmin.Operation{}, err
	}
	if len(stub.commandResults) > 0 {
		result := stub.commandResults[0]
		stub.commandResults = stub.commandResults[1:]
		return result, nil
	}
	return cloudadmin.Operation{ID: meta.OperationID, Status: cloudadmin.OperationSucceeded, UpdatedAt: stub.now()}, nil
}

func (stub *workerCloudStub) RevokeDevice(_ context.Context, _ uuid.UUID, meta cloudadmin.CommandMeta) (cloudadmin.Operation, error) {
	return stub.command(meta)
}

func (stub *workerCloudStub) RevokeSession(_ context.Context, _ uuid.UUID, meta cloudadmin.CommandMeta) (cloudadmin.Operation, error) {
	return stub.command(meta)
}

func (stub *workerCloudStub) DisableUser(_ context.Context, _ uuid.UUID, meta cloudadmin.CommandMeta) (cloudadmin.Operation, error) {
	return stub.command(meta)
}

func (stub *workerCloudStub) EnableUser(_ context.Context, _ uuid.UUID, meta cloudadmin.CommandMeta) (cloudadmin.Operation, error) {
	return stub.command(meta)
}

func (stub *workerCloudStub) GetOperation(_ context.Context, id uuid.UUID) (cloudadmin.Operation, error) {
	stub.queriedOperationIDs = append(stub.queriedOperationIDs, id)
	if len(stub.operationResults) == 0 {
		return cloudadmin.Operation{}, cloudadmin.ErrNotFound
	}
	result := stub.operationResults[0]
	stub.operationResults = stub.operationResults[1:]
	return result.operation, result.err
}

type noopExecutionSink struct{}

func (noopExecutionSink) ApplyExecutionTx(context.Context, pgx.Tx, uuid.UUID, State, string, string, time.Time) error {
	return nil
}

type workerFixture struct {
	operations *Service
	worker     *Worker
	cloud      *workerCloudStub
	actor      admin.Actor
	now        time.Time
}

func newWorkerFixture(t *testing.T, postgres *pgxpool.Pool) *workerFixture {
	t.Helper()
	fixture := &workerFixture{now: time.Date(2026, 7, 22, 8, 0, 0, 0, time.UTC)}
	fixture.actor = seedActor(t, postgres, rbac.Support)
	fixture.cloud = &workerCloudStub{now: fixture.clock}
	recorder, err := audit.NewService(postgres)
	if err != nil {
		t.Fatal(err)
	}
	fixture.operations, err = NewService(ServiceConfig{
		PostgreSQL: postgres, HMACKey: bytes.Repeat([]byte{7}, 32), Cloud: fixture.cloud,
		Audit: recorder, Clock: fixture.clock,
	})
	if err != nil {
		t.Fatal(err)
	}
	fixture.worker, err = NewWorker(WorkerConfig{
		Operations: fixture.operations, Cloud: fixture.cloud, ExecutionSink: noopExecutionSink{},
		Clock: fixture.clock, PollInterval: time.Second, BatchSize: 8, Lease: 30 * time.Second,
		Jitter: func() time.Duration { return 0 },
	})
	if err != nil {
		t.Fatal(err)
	}
	return fixture
}

func (fixture *workerFixture) clock() time.Time {
	return fixture.now
}

func (fixture *workerFixture) advance(duration time.Duration) {
	fixture.now = fixture.now.Add(duration)
}

func (fixture *workerFixture) enqueue(t *testing.T, action Action) Result {
	t.Helper()
	result, err := fixture.operations.EnqueueImmediate(context.Background(), EnqueueRequest{
		Actor: fixture.actor, Action: action, TargetID: uuid.New(), ExpectedRevision: 1,
		BrowserIdempotencyKey: uuid.NewString(),
		Reason:                admin.ActionReason{Code: "suspected_compromise", Meta: fixture.actor.Meta},
	})
	if err != nil {
		t.Fatal(err)
	}
	return result
}
