package approval

import (
	"errors"
	"regexp"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/bignormal/aera-admin/internal/admin"
	"github.com/bignormal/aera-admin/internal/audit"
	"github.com/bignormal/aera-admin/internal/cloudadmin"
	"github.com/bignormal/aera-admin/internal/rbac"
	"github.com/google/uuid"
)

var (
	ErrInvalidRequest   = errors.New("approval request is invalid")
	ErrPermissionDenied = errors.New("approval permission is denied")
	ErrSelfReview       = errors.New("approval requester cannot review the request")
	ErrExpired          = errors.New("approval request expired")
	ErrStateConflict    = errors.New("approval state changed")
	ErrNotFound         = errors.New("approval request was not found")
	ErrTargetState      = errors.New("Cloud user state does not permit this action")
)

var (
	approvalReasonCodePattern = regexp.MustCompile(`^[a-z][a-z0-9_]{2,63}$`)
	approvalRequestIDPattern  = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$`)
	approvalTicketPattern     = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$`)
)

type Action string

const (
	DisableUser Action = "disable_user"
	EnableUser  Action = "enable_user"
)

type Status string

const (
	PendingReview Status = "pending_review"
	Approved      Status = "approved"
	Rejected      Status = "rejected"
	Expired       Status = "expired"
	Cancelled     Status = "cancelled"
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

type Request struct {
	ID                 uuid.UUID       `json:"id"`
	Action             Action          `json:"action"`
	TargetUserID       uuid.UUID       `json:"target_user_id"`
	TargetSnapshot     cloudadmin.User `json:"target_snapshot"`
	RequestedByAdminID uuid.UUID       `json:"requested_by_admin_id"`
	RequestedByRole    rbac.Role       `json:"requested_by_role"`
	ReviewedByAdminID  *uuid.UUID      `json:"reviewed_by_admin_id,omitempty"`
	ReasonCode         string          `json:"reason_code"`
	TicketReference    string          `json:"ticket_reference,omitempty"`
	Note               string          `json:"note,omitempty"`
	ExpectedRevision   int64           `json:"expected_revision"`
	Status             Status          `json:"approval_status"`
	ExecutionStatus    ExecutionStatus `json:"execution_status"`
	OperationID        *uuid.UUID      `json:"operation_id,omitempty"`
	ExpiresAt          time.Time       `json:"expires_at"`
	CreatedAt          time.Time       `json:"created_at"`
	UpdatedAt          time.Time       `json:"updated_at"`
	Version            int64           `json:"version"`
	Events             []Event         `json:"events,omitempty"`
}

type CreateRequest struct {
	Actor        admin.Actor
	Action       Action
	TargetUserID uuid.UUID
	Reason       admin.ActionReason
}

type ListFilter struct {
	View   string
	Cursor string
	Limit  int
}

type Page struct {
	Items      []Request `json:"items"`
	NextCursor string    `json:"next_cursor,omitempty"`
}

type Event struct {
	ID           uuid.UUID `json:"id"`
	EventType    string    `json:"event_type"`
	BeforeStatus string    `json:"before_status"`
	AfterStatus  string    `json:"after_status"`
	ResultCode   string    `json:"result_code,omitempty"`
	ActorAdminID uuid.UUID `json:"actor_admin_id"`
	ActorRole    rbac.Role `json:"actor_role"`
	RequestID    string    `json:"request_id"`
	CreatedAt    time.Time `json:"created_at"`
}

func (request Request) CanReview(actor admin.Actor, now time.Time) error {
	if request.Status != PendingReview {
		return ErrStateConflict
	}
	if !now.UTC().Before(request.ExpiresAt.UTC()) {
		return ErrExpired
	}
	if actor.AdminID == request.RequestedByAdminID {
		return ErrSelfReview
	}
	if actor.AdminID == uuid.Nil || actor.Role != rbac.SuperAdmin || !rbac.Allowed(actor.Role, rbac.ApproveAccountLifecycle) {
		return ErrPermissionDenied
	}
	return nil
}

func (request Request) CanCancel(actor admin.Actor, now time.Time) error {
	if request.Status != PendingReview {
		return ErrStateConflict
	}
	if !now.UTC().Before(request.ExpiresAt.UTC()) {
		return ErrExpired
	}
	if actor.AdminID == uuid.Nil || actor.AdminID != request.RequestedByAdminID || actor.Role != rbac.Operator {
		return ErrPermissionDenied
	}
	return nil
}

func actionAllowed(action Action, user cloudadmin.User) bool {
	switch action {
	case DisableUser:
		return user.Status == cloudadmin.UserActive && !user.AdministrativelyDisabled && user.DeletionFinalizedAt == nil
	case EnableUser:
		return user.Status == cloudadmin.UserDisabled && user.AdministrativelyDisabled && user.DeletionFinalizedAt == nil
	default:
		return false
	}
}

func (request CreateRequest) validate() error {
	if request.Actor.AdminID == uuid.Nil || !request.Actor.Role.Valid() ||
		(request.Action != DisableUser && request.Action != EnableUser) || request.TargetUserID == uuid.Nil ||
		!approvalReasonCodePattern.MatchString(request.Reason.Code) ||
		(request.Reason.TicketReference != "" && !approvalTicketPattern.MatchString(request.Reason.TicketReference)) ||
		!validApprovalNote(request.Reason.Note) || audit.ContainsSensitiveText(request.Reason.TicketReference) ||
		audit.ContainsSensitiveText(request.Reason.Note) || !approvalRequestIDPattern.MatchString(request.Reason.Meta.RequestID) ||
		(len(request.Reason.Meta.SourceIPHMAC) != 0 && len(request.Reason.Meta.SourceIPHMAC) != 32) {
		return ErrInvalidRequest
	}
	return nil
}

func validApprovalNote(value string) bool {
	if !utf8.ValidString(value) || utf8.RuneCountInString(value) > 500 {
		return false
	}
	for _, character := range value {
		if unicode.IsControl(character) {
			return false
		}
	}
	return true
}

func (status Status) valid() bool {
	return status == PendingReview || status == Approved || status == Rejected || status == Expired || status == Cancelled
}

func (status ExecutionStatus) valid() bool {
	return status == NotStarted || status == Queued || status == Executing || status == Reconciling ||
		status == Succeeded || status == Failed || status == Conflict
}
