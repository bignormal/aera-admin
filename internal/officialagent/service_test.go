package officialagent

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/bignormal/aera-admin/internal/admin"
	"github.com/bignormal/aera-admin/internal/audit"
	"github.com/bignormal/aera-admin/internal/cloudadmin"
	"github.com/bignormal/aera-admin/internal/operations"
	"github.com/bignormal/aera-admin/internal/rbac"
	"github.com/bignormal/aera-admin/internal/settings"
	"github.com/bignormal/aera-admin/internal/testkit"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

func TestOfficialServiceFailsClosedAndQueuesDraftMutation(t *testing.T) {
	postgres := testkit.Postgres(t)
	fixture := newOfficialServiceFixture(t, postgres)
	developer := fixture.seedActor(t, rbac.Developer)
	fixture.cloud.readErr = cloudadmin.ErrUnavailable
	if _, err := fixture.service.ListDefinitions(context.Background(), developer, cloudadmin.PageRequest{Limit: 20}); !errors.Is(err, cloudadmin.ErrUnavailable) {
		t.Fatalf("ListDefinitions() error = %v", err)
	}
	finance := fixture.seedActor(t, rbac.Finance)
	fixture.cloud.readErr = nil
	if _, err := fixture.service.ListDefinitions(context.Background(), finance, cloudadmin.PageRequest{Limit: 20}); !errors.Is(err, ErrPermissionDenied) {
		t.Fatalf("Finance ListDefinitions() error = %v", err)
	}

	targetID, baseVersionID := uuid.New(), uuid.New()
	digest := strings.Repeat("a", 64)
	fixture.cloud.draft = cloudadmin.OfficialDraft{ID: targetID, Revision: 3, ContentDigest: digest}
	payload := officialDraftUpdatePayload(t, baseVersionID)
	result, err := fixture.service.Enqueue(context.Background(), developer, MutationRequest{
		Action: operations.OfficialDraftUpdate, TargetID: targetID, ExpectedRevision: 3,
		ExpectedTargetDigest: digest, Payload: payload, BrowserIdempotencyKey: uuid.NewString(),
		Reason: officialReason(developer, "official_content_review"),
	})
	if err != nil || result.State != operations.StateQueued {
		t.Fatalf("Enqueue() = %+v, %v", result, err)
	}
	var outboxState string
	if err := postgres.QueryRow(context.Background(), `SELECT status FROM admin_outbox WHERE operation_id = $1`, result.OperationID).Scan(&outboxState); err != nil {
		t.Fatal(err)
	}
	if outboxState != "queued" {
		t.Fatalf("Outbox state = %q", outboxState)
	}
}

func TestOfficialServiceRejectsSubmissionSelfReviewBeforeEnqueue(t *testing.T) {
	postgres := testkit.Postgres(t)
	fixture := newOfficialServiceFixture(t, postgres)
	reviewer := fixture.seedActor(t, rbac.SuperAdmin)
	submissionID := uuid.New()
	digest := strings.Repeat("b", 64)
	fixture.cloud.submission = cloudadmin.OfficialSubmission{
		ID: submissionID, Revision: 2, ContentDigest: digest, SubmittedByAdminID: reviewer.AdminID,
	}
	_, err := fixture.service.Enqueue(context.Background(), reviewer, MutationRequest{
		Action: operations.OfficialSubmissionReview, TargetID: submissionID, ExpectedRevision: 2,
		ExpectedTargetDigest:  digest,
		Payload:               json.RawMessage(`{"decision":"reject","review_reason_code":"policy_mismatch","safe_note":"Use approved policy."}`),
		BrowserIdempotencyKey: uuid.NewString(), Reason: officialReason(reviewer, "official_content_review"),
	})
	if !errors.Is(err, ErrSelfReview) {
		t.Fatalf("self review error = %v", err)
	}
	var count int
	if err := postgres.QueryRow(context.Background(), `SELECT count(*) FROM admin_outbox`).Scan(&count); err != nil || count != 0 {
		t.Fatalf("Outbox count/error = %d/%v", count, err)
	}
}

func TestOfficialRollbackRequiresDifferentApprovalAndQueuesExactlyOnce(t *testing.T) {
	postgres := testkit.Postgres(t)
	fixture := newOfficialServiceFixture(t, postgres)
	requester := fixture.seedActor(t, rbac.Operator)
	approver := fixture.seedActor(t, rbac.SuperAdmin)
	releaseID, versionID, revisionID := uuid.New(), uuid.New(), uuid.New()
	digest := strings.Repeat("c", 64)
	fixture.cloud.release = cloudadmin.OfficialRelease{
		ID: releaseID, DefinitionID: uuid.New(), HeadRevision: 4, AgentVersionID: uuid.New(),
	}
	fixture.cloud.version = cloudadmin.OfficialVersion{
		ID: versionID, DefinitionID: fixture.cloud.release.DefinitionID, ContentDigest: digest,
	}
	approval, err := fixture.service.RequestRollback(context.Background(), requester, RollbackRequest{
		ReleaseID: releaseID, TargetVersionID: versionID, TargetReleaseRevisionID: revisionID,
		ExpectedHeadRevision: 4, TargetDigest: digest,
		Reason: officialReason(requester, "official_release_rollback"),
	})
	if err != nil || approval.ApprovalStatus != PendingReview || approval.ExecutionStatus != NotStarted {
		t.Fatalf("RequestRollback() = %+v, %v", approval, err)
	}
	if _, err := fixture.service.ApproveRollback(context.Background(), admin.Actor{
		AdminID: requester.AdminID, Role: rbac.SuperAdmin, Meta: requester.Meta,
	}, approval.ID, uuid.NewString()); !errors.Is(err, ErrSelfReview) {
		t.Fatalf("same-admin approval error = %v", err)
	}

	approved, err := fixture.service.ApproveRollback(context.Background(), approver, approval.ID, uuid.NewString())
	if err != nil || approved.ApprovalStatus != Approved || approved.ExecutionStatus != Queued || approved.OperationID == nil {
		t.Fatalf("ApproveRollback() = %+v, %v", approved, err)
	}
	var outboxCount, operationCount int
	if err := postgres.QueryRow(context.Background(), `SELECT count(*) FROM admin_outbox WHERE official_rollback_request_id = $1`, approval.ID).Scan(&outboxCount); err != nil {
		t.Fatal(err)
	}
	if err := postgres.QueryRow(context.Background(), `SELECT count(*) FROM admin_idempotency_records WHERE operation_id = $1 AND state = 'queued'`, *approved.OperationID).Scan(&operationCount); err != nil {
		t.Fatal(err)
	}
	if outboxCount != 1 || operationCount != 1 {
		t.Fatalf("queued rollback counts = outbox:%d operation:%d", outboxCount, operationCount)
	}
	worker, err := operations.NewWorker(operations.WorkerConfig{
		Operations: fixture.operationService, Cloud: fixture.cloud, ExecutionSink: fixture.service,
		Clock: fixture.clock, PollInterval: time.Second, BatchSize: 8, Lease: 30 * time.Second,
		Jitter: func() time.Duration { return 0 },
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := worker.RunOnce(context.Background()); err != nil {
		t.Fatal(err)
	}
	completed, err := fixture.service.GetRollback(context.Background(), approver, approval.ID)
	if err != nil || completed.ExecutionStatus != Succeeded {
		t.Fatalf("completed rollback = %+v, %v", completed, err)
	}
}

func TestOfficialRollbackRejectsStaleDigestAndSupportsTerminalReviewStates(t *testing.T) {
	postgres := testkit.Postgres(t)
	fixture := newOfficialServiceFixture(t, postgres)
	requester := fixture.seedActor(t, rbac.Operator)
	approver := fixture.seedActor(t, rbac.SuperAdmin)

	create := func(digest string) RollbackApproval {
		releaseID, versionID := uuid.New(), uuid.New()
		fixture.cloud.release = cloudadmin.OfficialRelease{
			ID: releaseID, DefinitionID: uuid.New(), CurrentRevisionID: uuid.New(),
			HeadRevision: 4, AgentVersionID: uuid.New(),
		}
		fixture.cloud.version = cloudadmin.OfficialVersion{
			ID: versionID, DefinitionID: fixture.cloud.release.DefinitionID, ContentDigest: digest,
		}
		approval, err := fixture.service.RequestRollback(context.Background(), requester, RollbackRequest{
			ReleaseID: releaseID, TargetVersionID: versionID, TargetReleaseRevisionID: uuid.New(),
			ExpectedHeadRevision: 4, TargetDigest: digest,
			Reason: officialReason(requester, "official_release_rollback"),
		})
		if err != nil {
			t.Fatal(err)
		}
		return approval
	}

	stale := create(strings.Repeat("d", 64))
	fixture.cloud.version.ContentDigest = strings.Repeat("e", 64)
	if _, err := fixture.service.ApproveRollback(context.Background(), approver, stale.ID, uuid.NewString()); !errors.Is(err, ErrTargetDigestMismatch) {
		t.Fatalf("stale digest approval error = %v", err)
	}
	persisted, err := fixture.service.GetRollback(context.Background(), approver, stale.ID)
	if err != nil || persisted.ApprovalStatus != PendingReview || persisted.OperationID != nil {
		t.Fatalf("stale approval persisted = %+v, %v", persisted, err)
	}

	cancelled := create(strings.Repeat("f", 64))
	cancelled, err = fixture.service.CancelRollback(context.Background(), requester, cancelled.ID)
	if err != nil || cancelled.ApprovalStatus != Cancelled || cancelled.OperationID != nil {
		t.Fatalf("CancelRollback() = %+v, %v", cancelled, err)
	}

	rejected := create(strings.Repeat("1", 64))
	rejected, err = fixture.service.RejectRollback(context.Background(), approver, rejected.ID)
	if err != nil || rejected.ApprovalStatus != Rejected || rejected.OperationID != nil {
		t.Fatalf("RejectRollback() = %+v, %v", rejected, err)
	}
	var outboxCount int
	if err := postgres.QueryRow(context.Background(), `SELECT count(*) FROM admin_outbox`).Scan(&outboxCount); err != nil || outboxCount != 0 {
		t.Fatalf("terminal rollback Outbox count/error = %d/%v", outboxCount, err)
	}
}

type officialCloudStub struct {
	cloudadmin.DisabledClient
	readErr     error
	definitions cloudadmin.Page[cloudadmin.OfficialDefinition]
	draft       cloudadmin.OfficialDraft
	submission  cloudadmin.OfficialSubmission
	release     cloudadmin.OfficialRelease
	version     cloudadmin.OfficialVersion
}

func (stub *officialCloudStub) ListOfficialDefinitions(context.Context, cloudadmin.ActorContext, cloudadmin.PageRequest) (cloudadmin.Page[cloudadmin.OfficialDefinition], error) {
	return stub.definitions, stub.readErr
}

func (stub *officialCloudStub) GetOfficialDraft(context.Context, cloudadmin.ActorContext, uuid.UUID) (cloudadmin.OfficialDraft, error) {
	if stub.readErr != nil {
		return cloudadmin.OfficialDraft{}, stub.readErr
	}
	return stub.draft, nil
}

func (stub *officialCloudStub) GetOfficialSubmission(context.Context, cloudadmin.ActorContext, uuid.UUID) (cloudadmin.OfficialSubmission, error) {
	if stub.readErr != nil {
		return cloudadmin.OfficialSubmission{}, stub.readErr
	}
	return stub.submission, nil
}

func (stub *officialCloudStub) GetOfficialRelease(context.Context, cloudadmin.ActorContext, uuid.UUID) (cloudadmin.OfficialReleaseDetail, error) {
	if stub.readErr != nil {
		return cloudadmin.OfficialRelease{}, stub.readErr
	}
	return stub.release, nil
}

func (stub *officialCloudStub) GetOfficialVersion(context.Context, cloudadmin.ActorContext, uuid.UUID) (cloudadmin.OfficialVersion, error) {
	if stub.readErr != nil {
		return cloudadmin.OfficialVersion{}, stub.readErr
	}
	return stub.version, nil
}

func (stub *officialCloudStub) ExecuteOfficialCommand(_ context.Context, actor cloudadmin.ActorContext, _ cloudadmin.OfficialCommand) (cloudadmin.Operation, error) {
	if actor.OperationID == nil {
		return cloudadmin.Operation{}, cloudadmin.ErrContractViolation
	}
	return cloudadmin.Operation{
		ID: *actor.OperationID, Status: cloudadmin.OperationSucceeded,
		UpdatedAt: time.Date(2026, 7, 22, 8, 0, 1, 0, time.UTC),
	}, nil
}

type reasonValidatorStub struct{ err error }

func (stub reasonValidatorStub) ValidateReason(context.Context, settings.ReasonUsage, string) error {
	return stub.err
}

type officialServiceFixture struct {
	service          *Service
	operationService *operations.Service
	cloud            *officialCloudStub
	now              time.Time
	postgres         *pgxpool.Pool
}

func newOfficialServiceFixture(t *testing.T, postgres *pgxpool.Pool) *officialServiceFixture {
	t.Helper()
	fixture := &officialServiceFixture{
		cloud: &officialCloudStub{definitions: cloudadmin.Page[cloudadmin.OfficialDefinition]{Items: []cloudadmin.OfficialDefinition{}}},
		now:   time.Date(2026, 7, 22, 8, 0, 0, 0, time.UTC), postgres: postgres,
	}
	recorder, err := audit.NewService(postgres)
	if err != nil {
		t.Fatal(err)
	}
	operationService, err := operations.NewService(operations.ServiceConfig{
		PostgreSQL: postgres, HMACKey: bytes.Repeat([]byte{9}, 32), Cloud: fixture.cloud,
		Audit: recorder, Clock: fixture.clock,
	})
	if err != nil {
		t.Fatal(err)
	}
	fixture.operationService = operationService
	fixture.service, err = NewService(ServiceConfig{
		PostgreSQL: postgres, Cloud: fixture.cloud, Operations: operationService,
		Audit: recorder, Reasons: reasonValidatorStub{}, Clock: fixture.clock,
	})
	if err != nil {
		t.Fatal(err)
	}
	return fixture
}

func (fixture *officialServiceFixture) clock() time.Time { return fixture.now }

func (fixture *officialServiceFixture) seedActor(t *testing.T, role rbac.Role) admin.Actor {
	t.Helper()
	id := uuid.New()
	_, err := fixture.postgres.Exec(context.Background(), `
		INSERT INTO admin_users (id, display_name, role, status, security_version, created_at, updated_at)
		VALUES ($1, 'Official Agent Test Actor', $2, 'active', 1, now(), now())
	`, id, role)
	if err != nil {
		t.Fatal(err)
	}
	return admin.Actor{AdminID: id, Role: role, Meta: admin.RequestMeta{RequestID: "req-official-agent", UserAgent: "official-agent-test"}}
}

func officialReason(actor admin.Actor, code string) admin.ActionReason {
	return admin.ActionReason{Code: code, TicketReference: "SEC-42", Note: "approved official operation", Meta: actor.Meta}
}

func officialDraftUpdatePayload(t *testing.T, baseVersionID uuid.UUID) json.RawMessage {
	t.Helper()
	content := "# Approved knowledge"
	digest := sha256.Sum256([]byte(content))
	payload := operations.OfficialDraftUpdatePayload{
		BaseVersionID: baseVersionID.String(), Kind: "next", DisplayName: "Official Research v2",
		Manifest: operations.OfficialAgentManifestPayload{
			SchemaVersion: 1, Identity: operations.OfficialAgentIdentityPayload{SystemPrompt: "You are approved."},
			Assets: []operations.OfficialAgentManifestAssetPayload{{
				Path: "knowledge/intro.md", Kind: "knowledge", MediaType: "text/markdown", SHA256: hex.EncodeToString(digest[:]),
			}},
			ModelConstraints:     operations.OfficialAgentModelConstraintsPayload{AllowedProviders: []string{"openai"}, AllowedModels: []string{"gpt-5"}},
			Tools:                operations.OfficialAgentToolPolicyPayload{Allowed: []string{}, Denied: []string{}},
			Dependencies:         []operations.OfficialAgentDependencyPayload{},
			RuntimeCompatibility: operations.OfficialAgentRuntimeCompatibilityPayload{MinimumVersion: "v0.18.0"},
		},
		Bundle: operations.OfficialAgentBundlePayload{Assets: []operations.OfficialAgentBundleAssetPayload{{Path: "knowledge/intro.md", Content: content}}},
	}
	encoded, err := json.Marshal(payload)
	if err != nil {
		t.Fatal(err)
	}
	return encoded
}
