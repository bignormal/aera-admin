package officialagent

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"time"

	"github.com/bignormal/aera-admin/internal/admin"
	"github.com/bignormal/aera-admin/internal/audit"
	"github.com/bignormal/aera-admin/internal/cloudadmin"
	"github.com/bignormal/aera-admin/internal/operations"
	"github.com/bignormal/aera-admin/internal/rbac"
	"github.com/bignormal/aera-admin/internal/settings"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

const rollbackApprovalLifetime = 24 * time.Hour

type ReasonValidator interface {
	ValidateReason(context.Context, settings.ReasonUsage, string) error
}

type ServiceConfig struct {
	PostgreSQL *pgxpool.Pool
	Cloud      cloudadmin.Client
	Operations operations.TransactionalEnqueuer
	Audit      *audit.Service
	Reasons    ReasonValidator
	Clock      func() time.Time
}

type Service struct {
	repository *repository
	cloud      cloudadmin.Client
	operations operations.TransactionalEnqueuer
	audit      *audit.Service
	reasons    ReasonValidator
	clock      func() time.Time
}

func NewService(config ServiceConfig) (*Service, error) {
	if config.PostgreSQL == nil || config.Cloud == nil || config.Operations == nil || config.Audit == nil ||
		config.Reasons == nil || config.Clock == nil {
		return nil, errors.New("official Agent service dependencies are required")
	}
	return &Service{
		repository: &repository{postgres: config.PostgreSQL}, cloud: config.Cloud,
		operations: config.Operations, audit: config.Audit, reasons: config.Reasons, clock: config.Clock,
	}, nil
}

func officialActor(actor admin.Actor) cloudadmin.ActorContext {
	return cloudadmin.ActorContext{AdminID: actor.AdminID, Role: actor.Role}
}

func validReadActor(actor admin.Actor, permission rbac.Permission) bool {
	return actor.AdminID != uuid.Nil && actor.Role.Valid() && rbac.Allowed(actor.Role, permission)
}

func (service *Service) ListDefinitions(ctx context.Context, actor admin.Actor, page cloudadmin.PageRequest) (cloudadmin.Page[cloudadmin.OfficialDefinition], error) {
	if service == nil || service.cloud == nil {
		return cloudadmin.Page[cloudadmin.OfficialDefinition]{}, cloudadmin.ErrUnavailable
	}
	if !validReadActor(actor, rbac.ReadOfficialAgents) {
		return cloudadmin.Page[cloudadmin.OfficialDefinition]{}, ErrPermissionDenied
	}
	result, err := service.cloud.ListOfficialDefinitions(ctx, officialActor(actor), page)
	return result, mapCloudError(err)
}

func (service *Service) GetDefinition(ctx context.Context, actor admin.Actor, id uuid.UUID) (cloudadmin.OfficialDefinitionDetail, error) {
	if service == nil || service.cloud == nil {
		return cloudadmin.OfficialDefinitionDetail{}, cloudadmin.ErrUnavailable
	}
	if !validReadActor(actor, rbac.ReadOfficialAgents) {
		return cloudadmin.OfficialDefinitionDetail{}, ErrPermissionDenied
	}
	if id == uuid.Nil {
		return cloudadmin.OfficialDefinitionDetail{}, ErrInvalidRequest
	}
	result, err := service.cloud.GetOfficialDefinition(ctx, officialActor(actor), id)
	return result, mapCloudError(err)
}

func (service *Service) ListDrafts(ctx context.Context, actor admin.Actor, page cloudadmin.PageRequest) (cloudadmin.Page[cloudadmin.OfficialDraft], error) {
	if service == nil || service.cloud == nil {
		return cloudadmin.Page[cloudadmin.OfficialDraft]{}, cloudadmin.ErrUnavailable
	}
	if !validReadActor(actor, rbac.ReadOfficialAgents) {
		return cloudadmin.Page[cloudadmin.OfficialDraft]{}, ErrPermissionDenied
	}
	result, err := service.cloud.ListOfficialDrafts(ctx, officialActor(actor), page)
	return result, mapCloudError(err)
}

func (service *Service) GetDraft(ctx context.Context, actor admin.Actor, id uuid.UUID) (cloudadmin.OfficialDraft, error) {
	if service == nil || service.cloud == nil {
		return cloudadmin.OfficialDraft{}, cloudadmin.ErrUnavailable
	}
	if !validReadActor(actor, rbac.ReadOfficialAgents) {
		return cloudadmin.OfficialDraft{}, ErrPermissionDenied
	}
	if id == uuid.Nil {
		return cloudadmin.OfficialDraft{}, ErrInvalidRequest
	}
	result, err := service.cloud.GetOfficialDraft(ctx, officialActor(actor), id)
	return result, mapCloudError(err)
}

func (service *Service) ValidateDraft(ctx context.Context, actor admin.Actor, id uuid.UUID) (cloudadmin.OfficialDraftValidation, error) {
	if service == nil || service.cloud == nil {
		return cloudadmin.OfficialDraftValidation{}, cloudadmin.ErrUnavailable
	}
	if !validReadActor(actor, rbac.ManageOfficialDrafts) {
		return cloudadmin.OfficialDraftValidation{}, ErrPermissionDenied
	}
	if id == uuid.Nil {
		return cloudadmin.OfficialDraftValidation{}, ErrInvalidRequest
	}
	result, err := service.cloud.ValidateOfficialDraft(ctx, officialActor(actor), id)
	return result, mapCloudError(err)
}

func (service *Service) ListSubmissions(ctx context.Context, actor admin.Actor, filter cloudadmin.OfficialSubmissionFilter) (cloudadmin.Page[cloudadmin.OfficialSubmission], error) {
	if service == nil || service.cloud == nil {
		return cloudadmin.Page[cloudadmin.OfficialSubmission]{}, cloudadmin.ErrUnavailable
	}
	if !validReadActor(actor, rbac.ReadOfficialAgents) {
		return cloudadmin.Page[cloudadmin.OfficialSubmission]{}, ErrPermissionDenied
	}
	result, err := service.cloud.ListOfficialSubmissions(ctx, officialActor(actor), filter)
	return result, mapCloudError(err)
}

func (service *Service) GetSubmission(ctx context.Context, actor admin.Actor, id uuid.UUID) (cloudadmin.OfficialSubmission, error) {
	if service == nil || service.cloud == nil {
		return cloudadmin.OfficialSubmission{}, cloudadmin.ErrUnavailable
	}
	if !validReadActor(actor, rbac.ReadOfficialAgents) {
		return cloudadmin.OfficialSubmission{}, ErrPermissionDenied
	}
	if id == uuid.Nil {
		return cloudadmin.OfficialSubmission{}, ErrInvalidRequest
	}
	result, err := service.cloud.GetOfficialSubmission(ctx, officialActor(actor), id)
	return result, mapCloudError(err)
}

func (service *Service) ListVersions(ctx context.Context, actor admin.Actor, page cloudadmin.PageRequest) (cloudadmin.Page[cloudadmin.OfficialVersion], error) {
	if service == nil || service.cloud == nil {
		return cloudadmin.Page[cloudadmin.OfficialVersion]{}, cloudadmin.ErrUnavailable
	}
	if !validReadActor(actor, rbac.ReadOfficialAgents) {
		return cloudadmin.Page[cloudadmin.OfficialVersion]{}, ErrPermissionDenied
	}
	result, err := service.cloud.ListOfficialVersions(ctx, officialActor(actor), page)
	return result, mapCloudError(err)
}

func (service *Service) ListReleases(ctx context.Context, actor admin.Actor, page cloudadmin.PageRequest) (cloudadmin.Page[cloudadmin.OfficialRelease], error) {
	if service == nil || service.cloud == nil {
		return cloudadmin.Page[cloudadmin.OfficialRelease]{}, cloudadmin.ErrUnavailable
	}
	if !validReadActor(actor, rbac.ReadOfficialAgents) {
		return cloudadmin.Page[cloudadmin.OfficialRelease]{}, ErrPermissionDenied
	}
	result, err := service.cloud.ListOfficialReleases(ctx, officialActor(actor), page)
	return result, mapCloudError(err)
}

func (service *Service) GetRelease(ctx context.Context, actor admin.Actor, id uuid.UUID) (cloudadmin.OfficialReleaseDetail, error) {
	if service == nil || service.cloud == nil {
		return cloudadmin.OfficialReleaseDetail{}, cloudadmin.ErrUnavailable
	}
	if !validReadActor(actor, rbac.ReadOfficialAgents) {
		return cloudadmin.OfficialReleaseDetail{}, ErrPermissionDenied
	}
	if id == uuid.Nil {
		return cloudadmin.OfficialReleaseDetail{}, ErrInvalidRequest
	}
	result, err := service.cloud.GetOfficialRelease(ctx, officialActor(actor), id)
	return result, mapCloudError(err)
}

func (service *Service) ListAudit(ctx context.Context, actor admin.Actor, page cloudadmin.PageRequest) (cloudadmin.Page[cloudadmin.OfficialAuditEvent], error) {
	if service == nil || service.cloud == nil {
		return cloudadmin.Page[cloudadmin.OfficialAuditEvent]{}, cloudadmin.ErrUnavailable
	}
	if !validReadActor(actor, rbac.ReadOfficialAgentAudit) {
		return cloudadmin.Page[cloudadmin.OfficialAuditEvent]{}, ErrPermissionDenied
	}
	result, err := service.cloud.ListOfficialAudit(ctx, officialActor(actor), page)
	return result, mapCloudError(err)
}

func (service *Service) ListRollbacks(ctx context.Context, actor admin.Actor, filter ListFilter) (RollbackPage, error) {
	if service == nil || service.repository == nil {
		return RollbackPage{}, errors.New("official Agent service is unavailable")
	}
	return service.repository.ListRollbacks(ctx, actor, filter)
}

func (service *Service) Enqueue(ctx context.Context, actor admin.Actor, request MutationRequest) (operations.Result, error) {
	if service == nil || service.repository == nil || service.operations == nil {
		return operations.Result{}, errors.New("official Agent service is unavailable")
	}
	if err := request.validate(actor); err != nil {
		return operations.Result{}, err
	}
	if err := service.reasons.ValidateReason(ctx, settings.UsageOfficialAgent, request.Reason.Code); err != nil {
		return operations.Result{}, err
	}
	if err := service.validateMutationTarget(ctx, actor, request); err != nil {
		return operations.Result{}, err
	}
	tx, err := service.repository.begin(ctx)
	if err != nil {
		return operations.Result{}, err
	}
	defer func() { _ = tx.Rollback(context.Background()) }()
	result, err := service.operations.EnqueueTx(ctx, tx, operations.EnqueueRequest{
		Actor: actor, Action: request.Action, TargetID: request.TargetID,
		ExpectedRevision: request.ExpectedRevision, Payload: append(json.RawMessage(nil), request.Payload...),
		Reason: request.Reason, BrowserIdempotencyKey: request.BrowserIdempotencyKey,
	})
	if err != nil {
		return operations.Result{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return operations.Result{}, errors.New("official Agent operation could not be committed")
	}
	return result, nil
}

func (service *Service) validateMutationTarget(ctx context.Context, actor admin.Actor, request MutationRequest) error {
	cloudActor := officialActor(actor)
	switch request.Action {
	case operations.OfficialDefinitionReserve, operations.OfficialDraftCreate:
		if request.ExpectedRevision != 1 || request.ExpectedTargetDigest != "" {
			return ErrInvalidRequest
		}
		return nil
	case operations.OfficialDraftUpdate, operations.OfficialDraftSubmit:
		draft, err := service.cloud.GetOfficialDraft(ctx, cloudActor, request.TargetID)
		if err != nil {
			return mapCloudError(err)
		}
		if draft.ID != request.TargetID || draft.Revision != request.ExpectedRevision {
			return ErrStateConflict
		}
		if request.ExpectedTargetDigest == "" || draft.ContentDigest != request.ExpectedTargetDigest {
			return ErrTargetDigestMismatch
		}
		return nil
	case operations.OfficialSubmissionWithdraw, operations.OfficialSubmissionReview:
		submission, err := service.cloud.GetOfficialSubmission(ctx, cloudActor, request.TargetID)
		if err != nil {
			return mapCloudError(err)
		}
		if submission.ID != request.TargetID || submission.Revision != request.ExpectedRevision {
			return ErrStateConflict
		}
		if request.ExpectedTargetDigest == "" || submission.ContentDigest != request.ExpectedTargetDigest {
			return ErrTargetDigestMismatch
		}
		if request.Action == operations.OfficialSubmissionReview && submission.SubmittedByAdminID == actor.AdminID {
			return ErrSelfReview
		}
		return nil
	case operations.OfficialReleaseActivate, operations.OfficialReleaseRollout,
		operations.OfficialReleasePause, operations.OfficialReleaseResume:
		release, err := service.cloud.GetOfficialRelease(ctx, cloudActor, request.TargetID)
		if err != nil {
			return mapCloudError(err)
		}
		if release.ID != request.TargetID || release.HeadRevision != request.ExpectedRevision {
			return ErrStateConflict
		}
		versionID := release.AgentVersionID
		if request.Action == operations.OfficialReleaseActivate {
			var payload operations.OfficialReleaseActivatePayload
			if decodeStrict(request.Payload, &payload) != nil {
				return ErrInvalidRequest
			}
			parsed, parseErr := uuid.Parse(payload.VersionID)
			if parseErr != nil || parsed == uuid.Nil || parsed.String() != payload.VersionID {
				return ErrInvalidRequest
			}
			versionID = parsed
		}
		version, err := service.cloud.GetOfficialVersion(ctx, cloudActor, versionID)
		if err != nil {
			return mapCloudError(err)
		}
		if version.ID != versionID || version.DefinitionID != release.DefinitionID {
			return ErrStateConflict
		}
		if request.ExpectedTargetDigest == "" || version.ContentDigest != request.ExpectedTargetDigest {
			return ErrTargetDigestMismatch
		}
		return nil
	default:
		return ErrInvalidRequest
	}
}

func decodeStrict(raw []byte, target any) error {
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(target); err != nil {
		return err
	}
	if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		return ErrInvalidRequest
	}
	return nil
}

func mapCloudError(err error) error {
	if err == nil {
		return nil
	}
	switch {
	case errors.Is(err, cloudadmin.ErrNotConfigured), errors.Is(err, cloudadmin.ErrUnavailable),
		errors.Is(err, cloudadmin.ErrContractViolation), errors.Is(err, cloudadmin.ErrPermissionDenied),
		errors.Is(err, cloudadmin.ErrPublicationDLPBlocked), errors.Is(err, cloudadmin.ErrNotFound),
		errors.Is(err, cloudadmin.ErrConflict):
		return err
	default:
		return cloudadmin.ErrUnavailable
	}
}

func (service *Service) RequestRollback(ctx context.Context, actor admin.Actor, request RollbackRequest) (RollbackApproval, error) {
	if service == nil || service.repository == nil {
		return RollbackApproval{}, errors.New("official Agent service is unavailable")
	}
	if err := request.validate(actor); err != nil {
		return RollbackApproval{}, err
	}
	if err := service.reasons.ValidateReason(ctx, settings.UsageOfficialAgent, request.Reason.Code); err != nil {
		return RollbackApproval{}, err
	}
	release, version, err := service.loadRollbackTargets(ctx, actor, request.ReleaseID, request.TargetVersionID)
	if err != nil {
		return RollbackApproval{}, err
	}
	if release.HeadRevision != request.ExpectedHeadRevision || request.TargetReleaseRevisionID == release.CurrentRevisionID {
		return RollbackApproval{}, ErrStateConflict
	}
	if version.ContentDigest != request.TargetDigest {
		return RollbackApproval{}, ErrTargetDigestMismatch
	}
	now := service.clock().UTC()
	id, err := uuid.NewRandom()
	if err != nil {
		return RollbackApproval{}, errors.New("official Agent rollback identifier could not be generated")
	}
	approval := RollbackApproval{
		ID: id, ReleaseID: request.ReleaseID, TargetVersionID: request.TargetVersionID,
		TargetReleaseRevisionID: request.TargetReleaseRevisionID, ExpectedHeadRevision: request.ExpectedHeadRevision,
		TargetDigest: request.TargetDigest, RequestedByAdminID: actor.AdminID,
		ReasonCode: request.Reason.Code, TicketReference: request.Reason.TicketReference, SafeNote: request.Reason.Note,
		ApprovalStatus: PendingReview, ExecutionStatus: NotStarted,
		ExpiresAt: now.Add(rollbackApprovalLifetime), CreatedAt: now, UpdatedAt: now, Version: 1,
	}
	return service.repository.insertRollbackWithAudit(ctx, approval, actor, request.Reason, service.audit)
}

func (service *Service) loadRollbackTargets(ctx context.Context, actor admin.Actor, releaseID, versionID uuid.UUID) (cloudadmin.OfficialRelease, cloudadmin.OfficialVersion, error) {
	release, err := service.cloud.GetOfficialRelease(ctx, officialActor(actor), releaseID)
	if err != nil {
		return cloudadmin.OfficialRelease{}, cloudadmin.OfficialVersion{}, mapCloudError(err)
	}
	version, err := service.cloud.GetOfficialVersion(ctx, officialActor(actor), versionID)
	if err != nil {
		return cloudadmin.OfficialRelease{}, cloudadmin.OfficialVersion{}, mapCloudError(err)
	}
	if release.ID != releaseID || version.ID != versionID || release.DefinitionID == uuid.Nil ||
		version.DefinitionID != release.DefinitionID || !digestPattern.MatchString(version.ContentDigest) {
		return cloudadmin.OfficialRelease{}, cloudadmin.OfficialVersion{}, ErrStateConflict
	}
	return release, version, nil
}

func (service *Service) ApproveRollback(ctx context.Context, actor admin.Actor, id uuid.UUID, idempotencyKey string) (RollbackApproval, error) {
	if service == nil || service.repository == nil {
		return RollbackApproval{}, errors.New("official Agent service is unavailable")
	}
	tx, err := service.repository.begin(ctx)
	if err != nil {
		return RollbackApproval{}, err
	}
	defer func() { _ = tx.Rollback(context.Background()) }()
	approval, err := lockRollback(ctx, tx, id)
	if err != nil {
		return RollbackApproval{}, err
	}
	now := service.clock().UTC()
	if err := approval.CanReview(actor, now); err != nil {
		if errors.Is(err, ErrExpired) {
			if persistErr := service.expireRollbackTx(ctx, tx, approval, actor, now); persistErr != nil {
				return RollbackApproval{}, persistErr
			}
			if commitErr := tx.Commit(ctx); commitErr != nil {
				return RollbackApproval{}, errors.New("official Agent rollback expiry could not be committed")
			}
		}
		return RollbackApproval{}, err
	}
	release, version, err := service.loadRollbackTargets(ctx, actor, approval.ReleaseID, approval.TargetVersionID)
	if err != nil {
		return RollbackApproval{}, err
	}
	if release.HeadRevision != approval.ExpectedHeadRevision {
		return RollbackApproval{}, ErrStateConflict
	}
	if version.ContentDigest != approval.TargetDigest {
		return RollbackApproval{}, ErrTargetDigestMismatch
	}
	payload, err := json.Marshal(operations.OfficialReleaseRollbackPayload{
		TargetVersionID:         approval.TargetVersionID.String(),
		TargetReleaseRevisionID: approval.TargetReleaseRevisionID.String(),
		RequesterAdminID:        approval.RequestedByAdminID.String(),
	})
	if err != nil {
		return RollbackApproval{}, ErrInvalidRequest
	}
	result, err := service.operations.EnqueueTx(ctx, tx, operations.EnqueueRequest{
		Actor: actor, Action: operations.OfficialReleaseRollback, TargetID: approval.ReleaseID,
		ExpectedRevision: approval.ExpectedHeadRevision, Payload: payload,
		Reason: admin.ActionReason{
			Code: approval.ReasonCode, TicketReference: approval.TicketReference,
			Note: approval.SafeNote, Meta: actor.Meta,
		},
		BrowserIdempotencyKey: idempotencyKey, OfficialRollbackRequestID: &approval.ID,
	})
	if err != nil {
		return RollbackApproval{}, err
	}
	command, err := tx.Exec(ctx, `
		UPDATE official_agent_rollback_requests
		SET approval_status = 'approved', execution_status = 'queued',
			reviewed_by_admin_id = $2, reviewed_at = $3, operation_id = $4,
			updated_at = $3, version = version + 1
		WHERE id = $1 AND version = $5 AND approval_status = 'pending_review'
	`, approval.ID, actor.AdminID, now, result.OperationID, approval.Version)
	if err != nil || command.RowsAffected() != 1 {
		return RollbackApproval{}, ErrStateConflict
	}
	approval.ApprovalStatus, approval.ExecutionStatus = Approved, Queued
	approval.ReviewedByAdminID, approval.ReviewedAt, approval.OperationID = &actor.AdminID, &now, &result.OperationID
	if err := insertRollbackEvent(ctx, tx, approval, "approved", actor, "", now); err != nil {
		return RollbackApproval{}, err
	}
	if err := insertRollbackEvent(ctx, tx, approval, "queued", actor, "", now.Add(time.Microsecond)); err != nil {
		return RollbackApproval{}, err
	}
	if _, err := service.audit.AppendTx(ctx, tx, audit.Record{
		ActorAdminID: &actor.AdminID, ActorRole: actor.Role,
		EventType: "official_release_rollback_approved", ObjectType: "official_release",
		ObjectID: &approval.ReleaseID, Outcome: audit.OutcomeSuccess,
		ReasonCode: approval.ReasonCode, TicketReference: approval.TicketReference, Note: approval.SafeNote,
		ApprovalID: &approval.ID, OperationID: &result.OperationID,
		BeforeState: map[string]string{"approval_status": "pending_review", "execution_status": "not_started"},
		AfterState:  map[string]string{"approval_status": "approved", "execution_status": "queued"},
		RequestID:   actor.Meta.RequestID, SourceIPHMAC: actor.Meta.SourceIPHMAC, UserAgent: actor.Meta.UserAgent,
	}); err != nil {
		return RollbackApproval{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return RollbackApproval{}, errors.New("official Agent rollback approval could not be committed")
	}
	return service.GetRollback(ctx, actor, approval.ID)
}

func (service *Service) RejectRollback(ctx context.Context, actor admin.Actor, id uuid.UUID) (RollbackApproval, error) {
	return service.terminalRollback(ctx, actor, id, Rejected, "rejected")
}

func (service *Service) CancelRollback(ctx context.Context, actor admin.Actor, id uuid.UUID) (RollbackApproval, error) {
	return service.terminalRollback(ctx, actor, id, Cancelled, "cancelled")
}

func (service *Service) terminalRollback(ctx context.Context, actor admin.Actor, id uuid.UUID, status ApprovalStatus, eventType string) (RollbackApproval, error) {
	if service == nil || service.repository == nil || (status != Rejected && status != Cancelled) {
		return RollbackApproval{}, ErrInvalidRequest
	}
	tx, err := service.repository.begin(ctx)
	if err != nil {
		return RollbackApproval{}, err
	}
	defer func() { _ = tx.Rollback(context.Background()) }()
	approval, err := lockRollback(ctx, tx, id)
	if err != nil {
		return RollbackApproval{}, err
	}
	now := service.clock().UTC()
	if status == Rejected {
		err = approval.CanReview(actor, now)
	} else {
		err = approval.CanCancel(actor, now)
	}
	if err != nil {
		if errors.Is(err, ErrExpired) {
			if persistErr := service.expireRollbackTx(ctx, tx, approval, actor, now); persistErr != nil {
				return RollbackApproval{}, persistErr
			}
			if commitErr := tx.Commit(ctx); commitErr != nil {
				return RollbackApproval{}, errors.New("official Agent rollback expiry could not be committed")
			}
		}
		return RollbackApproval{}, err
	}
	setReview := status == Rejected
	command, err := tx.Exec(ctx, `
		UPDATE official_agent_rollback_requests
		SET approval_status = $2,
			reviewed_by_admin_id = CASE WHEN $3 THEN $4::uuid ELSE NULL::uuid END,
			reviewed_at = CASE WHEN $3 THEN $5::timestamptz ELSE NULL::timestamptz END,
			updated_at = $5, version = version + 1
		WHERE id = $1 AND version = $6 AND approval_status = 'pending_review'
	`, approval.ID, status, setReview, actor.AdminID, now, approval.Version)
	if err != nil || command.RowsAffected() != 1 {
		return RollbackApproval{}, ErrStateConflict
	}
	approval.ApprovalStatus = status
	if setReview {
		approval.ReviewedByAdminID, approval.ReviewedAt = &actor.AdminID, &now
	}
	if err := insertRollbackEvent(ctx, tx, approval, eventType, actor, "", now); err != nil {
		return RollbackApproval{}, err
	}
	if _, err := service.audit.AppendTx(ctx, tx, audit.Record{
		ActorAdminID: &actor.AdminID, ActorRole: actor.Role,
		EventType: "official_release_rollback_" + eventType, ObjectType: "official_release",
		ObjectID: &approval.ReleaseID, Outcome: audit.OutcomeSuccess,
		ReasonCode: approval.ReasonCode, TicketReference: approval.TicketReference, Note: approval.SafeNote,
		ApprovalID: &approval.ID, BeforeState: map[string]string{"approval_status": "pending_review"},
		AfterState: map[string]string{"approval_status": string(status)}, RequestID: actor.Meta.RequestID,
		SourceIPHMAC: actor.Meta.SourceIPHMAC, UserAgent: actor.Meta.UserAgent,
	}); err != nil {
		return RollbackApproval{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return RollbackApproval{}, errors.New("official Agent rollback terminal state could not be committed")
	}
	return service.GetRollback(ctx, actor, approval.ID)
}

func (service *Service) expireRollbackTx(ctx context.Context, tx pgx.Tx, approval RollbackApproval, actor admin.Actor, now time.Time) error {
	command, err := tx.Exec(ctx, `
		UPDATE official_agent_rollback_requests
		SET approval_status = 'expired', updated_at = $2, version = version + 1
		WHERE id = $1 AND version = $3 AND approval_status = 'pending_review'
	`, approval.ID, now, approval.Version)
	if err != nil || command.RowsAffected() != 1 {
		return ErrStateConflict
	}
	approval.ApprovalStatus = Expired
	if err := insertRollbackEvent(ctx, tx, approval, "expired", actor, "APPROVAL_EXPIRED", now); err != nil {
		return err
	}
	_, err = service.audit.AppendTx(ctx, tx, audit.Record{
		ActorAdminID: &actor.AdminID, ActorRole: actor.Role,
		EventType: "official_release_rollback_expired", ObjectType: "official_release",
		ObjectID: &approval.ReleaseID, Outcome: audit.OutcomeFailure, ErrorCode: "APPROVAL_EXPIRED",
		ApprovalID: &approval.ID, BeforeState: map[string]string{"approval_status": "pending_review"},
		AfterState: map[string]string{"approval_status": "expired"}, RequestID: actor.Meta.RequestID,
		SourceIPHMAC: actor.Meta.SourceIPHMAC, UserAgent: actor.Meta.UserAgent,
	})
	return err
}

func (service *Service) GetRollback(ctx context.Context, actor admin.Actor, id uuid.UUID) (RollbackApproval, error) {
	if service == nil || service.repository == nil {
		return RollbackApproval{}, errors.New("official Agent service is unavailable")
	}
	return service.repository.GetRollback(ctx, actor, id)
}

func rollbackExecutionTransitionAllowed(before ExecutionStatus, after operations.State) bool {
	switch before {
	case Queued:
		return after == operations.StateExecuting || after == operations.StateReconciling ||
			after == operations.StateSucceeded || after == operations.StateFailed || after == operations.StateConflict
	case Executing:
		return after == operations.StateQueued || after == operations.StateReconciling ||
			after == operations.StateSucceeded || after == operations.StateFailed || after == operations.StateConflict
	case Reconciling:
		return after == operations.StateQueued || after == operations.StateExecuting ||
			after == operations.StateSucceeded || after == operations.StateFailed || after == operations.StateConflict
	default:
		return false
	}
}

func (service *Service) ApplyExecutionTx(
	ctx context.Context,
	tx pgx.Tx,
	operationID uuid.UUID,
	next operations.State,
	errorCode string,
	requestID string,
	now time.Time,
) error {
	if service == nil || tx == nil || operationID == uuid.Nil {
		return ErrStateConflict
	}
	var approval RollbackApproval
	var reviewerID uuid.UUID
	var reviewerRole rbac.Role
	err := tx.QueryRow(ctx, `
		SELECT request.id, request.release_id, request.approval_status, request.execution_status,
			request.operation_id, request.reviewed_by_admin_id, request.version, administrator.role
		FROM official_agent_rollback_requests AS request
		JOIN admin_users AS administrator ON administrator.id = request.reviewed_by_admin_id
		WHERE request.operation_id = $1
		FOR UPDATE OF request
	`, operationID).Scan(
		&approval.ID, &approval.ReleaseID, &approval.ApprovalStatus, &approval.ExecutionStatus,
		&approval.OperationID, &reviewerID, &approval.Version, &reviewerRole,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return operations.ErrExecutionTargetNotFound
	}
	if err != nil || approval.ApprovalStatus != Approved || approval.OperationID == nil ||
		*approval.OperationID != operationID || reviewerID == uuid.Nil || reviewerRole != rbac.SuperAdmin ||
		!rollbackExecutionTransitionAllowed(approval.ExecutionStatus, next) {
		return ErrStateConflict
	}
	command, err := tx.Exec(ctx, `
		UPDATE official_agent_rollback_requests
		SET execution_status = $2, updated_at = $3, version = version + 1
		WHERE id = $1 AND version = $4 AND approval_status = 'approved' AND operation_id = $5
	`, approval.ID, next, now.UTC(), approval.Version, operationID)
	if err != nil || command.RowsAffected() != 1 {
		return ErrStateConflict
	}
	approval.ExecutionStatus = ExecutionStatus(next)
	return insertRollbackEvent(ctx, tx, approval, string(next), admin.Actor{
		AdminID: reviewerID, Role: reviewerRole, Meta: admin.RequestMeta{RequestID: requestID},
	}, errorCode, now.UTC())
}
