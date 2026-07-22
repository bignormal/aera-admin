package officialagent

import (
	"errors"
	"regexp"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/bignormal/aera-admin/internal/admin"
	"github.com/bignormal/aera-admin/internal/audit"
	"github.com/bignormal/aera-admin/internal/operations"
	"github.com/bignormal/aera-admin/internal/rbac"
	"github.com/google/uuid"
)

var (
	ErrInvalidRequest       = errors.New("official Agent request is invalid")
	ErrPermissionDenied     = errors.New("official Agent permission is denied")
	ErrSelfReview           = errors.New("official Agent rollback requester cannot review the request")
	ErrExpired              = errors.New("official Agent rollback request expired")
	ErrStateConflict        = errors.New("official Agent state changed")
	ErrNotFound             = errors.New("official Agent rollback request was not found")
	ErrTargetState          = errors.New("official Agent target state does not permit this action")
	ErrTargetDigestMismatch = errors.New("official Agent target digest changed")
)

var (
	reasonCodePattern     = regexp.MustCompile(`^[a-z][a-z0-9_]{2,63}$`)
	idempotencyKeyPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$`)
	ticketPattern         = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$`)
	digestPattern         = regexp.MustCompile(`^[0-9a-f]{64}$`)
)

type ApprovalStatus string

const (
	PendingReview ApprovalStatus = "pending_review"
	Approved      ApprovalStatus = "approved"
	Rejected      ApprovalStatus = "rejected"
	Cancelled     ApprovalStatus = "cancelled"
	Expired       ApprovalStatus = "expired"
)

type ExecutionStatus string

const (
	NotStarted  ExecutionStatus = "not_started"
	Queued      ExecutionStatus = "queued"
	Executing   ExecutionStatus = "executing"
	Reconciling ExecutionStatus = "reconciling"
	Succeeded   ExecutionStatus = "succeeded"
	Failed      ExecutionStatus = "failed"
	Conflict    ExecutionStatus = "conflict"
)

type MutationRequest struct {
	Action                operations.Action
	TargetID              uuid.UUID
	ExpectedRevision      int64
	ExpectedTargetDigest  string
	Payload               []byte
	Reason                admin.ActionReason
	BrowserIdempotencyKey string
}

type RollbackRequest struct {
	ReleaseID               uuid.UUID
	TargetVersionID         uuid.UUID
	TargetReleaseRevisionID uuid.UUID
	ExpectedHeadRevision    int64
	TargetDigest            string
	Reason                  admin.ActionReason
}

type RollbackApproval struct {
	ID                      uuid.UUID       `json:"id"`
	ReleaseID               uuid.UUID       `json:"release_id"`
	TargetVersionID         uuid.UUID       `json:"target_version_id"`
	TargetReleaseRevisionID uuid.UUID       `json:"target_release_revision_id"`
	ExpectedHeadRevision    int64           `json:"expected_head_revision"`
	TargetDigest            string          `json:"target_digest"`
	RequestedByAdminID      uuid.UUID       `json:"requested_by_admin_id"`
	ReviewedByAdminID       *uuid.UUID      `json:"reviewed_by_admin_id,omitempty"`
	ReasonCode              string          `json:"reason_code"`
	TicketReference         string          `json:"ticket_reference,omitempty"`
	SafeNote                string          `json:"safe_note,omitempty"`
	ApprovalStatus          ApprovalStatus  `json:"approval_status"`
	ExecutionStatus         ExecutionStatus `json:"execution_status"`
	OperationID             *uuid.UUID      `json:"operation_id,omitempty"`
	ExpiresAt               time.Time       `json:"expires_at"`
	ReviewedAt              *time.Time      `json:"reviewed_at,omitempty"`
	CreatedAt               time.Time       `json:"created_at"`
	UpdatedAt               time.Time       `json:"updated_at"`
	Version                 int64           `json:"version"`
	Events                  []RollbackEvent `json:"events,omitempty"`
}

type RollbackEvent struct {
	ID              uuid.UUID       `json:"id"`
	EventType       string          `json:"event_type"`
	ActorAdminID    uuid.UUID       `json:"actor_admin_id"`
	ActorRole       rbac.Role       `json:"actor_role"`
	ApprovalStatus  ApprovalStatus  `json:"approval_status"`
	ExecutionStatus ExecutionStatus `json:"execution_status"`
	OperationID     *uuid.UUID      `json:"operation_id,omitempty"`
	ErrorCode       string          `json:"error_code,omitempty"`
	CreatedAt       time.Time       `json:"created_at"`
}

type ListFilter struct {
	View   string
	Cursor string
	Limit  int
}

type RollbackPage struct {
	Items      []RollbackApproval `json:"items"`
	NextCursor string             `json:"next_cursor,omitempty"`
}

func mutationAllowed(role rbac.Role, action operations.Action) bool {
	switch action {
	case operations.OfficialDefinitionReserve, operations.OfficialDraftCreate,
		operations.OfficialDraftUpdate, operations.OfficialDraftSubmit,
		operations.OfficialSubmissionWithdraw:
		return role == rbac.Developer && rbac.Allowed(role, rbac.ManageOfficialDrafts)
	case operations.OfficialSubmissionReview:
		return role == rbac.SuperAdmin && rbac.Allowed(role, rbac.ReviewOfficialAgents)
	case operations.OfficialReleaseActivate, operations.OfficialReleaseRollout,
		operations.OfficialReleasePause, operations.OfficialReleaseResume:
		return role == rbac.Operator && rbac.Allowed(role, rbac.ManageOfficialReleases)
	default:
		return false
	}
}

func (request MutationRequest) validate(actor admin.Actor) error {
	if actor.AdminID == uuid.Nil || !mutationAllowed(actor.Role, request.Action) || request.TargetID == uuid.Nil ||
		request.ExpectedRevision <= 0 || !idempotencyKeyPattern.MatchString(request.BrowserIdempotencyKey) ||
		len(request.Payload) < 2 || len(request.Payload) > 131072 || !validReason(request.Reason) ||
		(request.ExpectedTargetDigest != "" && !digestPattern.MatchString(request.ExpectedTargetDigest)) {
		return ErrInvalidRequest
	}
	return nil
}

func (request RollbackRequest) validate(actor admin.Actor) error {
	if actor.AdminID == uuid.Nil || actor.Role != rbac.Operator || !rbac.Allowed(actor.Role, rbac.RequestOfficialRollback) ||
		request.ReleaseID == uuid.Nil || request.TargetVersionID == uuid.Nil || request.TargetReleaseRevisionID == uuid.Nil ||
		request.ExpectedHeadRevision <= 0 || !digestPattern.MatchString(request.TargetDigest) || !validReason(request.Reason) {
		return ErrInvalidRequest
	}
	return nil
}

func validReason(reason admin.ActionReason) bool {
	if !reasonCodePattern.MatchString(reason.Code) || reason.Meta.RequestID == "" || len(reason.Meta.RequestID) > 128 ||
		(reason.TicketReference != "" && !ticketPattern.MatchString(reason.TicketReference)) ||
		!validOptionalText(reason.Note, 500) || audit.ContainsSensitiveText(reason.TicketReference) ||
		audit.ContainsSensitiveText(reason.Note) || (len(reason.Meta.SourceIPHMAC) != 0 && len(reason.Meta.SourceIPHMAC) != 32) {
		return false
	}
	return true
}

func validOptionalText(value string, maximum int) bool {
	if !utf8.ValidString(value) || utf8.RuneCountInString(value) > maximum || strings.ContainsRune(value, '\x00') {
		return false
	}
	for _, character := range value {
		if unicode.IsControl(character) {
			return false
		}
	}
	return true
}

func (approval RollbackApproval) CanReview(actor admin.Actor, now time.Time) error {
	if approval.ApprovalStatus != PendingReview {
		return ErrStateConflict
	}
	if !now.UTC().Before(approval.ExpiresAt.UTC()) {
		return ErrExpired
	}
	if actor.AdminID == approval.RequestedByAdminID {
		return ErrSelfReview
	}
	if actor.AdminID == uuid.Nil || actor.Role != rbac.SuperAdmin || !rbac.Allowed(actor.Role, rbac.ApproveOfficialRollback) {
		return ErrPermissionDenied
	}
	return nil
}

func (approval RollbackApproval) CanCancel(actor admin.Actor, now time.Time) error {
	if approval.ApprovalStatus != PendingReview {
		return ErrStateConflict
	}
	if !now.UTC().Before(approval.ExpiresAt.UTC()) {
		return ErrExpired
	}
	if actor.AdminID == uuid.Nil || actor.Role != rbac.Operator || actor.AdminID != approval.RequestedByAdminID {
		return ErrPermissionDenied
	}
	return nil
}

func (status ApprovalStatus) valid() bool {
	return status == PendingReview || status == Approved || status == Rejected || status == Cancelled || status == Expired
}

func (status ExecutionStatus) valid() bool {
	return status == NotStarted || status == Queued || status == Executing || status == Reconciling ||
		status == Succeeded || status == Failed || status == Conflict
}
