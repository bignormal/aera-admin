package operations

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/bignormal/aera-admin/internal/admin"
	"github.com/bignormal/aera-admin/internal/audit"
	"github.com/bignormal/aera-admin/internal/rbac"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

var (
	ErrInvalidRequest          = errors.New("operation request is invalid")
	ErrPermissionDenied        = errors.New("operation permission is denied")
	ErrIdempotencyKeyReused    = errors.New("idempotency key was reused for another request")
	ErrOperationNotFound       = errors.New("operation was not found")
	ErrCloudUnavailable        = errors.New("Cloud administration is unavailable")
	ErrStateConflict           = errors.New("operation state changed")
	ErrExecutionTargetNotFound = errors.New("operation execution target was not found")
)

var (
	idempotencyKeyPattern     = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$`)
	operationErrorCodePattern = regexp.MustCompile(`^[A-Z][A-Z0-9_]{2,99}$`)
	reasonCodePattern         = regexp.MustCompile(`^[a-z][a-z0-9_]{2,63}$`)
)

type Action string

const (
	RevokeDevice       Action = "revoke_device"
	RevokeSession      Action = "revoke_session"
	RevokeAllSessions  Action = "revoke_all_sessions"
	DisableUser        Action = "disable_user"
	EnableUser         Action = "enable_user"
	ForcePasswordReset Action = "force_password_reset"

	OfficialDefinitionReserve  Action = "official_definition_reserve"
	OfficialDraftCreate        Action = "official_draft_create"
	OfficialDraftUpdate        Action = "official_draft_update"
	OfficialDraftSubmit        Action = "official_draft_submit"
	OfficialSubmissionWithdraw Action = "official_submission_withdraw"
	OfficialSubmissionReview   Action = "official_submission_review"
	OfficialReleaseActivate    Action = "official_release_activate"
	OfficialReleaseRollout     Action = "official_release_rollout"
	OfficialReleasePause       Action = "official_release_pause"
	OfficialReleaseResume      Action = "official_release_resume"
	OfficialReleaseRollback    Action = "official_release_rollback"
)

type State string

const (
	StateQueued      State = "queued"
	StateExecuting   State = "executing"
	StateReconciling State = "reconciling"
	StateSucceeded   State = "succeeded"
	StateFailed      State = "failed"
	StateConflict    State = "conflict"
)

type EnqueueRequest struct {
	Actor                     admin.Actor
	Action                    Action
	TargetID                  uuid.UUID
	ExpectedRevision          int64
	Payload                   json.RawMessage
	Reason                    admin.ActionReason
	BrowserIdempotencyKey     string
	ApprovalID                *uuid.UUID
	OfficialRollbackRequestID *uuid.UUID
}

type Result struct {
	OperationID uuid.UUID `json:"operation_id"`
	State       State     `json:"state"`
	ErrorCode   string    `json:"error_code,omitempty"`
	UpdatedAt   time.Time `json:"updated_at"`
}

type Job struct {
	OperationID               uuid.UUID
	Action                    Action
	TargetID                  uuid.UUID
	ApprovalID                *uuid.UUID
	OfficialRollbackRequestID *uuid.UUID
	ActorAdminID              uuid.UUID
	ActorRole                 rbac.Role
	ExpectedRevision          int64
	Payload                   json.RawMessage
	PayloadDigest             [sha256.Size]byte
	ReasonCode                string
	TicketReference           string
	Note                      string
	RequestID                 string
	Attempts                  int
	State                     State
}

type ExecutionSink interface {
	ApplyExecutionTx(context.Context, pgx.Tx, uuid.UUID, State, string, string, time.Time) error
}

func (request EnqueueRequest) validate() error {
	if request.Actor.AdminID == uuid.Nil || !request.Actor.Role.Valid() || !request.Action.Valid() ||
		request.TargetID == uuid.Nil || request.ExpectedRevision <= 0 ||
		!idempotencyKeyPattern.MatchString(request.BrowserIdempotencyKey) ||
		!reasonCodePattern.MatchString(request.Reason.Code) || request.Reason.Meta.RequestID == "" ||
		len(request.Reason.Meta.RequestID) > 128 || len(request.Reason.Meta.SourceIPHMAC) != 0 && len(request.Reason.Meta.SourceIPHMAC) != 32 ||
		audit.ContainsSensitiveText(request.Reason.TicketReference) || audit.ContainsSensitiveText(request.Reason.Note) {
		return ErrInvalidRequest
	}
	if (request.ApprovalID != nil && *request.ApprovalID == uuid.Nil) ||
		(request.OfficialRollbackRequestID != nil && *request.OfficialRollbackRequestID == uuid.Nil) ||
		(request.ApprovalID != nil && request.OfficialRollbackRequestID != nil) ||
		(request.Action == OfficialReleaseRollback) != (request.OfficialRollbackRequestID != nil) ||
		(request.ApprovalID != nil && request.Action != DisableUser && request.Action != EnableUser) {
		return ErrInvalidRequest
	}
	return nil
}

func (action Action) Valid() bool {
	switch action {
	case RevokeDevice, RevokeSession, DisableUser, EnableUser,
		OfficialDefinitionReserve, OfficialDraftCreate, OfficialDraftUpdate,
		OfficialDraftSubmit, OfficialSubmissionWithdraw, OfficialSubmissionReview,
		OfficialReleaseActivate, OfficialReleaseRollout, OfficialReleasePause,
		OfficialReleaseResume, OfficialReleaseRollback, RevokeAllSessions, ForcePasswordReset:
		return true
	default:
		return false
	}
}

func permissionFor(action Action) rbac.Permission {
	switch action {
	case RevokeDevice:
		return rbac.RevokeCloudDevice
	case RevokeSession:
		return rbac.RevokeCloudSession
	case RevokeAllSessions:
		return rbac.RevokeCloudSession
	case ForcePasswordReset:
		return rbac.InitiateAccountLifecycle
	case DisableUser, EnableUser:
		return rbac.ApproveAccountLifecycle
	case OfficialDefinitionReserve, OfficialDraftCreate, OfficialDraftUpdate,
		OfficialDraftSubmit, OfficialSubmissionWithdraw:
		return rbac.ManageOfficialDrafts
	case OfficialSubmissionReview:
		return rbac.ReviewOfficialAgents
	case OfficialReleaseActivate, OfficialReleaseRollout, OfficialReleasePause, OfficialReleaseResume:
		return rbac.ManageOfficialReleases
	case OfficialReleaseRollback:
		return rbac.ApproveOfficialRollback
	default:
		return rbac.Permission("")
	}
}

func requestDigest(request EnqueueRequest, payloadDigest [sha256.Size]byte) [sha256.Size]byte {
	approvalKind, approvalID := "", ""
	if request.ApprovalID != nil {
		approvalKind = "account_lifecycle"
		approvalID = request.ApprovalID.String()
	} else if request.OfficialRollbackRequestID != nil {
		approvalKind = "official_agent_rollback"
		approvalID = request.OfficialRollbackRequestID.String()
	}
	canonical := strings.Join([]string{
		string(request.Action), request.TargetID.String(), strconv.FormatInt(request.ExpectedRevision, 10),
		request.Reason.Code, request.Reason.TicketReference, request.Reason.Note, approvalKind, approvalID,
		hex.EncodeToString(payloadDigest[:]),
	}, "\x00")
	return sha256.Sum256([]byte(canonical))
}

func (request EnqueueRequest) approvalReference() *uuid.UUID {
	if request.ApprovalID != nil {
		return request.ApprovalID
	}
	return request.OfficialRollbackRequestID
}

func (job Job) approvalReference() *uuid.UUID {
	if job.ApprovalID != nil {
		return job.ApprovalID
	}
	return job.OfficialRollbackRequestID
}

func (state State) valid() bool {
	return state == StateQueued || state == StateExecuting || state == StateReconciling ||
		state == StateSucceeded || state == StateFailed || state == StateConflict
}
