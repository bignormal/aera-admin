package operations

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"slices"
	"strings"
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

func TestWorkerReconcilesOfficialReviewTimeoutWithoutFabricatingSuccess(t *testing.T) {
	postgres := testkit.Postgres(t)
	fixture := newWorkerFixture(t, postgres)
	fixture.actor = seedActor(t, postgres, rbac.SuperAdmin)
	accepted := fixture.enqueueOfficial(t, OfficialSubmissionReview, json.RawMessage(`{"decision":"reject","review_reason_code":"policy_mismatch","safe_note":"Use approved policy."}`))
	fixture.cloud.officialErrors = []error{cloudadmin.ErrUnavailable}
	fixture.cloud.operationResults = []cloudResult{{operation: cloudadmin.Operation{
		ID: accepted.OperationID, Status: cloudadmin.OperationSucceeded, UpdatedAt: fixture.clock().Add(time.Second),
	}}}

	if err := fixture.worker.RunOnce(context.Background()); err != nil {
		t.Fatal(err)
	}
	first, err := fixture.operations.Get(context.Background(), fixture.actor, accepted.OperationID)
	if err != nil || first.State != StateReconciling {
		t.Fatalf("first official state = %+v, %v", first, err)
	}
	fixture.advance(2 * time.Second)
	if err := fixture.worker.RunOnce(context.Background()); err != nil {
		t.Fatal(err)
	}
	final, err := fixture.operations.Get(context.Background(), fixture.actor, accepted.OperationID)
	if err != nil || final.State != StateSucceeded {
		t.Fatalf("final official state = %+v, %v", final, err)
	}
	if len(fixture.cloud.officialCommands) != 1 || !slices.Equal(fixture.cloud.queriedOperationIDs, []uuid.UUID{accepted.OperationID}) {
		t.Fatalf("official dispatch/reconcile = %d/%v", len(fixture.cloud.officialCommands), fixture.cloud.queriedOperationIDs)
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

func TestWorkerDispatchesOfficialCommandWithBoundActor(t *testing.T) {
	postgres := testkit.Postgres(t)
	fixture := newWorkerFixture(t, postgres)
	fixture.actor = seedActor(t, postgres, rbac.Developer)
	accepted := fixture.enqueueOfficial(t, OfficialDefinitionReserve, json.RawMessage(`{"display_name":"Official Research"}`))

	if err := fixture.worker.RunOnce(context.Background()); err != nil {
		t.Fatal(err)
	}
	result, err := fixture.operations.Get(context.Background(), fixture.actor, accepted.OperationID)
	if err != nil || result.State != StateSucceeded {
		t.Fatalf("result = %+v, %v", result, err)
	}
	if len(fixture.cloud.officialActors) != 1 || len(fixture.cloud.officialCommands) != 1 {
		t.Fatalf("official calls = actors:%d commands:%d", len(fixture.cloud.officialActors), len(fixture.cloud.officialCommands))
	}
	actor, command := fixture.cloud.officialActors[0], fixture.cloud.officialCommands[0]
	if actor.AdminID != fixture.actor.AdminID || actor.Role != rbac.Developer || actor.OperationID == nil ||
		*actor.OperationID != accepted.OperationID || command.Action != cloudadmin.OfficialDefinitionReserve ||
		command.TargetID == uuid.Nil || string(command.Payload) != `{"display_name":"Official Research"}` {
		t.Fatalf("official actor/command = %+v / %+v", actor, command)
	}
}

func TestWorkerDispatchesApprovedOfficialRollbackWithDualControlClaims(t *testing.T) {
	postgres := testkit.Postgres(t)
	fixture := newWorkerFixture(t, postgres)
	requester := seedActor(t, postgres, rbac.Operator)
	fixture.actor = seedActor(t, postgres, rbac.SuperAdmin)
	approvalID, releaseID, versionID, revisionID := uuid.New(), uuid.New(), uuid.New(), uuid.New()
	_, err := postgres.Exec(context.Background(), `
		INSERT INTO official_agent_rollback_requests (
			id, release_id, target_version_id, target_release_revision_id,
			expected_head_revision, target_digest, requested_by_admin_id,
			reason_code, approval_status, execution_status, expires_at,
			created_at, updated_at, version
		) VALUES ($1, $2, $3, $4, 4, $5, $6, 'official_release_rollback',
			'pending_review', 'not_started', $7, $8, $8, 1)
	`, approvalID, releaseID, versionID, revisionID, bytes.Repeat([]byte{8}, 32), requester.AdminID,
		fixture.clock().Add(time.Hour), fixture.clock())
	if err != nil {
		t.Fatal(err)
	}
	payload, err := json.Marshal(OfficialReleaseRollbackPayload{
		TargetVersionID: versionID.String(), TargetReleaseRevisionID: revisionID.String(),
		RequesterAdminID: requester.AdminID.String(),
	})
	if err != nil {
		t.Fatal(err)
	}
	tx, err := postgres.Begin(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	accepted, err := fixture.operations.EnqueueTx(context.Background(), tx, EnqueueRequest{
		Actor: fixture.actor, Action: OfficialReleaseRollback, TargetID: releaseID, ExpectedRevision: 4,
		Payload: payload, BrowserIdempotencyKey: uuid.NewString(), OfficialRollbackRequestID: &approvalID,
		Reason: admin.ActionReason{Code: "official_release_rollback", Meta: fixture.actor.Meta},
	})
	if err != nil {
		_ = tx.Rollback(context.Background())
		t.Fatal(err)
	}
	if err := tx.Commit(context.Background()); err != nil {
		t.Fatal(err)
	}

	if err := fixture.worker.RunOnce(context.Background()); err != nil {
		t.Fatal(err)
	}
	result, err := fixture.operations.Get(context.Background(), fixture.actor, accepted.OperationID)
	if err != nil || result.State != StateSucceeded {
		t.Fatalf("result = %+v, %v", result, err)
	}
	if len(fixture.cloud.officialActors) != 1 || len(fixture.cloud.officialCommands) != 1 {
		t.Fatalf("official calls = actors:%d commands:%d", len(fixture.cloud.officialActors), len(fixture.cloud.officialCommands))
	}
	actor, command := fixture.cloud.officialActors[0], fixture.cloud.officialCommands[0]
	if actor.ApprovalID == nil || *actor.ApprovalID != approvalID || actor.RequesterAdminID == nil ||
		*actor.RequesterAdminID != requester.AdminID || command.Action != cloudadmin.OfficialReleaseRollback ||
		strings.Contains(string(command.Payload), "requester_admin_id") {
		t.Fatalf("rollback actor/command = %+v / %+v", actor, command)
	}
}

func TestCompositeExecutionSinkRequiresExactlyOneOwner(t *testing.T) {
	operationID := uuid.New()
	owner := &executionSinkStub{}
	missing := &executionSinkStub{err: ErrExecutionTargetNotFound}
	router, err := CombineExecutionSinks(missing, owner)
	if err != nil {
		t.Fatal(err)
	}
	if err := router.ApplyExecutionTx(context.Background(), nil, operationID, StateExecuting, "", "req-route", time.Now()); err != nil {
		t.Fatal(err)
	}
	if owner.calls != 1 || missing.calls != 1 {
		t.Fatalf("sink calls = owner:%d missing:%d", owner.calls, missing.calls)
	}

	noOwner, err := CombineExecutionSinks(missing)
	if err != nil {
		t.Fatal(err)
	}
	if err := noOwner.ApplyExecutionTx(context.Background(), nil, operationID, StateExecuting, "", "req-route", time.Now()); !errors.Is(err, ErrExecutionTargetNotFound) {
		t.Fatalf("no-owner error = %v", err)
	}

	duplicateOwner, err := CombineExecutionSinks(&executionSinkStub{}, &executionSinkStub{})
	if err != nil {
		t.Fatal(err)
	}
	if err := duplicateOwner.ApplyExecutionTx(context.Background(), nil, operationID, StateExecuting, "", "req-route", time.Now()); !errors.Is(err, ErrStateConflict) {
		t.Fatalf("duplicate-owner error = %v", err)
	}
}

func TestStableExecutionErrorPreservesOfficialPolicyFailures(t *testing.T) {
	if got := stableExecutionError(cloudadmin.ErrPermissionDenied); got != "CLOUD_PERMISSION_DENIED" {
		t.Fatalf("permission code = %q", got)
	}
	if got := stableExecutionError(cloudadmin.ErrPublicationDLPBlocked); got != "PUBLICATION_DLP_BLOCKED" {
		t.Fatalf("DLP code = %q", got)
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
	officialActors      []cloudadmin.ActorContext
	officialCommands    []cloudadmin.OfficialCommand
	officialErrors      []error
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

func (stub *workerCloudStub) RevokeAllSessions(_ context.Context, _ uuid.UUID, meta cloudadmin.CommandMeta) (cloudadmin.Operation, error) {
	return stub.command(meta)
}

func (stub *workerCloudStub) ForcePasswordReset(_ context.Context, _ uuid.UUID, meta cloudadmin.CommandMeta) (cloudadmin.Operation, error) {
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

func (stub *workerCloudStub) ExecuteOfficialCommand(_ context.Context, actor cloudadmin.ActorContext, command cloudadmin.OfficialCommand) (cloudadmin.Operation, error) {
	stub.officialActors = append(stub.officialActors, actor)
	stub.officialCommands = append(stub.officialCommands, command)
	if len(stub.officialErrors) > 0 {
		err := stub.officialErrors[0]
		stub.officialErrors = stub.officialErrors[1:]
		return cloudadmin.Operation{}, err
	}
	return cloudadmin.Operation{
		ID: *actor.OperationID, Status: cloudadmin.OperationSucceeded, UpdatedAt: stub.now(),
	}, nil
}

type noopExecutionSink struct{}

func (noopExecutionSink) ApplyExecutionTx(context.Context, pgx.Tx, uuid.UUID, State, string, string, time.Time) error {
	return nil
}

type executionSinkStub struct {
	calls int
	err   error
}

func (stub *executionSinkStub) ApplyExecutionTx(context.Context, pgx.Tx, uuid.UUID, State, string, string, time.Time) error {
	stub.calls++
	return stub.err
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

func (fixture *workerFixture) enqueueOfficial(t *testing.T, action Action, payload json.RawMessage) Result {
	t.Helper()
	tx, err := fixture.operations.repository.postgres.Begin(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = tx.Rollback(context.Background()) }()
	result, err := fixture.operations.EnqueueTx(context.Background(), tx, EnqueueRequest{
		Actor: fixture.actor, Action: action, TargetID: uuid.New(), ExpectedRevision: 1,
		Payload: payload, BrowserIdempotencyKey: uuid.NewString(),
		Reason: admin.ActionReason{Code: "official_content_review", Meta: fixture.actor.Meta},
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := tx.Commit(context.Background()); err != nil {
		t.Fatal(err)
	}
	return result
}
