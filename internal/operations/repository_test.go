package operations

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/json"
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

func TestOfficialOutboxPersistsCanonicalPayloadAndRejectsSemanticReplay(t *testing.T) {
	postgres := testkit.Postgres(t)
	auditService, err := audit.NewService(postgres)
	if err != nil {
		t.Fatal(err)
	}
	actor := seedActor(t, postgres, rbac.Developer)
	repository, err := newRepository(postgres, bytes.Repeat([]byte{9}, 32), auditService, fixedClock)
	if err != nil {
		t.Fatal(err)
	}
	request := EnqueueRequest{
		Actor: actor, Action: OfficialDefinitionReserve, TargetID: uuid.New(), ExpectedRevision: 1,
		Payload:               json.RawMessage(`{ "display_name" : "Official Research" }`),
		BrowserIdempotencyKey: uuid.NewString(),
		Reason:                admin.ActionReason{Code: "official_content_review", Meta: actor.Meta},
	}
	first, err := repository.Enqueue(context.Background(), request)
	if err != nil {
		t.Fatal(err)
	}
	request.Payload = json.RawMessage(`{"display_name":"Official Research"}`)
	second, err := repository.Enqueue(context.Background(), request)
	if err != nil || second.OperationID != first.OperationID {
		t.Fatalf("semantic replay = %+v, %v", second, err)
	}
	canonical, digest, err := canonicalCommandPayload(request.Action, request.Payload)
	if err != nil {
		t.Fatal(err)
	}
	var idempotencyPayload, idempotencyDigest, outboxPayload, outboxDigest []byte
	if err := postgres.QueryRow(context.Background(), `
		SELECT identity.command_payload, identity.command_payload_digest,
		       outbox.command_payload, outbox.command_payload_digest
		FROM admin_idempotency_records identity
		JOIN admin_outbox outbox USING (operation_id)
		WHERE identity.operation_id = $1
	`, first.OperationID).Scan(&idempotencyPayload, &idempotencyDigest, &outboxPayload, &outboxDigest); err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(idempotencyPayload, canonical) || !bytes.Equal(outboxPayload, canonical) ||
		!bytes.Equal(idempotencyDigest, digest[:]) || !bytes.Equal(outboxDigest, digest[:]) ||
		sha256.Sum256(canonical) != digest {
		t.Fatalf("stored canonical payload/digest mismatch")
	}
	request.Payload = json.RawMessage(`{"display_name":"Other Official"}`)
	if _, err := repository.Enqueue(context.Background(), request); !errors.Is(err, ErrIdempotencyKeyReused) {
		t.Fatalf("different official payload replay error = %v", err)
	}
}

func TestOfficialRollbackOutboxUsesDedicatedApprovalReference(t *testing.T) {
	postgres := testkit.Postgres(t)
	recorder, err := audit.NewService(postgres)
	if err != nil {
		t.Fatal(err)
	}
	requester := seedActor(t, postgres, rbac.Operator)
	approver := seedActor(t, postgres, rbac.SuperAdmin)
	repository, err := newRepository(postgres, bytes.Repeat([]byte{9}, 32), recorder, fixedClock)
	if err != nil {
		t.Fatal(err)
	}
	approvalID, releaseID, versionID, revisionID := uuid.New(), uuid.New(), uuid.New(), uuid.New()
	_, err = postgres.Exec(context.Background(), `
		INSERT INTO official_agent_rollback_requests (
			id, release_id, target_version_id, target_release_revision_id,
			expected_head_revision, target_digest, requested_by_admin_id,
			reason_code, approval_status, execution_status, expires_at,
			created_at, updated_at, version
		) VALUES ($1, $2, $3, $4, 4, $5, $6, 'official_release_rollback',
			'pending_review', 'not_started', $7, $8, $8, 1)
	`, approvalID, releaseID, versionID, revisionID, bytes.Repeat([]byte{8}, 32), requester.AdminID,
		fixedClock().Add(time.Hour), fixedClock())
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
	result, err := repository.Enqueue(context.Background(), EnqueueRequest{
		Actor: approver, Action: OfficialReleaseRollback, TargetID: releaseID, ExpectedRevision: 4,
		Payload: payload, BrowserIdempotencyKey: uuid.NewString(), OfficialRollbackRequestID: &approvalID,
		Reason: admin.ActionReason{Code: "official_release_rollback", Meta: approver.Meta},
	})
	if err != nil {
		t.Fatal(err)
	}
	var accountApprovalID, officialApprovalID *uuid.UUID
	if err := postgres.QueryRow(context.Background(), `
		SELECT approval_id, official_rollback_request_id FROM admin_outbox WHERE operation_id = $1
	`, result.OperationID).Scan(&accountApprovalID, &officialApprovalID); err != nil {
		t.Fatal(err)
	}
	if accountApprovalID != nil || officialApprovalID == nil || *officialApprovalID != approvalID {
		t.Fatalf("approval references = account:%v official:%v", accountApprovalID, officialApprovalID)
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
