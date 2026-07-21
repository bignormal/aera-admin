package approval

import (
	"context"
	"errors"
	"time"

	"github.com/bignormal/aera-admin/internal/admin"
	"github.com/bignormal/aera-admin/internal/audit"
	"github.com/bignormal/aera-admin/internal/cloudadmin"
	"github.com/bignormal/aera-admin/internal/operations"
	"github.com/bignormal/aera-admin/internal/rbac"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

const approvalLifetime = 24 * time.Hour

type ServiceConfig struct {
	PostgreSQL *pgxpool.Pool
	Cloud      cloudadmin.Client
	Operations operations.TransactionalEnqueuer
	Audit      *audit.Service
	Clock      func() time.Time
}

type Service struct {
	repository *repository
	cloud      cloudadmin.Client
	operations operations.TransactionalEnqueuer
	audit      *audit.Service
	clock      func() time.Time
}

func NewService(settings ServiceConfig) (*Service, error) {
	if settings.PostgreSQL == nil || settings.Cloud == nil || settings.Operations == nil ||
		settings.Audit == nil || settings.Clock == nil {
		return nil, errors.New("approval service dependencies are required")
	}
	return &Service{
		repository: &repository{postgres: settings.PostgreSQL},
		cloud:      settings.Cloud,
		operations: settings.Operations,
		audit:      settings.Audit,
		clock:      settings.Clock,
	}, nil
}

func (service *Service) Create(ctx context.Context, input CreateRequest) (Request, error) {
	if service == nil || service.repository == nil {
		return Request{}, errors.New("approval service is unavailable")
	}
	if err := input.validate(); err != nil {
		return Request{}, err
	}
	if input.Actor.Role != rbac.Operator || !rbac.Allowed(input.Actor.Role, rbac.InitiateAccountLifecycle) {
		return Request{}, ErrPermissionDenied
	}
	user, err := service.cloud.GetUser(ctx, input.TargetUserID)
	if err != nil {
		return Request{}, mapCloudError(err)
	}
	if err := user.Validate(); err != nil || user.ID != input.TargetUserID {
		return Request{}, cloudadmin.ErrContractViolation
	}
	if !actionAllowed(input.Action, user) {
		return Request{}, ErrTargetState
	}
	now := service.clock().UTC()
	id, err := uuid.NewRandom()
	if err != nil {
		return Request{}, errors.New("approval identifier could not be generated")
	}
	request := Request{
		ID:                 id,
		Action:             input.Action,
		TargetUserID:       input.TargetUserID,
		TargetSnapshot:     user,
		RequestedByAdminID: input.Actor.AdminID,
		RequestedByRole:    input.Actor.Role,
		ReasonCode:         input.Reason.Code,
		TicketReference:    input.Reason.TicketReference,
		Note:               input.Reason.Note,
		ExpectedRevision:   user.AdministrativeRevision,
		Status:             PendingReview,
		ExecutionStatus:    NotStarted,
		ExpiresAt:          now.Add(approvalLifetime),
		CreatedAt:          now,
		UpdatedAt:          now,
		Version:            1,
	}
	return service.repository.InsertWithAudit(ctx, request, input.Actor, input.Reason, service.audit)
}

func (service *Service) Approve(ctx context.Context, actor admin.Actor, id uuid.UUID, idempotencyKey string) (Request, error) {
	if service == nil || service.repository == nil {
		return Request{}, errors.New("approval service is unavailable")
	}
	tx, err := service.repository.begin(ctx)
	if err != nil {
		return Request{}, err
	}
	defer func() { _ = tx.Rollback(context.Background()) }()
	request, err := lockRequest(ctx, tx, id)
	if err != nil {
		return Request{}, err
	}
	now := service.clock().UTC()
	if err := request.CanReview(actor, now); err != nil {
		if errors.Is(err, ErrExpired) {
			if persistErr := service.expireTx(ctx, tx, request, actor, now); persistErr != nil {
				return Request{}, persistErr
			}
			if commitErr := tx.Commit(ctx); commitErr != nil {
				return Request{}, errors.New("approval expiry could not be committed")
			}
		}
		return Request{}, err
	}
	action := operations.DisableUser
	if request.Action == EnableUser {
		action = operations.EnableUser
	}
	approvalID := request.ID
	result, err := service.operations.EnqueueTx(ctx, tx, operations.EnqueueRequest{
		Actor:                 actor,
		Action:                action,
		TargetID:              request.TargetUserID,
		ExpectedRevision:      request.ExpectedRevision,
		BrowserIdempotencyKey: idempotencyKey,
		ApprovalID:            &approvalID,
		Reason: admin.ActionReason{
			Code:            request.ReasonCode,
			TicketReference: request.TicketReference,
			Note:            request.Note,
			Meta:            actor.Meta,
		},
	})
	if err != nil {
		return Request{}, err
	}
	command, err := tx.Exec(ctx, `
		UPDATE approval_requests
		SET approval_status = 'approved', execution_status = 'queued',
			reviewed_by_admin_id = $2, reviewed_at = $3, operation_id = $4,
			updated_at = $3, version = version + 1
		WHERE id = $1 AND version = $5 AND approval_status = 'pending_review'
	`, request.ID, actor.AdminID, now, result.OperationID, request.Version)
	if err != nil {
		return Request{}, errors.New("approval could not be updated")
	}
	if command.RowsAffected() != 1 {
		return Request{}, ErrStateConflict
	}
	if err := insertEvent(
		ctx, tx, request.ID, actor.AdminID, actor.Role, "approved", string(PendingReview),
		string(Approved), "", actor.Meta.RequestID, now,
	); err != nil {
		return Request{}, err
	}
	if err := insertEvent(
		ctx, tx, request.ID, actor.AdminID, actor.Role, "execution_queued", string(NotStarted),
		string(Queued), "", actor.Meta.RequestID, now.Add(time.Microsecond),
	); err != nil {
		return Request{}, err
	}
	if _, err := service.audit.AppendTx(ctx, tx, audit.Record{
		ActorAdminID:    &actor.AdminID,
		ActorRole:       actor.Role,
		EventType:       "account_lifecycle_approved",
		ObjectType:      "cloud_user",
		ObjectID:        &request.TargetUserID,
		Outcome:         audit.OutcomeSuccess,
		ReasonCode:      request.ReasonCode,
		TicketReference: request.TicketReference,
		Note:            request.Note,
		ApprovalID:      &request.ID,
		OperationID:     &result.OperationID,
		BeforeState:     map[string]string{"approval_status": "pending_review"},
		AfterState: map[string]string{
			"approval_status":  "approved",
			"execution_status": "queued",
		},
		RequestID:    actor.Meta.RequestID,
		SourceIPHMAC: actor.Meta.SourceIPHMAC,
		UserAgent:    actor.Meta.UserAgent,
	}); err != nil {
		return Request{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return Request{}, errors.New("approval could not be committed")
	}
	return service.Get(ctx, actor, request.ID)
}

func (service *Service) Reject(ctx context.Context, actor admin.Actor, id uuid.UUID) (Request, error) {
	if service == nil || service.repository == nil {
		return Request{}, errors.New("approval service is unavailable")
	}
	tx, err := service.repository.begin(ctx)
	if err != nil {
		return Request{}, err
	}
	defer func() { _ = tx.Rollback(context.Background()) }()
	request, err := lockRequest(ctx, tx, id)
	if err != nil {
		return Request{}, err
	}
	now := service.clock().UTC()
	if err := request.CanReview(actor, now); err != nil {
		if errors.Is(err, ErrExpired) {
			if persistErr := service.expireTx(ctx, tx, request, actor, now); persistErr != nil {
				return Request{}, persistErr
			}
			if commitErr := tx.Commit(ctx); commitErr != nil {
				return Request{}, errors.New("approval expiry could not be committed")
			}
		}
		return Request{}, err
	}
	command, err := tx.Exec(ctx, `
		UPDATE approval_requests
		SET approval_status = 'rejected', reviewed_by_admin_id = $2, reviewed_at = $3,
			updated_at = $3, version = version + 1
		WHERE id = $1 AND approval_status = 'pending_review' AND version = $4
	`, request.ID, actor.AdminID, now, request.Version)
	if err != nil || command.RowsAffected() != 1 {
		return Request{}, ErrStateConflict
	}
	if err := insertEvent(
		ctx, tx, request.ID, actor.AdminID, actor.Role, "rejected", string(PendingReview),
		string(Rejected), "", actor.Meta.RequestID, now,
	); err != nil {
		return Request{}, err
	}
	if _, err := service.audit.AppendTx(ctx, tx, audit.Record{
		ActorAdminID:    &actor.AdminID,
		ActorRole:       actor.Role,
		EventType:       "account_lifecycle_rejected",
		ObjectType:      "cloud_user",
		ObjectID:        &request.TargetUserID,
		Outcome:         audit.OutcomeSuccess,
		ReasonCode:      request.ReasonCode,
		TicketReference: request.TicketReference,
		Note:            request.Note,
		ApprovalID:      &request.ID,
		BeforeState:     map[string]string{"approval_status": "pending_review"},
		AfterState:      map[string]string{"approval_status": "rejected"},
		RequestID:       actor.Meta.RequestID,
		SourceIPHMAC:    actor.Meta.SourceIPHMAC,
		UserAgent:       actor.Meta.UserAgent,
	}); err != nil {
		return Request{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return Request{}, errors.New("approval rejection could not be committed")
	}
	return service.Get(ctx, actor, request.ID)
}

func (service *Service) Cancel(ctx context.Context, actor admin.Actor, id uuid.UUID) (Request, error) {
	if service == nil || service.repository == nil {
		return Request{}, errors.New("approval service is unavailable")
	}
	tx, err := service.repository.begin(ctx)
	if err != nil {
		return Request{}, err
	}
	defer func() { _ = tx.Rollback(context.Background()) }()
	request, err := lockRequest(ctx, tx, id)
	if err != nil {
		return Request{}, err
	}
	now := service.clock().UTC()
	if err := request.CanCancel(actor, now); err != nil {
		if errors.Is(err, ErrExpired) {
			if persistErr := service.expireTx(ctx, tx, request, actor, now); persistErr != nil {
				return Request{}, persistErr
			}
			if commitErr := tx.Commit(ctx); commitErr != nil {
				return Request{}, errors.New("approval expiry could not be committed")
			}
		}
		return Request{}, err
	}
	command, err := tx.Exec(ctx, `
		UPDATE approval_requests
		SET approval_status = 'cancelled', updated_at = $2, version = version + 1
		WHERE id = $1 AND approval_status = 'pending_review' AND version = $3
	`, request.ID, now, request.Version)
	if err != nil || command.RowsAffected() != 1 {
		return Request{}, ErrStateConflict
	}
	if err := insertEvent(
		ctx, tx, request.ID, actor.AdminID, actor.Role, "cancelled", string(PendingReview),
		string(Cancelled), "", actor.Meta.RequestID, now,
	); err != nil {
		return Request{}, err
	}
	if _, err := service.audit.AppendTx(ctx, tx, audit.Record{
		ActorAdminID:    &actor.AdminID,
		ActorRole:       actor.Role,
		EventType:       "account_lifecycle_cancelled",
		ObjectType:      "cloud_user",
		ObjectID:        &request.TargetUserID,
		Outcome:         audit.OutcomeSuccess,
		ReasonCode:      request.ReasonCode,
		TicketReference: request.TicketReference,
		Note:            request.Note,
		ApprovalID:      &request.ID,
		BeforeState:     map[string]string{"approval_status": "pending_review"},
		AfterState:      map[string]string{"approval_status": "cancelled"},
		RequestID:       actor.Meta.RequestID,
		SourceIPHMAC:    actor.Meta.SourceIPHMAC,
		UserAgent:       actor.Meta.UserAgent,
	}); err != nil {
		return Request{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return Request{}, errors.New("approval cancellation could not be committed")
	}
	return service.Get(ctx, actor, request.ID)
}

func (service *Service) expireTx(
	ctx context.Context,
	tx pgx.Tx,
	request Request,
	actor admin.Actor,
	now time.Time,
) error {
	command, err := tx.Exec(ctx, `
		UPDATE approval_requests
		SET approval_status = 'expired', updated_at = $2, version = version + 1
		WHERE id = $1 AND approval_status = 'pending_review' AND version = $3
	`, request.ID, now, request.Version)
	if err != nil || command.RowsAffected() != 1 {
		return ErrStateConflict
	}
	if err := insertEvent(
		ctx, tx, request.ID, actor.AdminID, actor.Role, "expired", string(PendingReview),
		string(Expired), "APPROVAL_EXPIRED", actor.Meta.RequestID, now,
	); err != nil {
		return err
	}
	_, err = service.audit.AppendTx(ctx, tx, audit.Record{
		ActorAdminID: &actor.AdminID,
		ActorRole:    actor.Role,
		EventType:    "account_lifecycle_expired",
		ObjectType:   "cloud_user",
		ObjectID:     &request.TargetUserID,
		Outcome:      audit.OutcomeFailure,
		ErrorCode:    "APPROVAL_EXPIRED",
		ApprovalID:   &request.ID,
		BeforeState:  map[string]string{"approval_status": "pending_review"},
		AfterState:   map[string]string{"approval_status": "expired"},
		RequestID:    actor.Meta.RequestID,
		SourceIPHMAC: actor.Meta.SourceIPHMAC,
		UserAgent:    actor.Meta.UserAgent,
	})
	return err
}

func (service *Service) List(ctx context.Context, actor admin.Actor, filter ListFilter) (Page, error) {
	if service == nil || service.repository == nil {
		return Page{}, errors.New("approval service is unavailable")
	}
	return service.repository.List(ctx, actor, filter)
}

func (service *Service) Get(ctx context.Context, actor admin.Actor, id uuid.UUID) (Request, error) {
	if service == nil || service.repository == nil {
		return Request{}, errors.New("approval service is unavailable")
	}
	return service.repository.Get(ctx, actor, id)
}

func mapCloudError(err error) error {
	switch {
	case errors.Is(err, cloudadmin.ErrNotConfigured),
		errors.Is(err, cloudadmin.ErrUnavailable),
		errors.Is(err, cloudadmin.ErrContractViolation),
		errors.Is(err, cloudadmin.ErrNotFound),
		errors.Is(err, cloudadmin.ErrConflict):
		return err
	default:
		return cloudadmin.ErrUnavailable
	}
}
