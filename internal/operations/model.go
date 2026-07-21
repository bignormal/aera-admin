package operations

import (
	"crypto/sha256"
	"errors"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/bignormal/aera-admin/internal/admin"
	"github.com/bignormal/aera-admin/internal/audit"
	"github.com/bignormal/aera-admin/internal/rbac"
	"github.com/google/uuid"
)

var (
	ErrInvalidRequest       = errors.New("operation request is invalid")
	ErrPermissionDenied     = errors.New("operation permission is denied")
	ErrIdempotencyKeyReused = errors.New("idempotency key was reused for another request")
	ErrOperationNotFound    = errors.New("operation was not found")
	ErrCloudUnavailable     = errors.New("Cloud administration is unavailable")
)

var (
	idempotencyKeyPattern     = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$`)
	operationErrorCodePattern = regexp.MustCompile(`^[A-Z][A-Z0-9_]{2,99}$`)
	reasonCodePattern         = regexp.MustCompile(`^[a-z][a-z0-9_]{2,63}$`)
)

type Action string

const (
	RevokeDevice  Action = "revoke_device"
	RevokeSession Action = "revoke_session"
	DisableUser   Action = "disable_user"
	EnableUser    Action = "enable_user"
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
	Actor                 admin.Actor
	Action                Action
	TargetID              uuid.UUID
	ExpectedRevision      int64
	Reason                admin.ActionReason
	BrowserIdempotencyKey string
	ApprovalID            *uuid.UUID
}

type Result struct {
	OperationID uuid.UUID `json:"operation_id"`
	State       State     `json:"state"`
	ErrorCode   string    `json:"error_code,omitempty"`
	UpdatedAt   time.Time `json:"updated_at"`
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
	if request.ApprovalID != nil && *request.ApprovalID == uuid.Nil {
		return ErrInvalidRequest
	}
	return nil
}

func (action Action) Valid() bool {
	return action == RevokeDevice || action == RevokeSession || action == DisableUser || action == EnableUser
}

func permissionFor(action Action) rbac.Permission {
	switch action {
	case RevokeDevice:
		return rbac.RevokeCloudDevice
	case RevokeSession:
		return rbac.RevokeCloudSession
	case DisableUser, EnableUser:
		return rbac.ApproveAccountLifecycle
	default:
		return rbac.Permission("")
	}
}

func requestDigest(request EnqueueRequest) [sha256.Size]byte {
	approvalID := ""
	if request.ApprovalID != nil {
		approvalID = request.ApprovalID.String()
	}
	canonical := strings.Join([]string{
		string(request.Action), request.TargetID.String(), strconv.FormatInt(request.ExpectedRevision, 10),
		request.Reason.Code, request.Reason.TicketReference, request.Reason.Note, approvalID,
	}, "\x00")
	return sha256.Sum256([]byte(canonical))
}

func (state State) valid() bool {
	return state == StateQueued || state == StateExecuting || state == StateReconciling ||
		state == StateSucceeded || state == StateFailed || state == StateConflict
}
