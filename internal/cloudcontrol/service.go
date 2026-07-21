package cloudcontrol

import (
	"context"
	"errors"
	"regexp"
	"strings"
	"time"

	"github.com/bignormal/aera-admin/internal/admin"
	"github.com/bignormal/aera-admin/internal/approval"
	"github.com/bignormal/aera-admin/internal/audit"
	"github.com/bignormal/aera-admin/internal/cloudadmin"
	"github.com/bignormal/aera-admin/internal/operations"
	"github.com/bignormal/aera-admin/internal/rbac"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/redis/go-redis/v9"
)

var (
	ErrInvalidRequest   = errors.New("Cloud control request is invalid")
	ErrPermissionDenied = errors.New("Cloud control permission is denied")
)

var exactPhonePattern = regexp.MustCompile(`^\+?[0-9]{7,15}$`)

type ServiceConfig struct {
	PostgreSQL *pgxpool.Pool
	Redis      *redis.Client
	Cloud      cloudadmin.Client
	Operations *operations.Service
	Approvals  *approval.Service
	Audit      *audit.Service
	Clock      func() time.Time
}

type Service struct {
	postgres   *pgxpool.Pool
	redis      *redis.Client
	cloud      cloudadmin.Client
	operations *operations.Service
	approvals  *approval.Service
	audit      *audit.Service
	clock      func() time.Time
}

type HealthDocument struct {
	Admin      string            `json:"admin"`
	PostgreSQL string            `json:"postgres"`
	Redis      string            `json:"redis"`
	Cloud      cloudadmin.Health `json:"cloud"`
}

func NewService(settings ServiceConfig) (*Service, error) {
	if settings.PostgreSQL == nil || settings.Redis == nil || settings.Cloud == nil ||
		settings.Operations == nil || settings.Approvals == nil || settings.Audit == nil || settings.Clock == nil {
		return nil, errors.New("Cloud control service dependencies are required")
	}
	return &Service{
		postgres: settings.PostgreSQL, redis: settings.Redis, cloud: settings.Cloud,
		operations: settings.Operations, approvals: settings.Approvals, audit: settings.Audit, clock: settings.Clock,
	}, nil
}

func (service *Service) ListUsers(
	ctx context.Context,
	actor admin.Actor,
	input cloudadmin.ListUsersRequest,
) (cloudadmin.Page[cloudadmin.User], error) {
	if actor.AdminID == uuid.Nil || !rbac.Allowed(actor.Role, rbac.ReadCloudUsers) {
		return cloudadmin.Page[cloudadmin.User]{}, ErrPermissionDenied
	}
	if input.Limit < 1 || input.Limit > 100 || len(input.Cursor) > 512 ||
		(input.Status != "" && input.Status != cloudadmin.UserActive &&
			input.Status != cloudadmin.UserPendingDeletion && input.Status != cloudadmin.UserDisabled) {
		return cloudadmin.Page[cloudadmin.User]{}, ErrInvalidRequest
	}
	result, err := service.cloud.ListUsers(ctx, input)
	if err != nil {
		return cloudadmin.Page[cloudadmin.User]{}, mapCloudError(err)
	}
	return result, nil
}

func (service *Service) LookupUser(
	ctx context.Context,
	actor admin.Actor,
	input cloudadmin.LookupRequest,
) (cloudadmin.User, error) {
	if actor.AdminID == uuid.Nil || !rbac.Allowed(actor.Role, rbac.ExactIdentityLookup) {
		return cloudadmin.User{}, ErrPermissionDenied
	}
	if !validLookup(input) {
		return cloudadmin.User{}, ErrInvalidRequest
	}
	user, err := service.cloud.LookupUser(ctx, input)
	eventType := "cloud_identity_lookup_" + string(input.Kind)
	if err != nil {
		mapped := mapCloudError(err)
		if _, auditErr := service.audit.Append(ctx, audit.Record{
			ActorAdminID: &actor.AdminID,
			ActorRole:    actor.Role,
			EventType:    eventType,
			ObjectType:   "cloud_user",
			Outcome:      audit.OutcomeFailure,
			ErrorCode:    stableLookupError(mapped),
			RequestID:    actor.Meta.RequestID,
			SourceIPHMAC: actor.Meta.SourceIPHMAC,
			UserAgent:    actor.Meta.UserAgent,
		}); auditErr != nil {
			return cloudadmin.User{}, auditErr
		}
		return cloudadmin.User{}, mapped
	}
	if err := user.Validate(); err != nil {
		return cloudadmin.User{}, cloudadmin.ErrContractViolation
	}
	if _, err := service.audit.Append(ctx, audit.Record{
		ActorAdminID: &actor.AdminID,
		ActorRole:    actor.Role,
		EventType:    eventType,
		ObjectType:   "cloud_user",
		ObjectID:     &user.ID,
		Outcome:      audit.OutcomeSuccess,
		RequestID:    actor.Meta.RequestID,
		SourceIPHMAC: actor.Meta.SourceIPHMAC,
		UserAgent:    actor.Meta.UserAgent,
	}); err != nil {
		return cloudadmin.User{}, err
	}
	return user, nil
}

func (service *Service) GetUser(ctx context.Context, actor admin.Actor, userID uuid.UUID) (cloudadmin.User, error) {
	allowed := rbac.Allowed(actor.Role, rbac.ReadCloudUsers) || rbac.Allowed(actor.Role, rbac.ReadTechnicalUserFields)
	if actor.AdminID == uuid.Nil || !allowed {
		return cloudadmin.User{}, ErrPermissionDenied
	}
	if userID == uuid.Nil {
		return cloudadmin.User{}, ErrInvalidRequest
	}
	user, err := service.cloud.GetUser(ctx, userID)
	if err != nil {
		return cloudadmin.User{}, mapCloudError(err)
	}
	if err := user.Validate(); err != nil || user.ID != userID {
		return cloudadmin.User{}, cloudadmin.ErrContractViolation
	}
	return user, nil
}

func (service *Service) ListDevices(
	ctx context.Context,
	actor admin.Actor,
	userID uuid.UUID,
	page cloudadmin.PageRequest,
) (cloudadmin.Page[cloudadmin.Device], error) {
	if actor.AdminID == uuid.Nil || !rbac.Allowed(actor.Role, rbac.ReadCloudDevices) {
		return cloudadmin.Page[cloudadmin.Device]{}, ErrPermissionDenied
	}
	if userID == uuid.Nil || !validPage(page) {
		return cloudadmin.Page[cloudadmin.Device]{}, ErrInvalidRequest
	}
	result, err := service.cloud.ListUserDevices(ctx, userID, page)
	if err != nil {
		return cloudadmin.Page[cloudadmin.Device]{}, mapCloudError(err)
	}
	return result, nil
}

func (service *Service) ListSessions(
	ctx context.Context,
	actor admin.Actor,
	userID uuid.UUID,
	page cloudadmin.PageRequest,
) (cloudadmin.Page[cloudadmin.Session], error) {
	if actor.AdminID == uuid.Nil || !rbac.Allowed(actor.Role, rbac.ReadCloudDevices) {
		return cloudadmin.Page[cloudadmin.Session]{}, ErrPermissionDenied
	}
	if userID == uuid.Nil || !validPage(page) {
		return cloudadmin.Page[cloudadmin.Session]{}, ErrInvalidRequest
	}
	result, err := service.cloud.ListUserSessions(ctx, userID, page)
	if err != nil {
		return cloudadmin.Page[cloudadmin.Session]{}, mapCloudError(err)
	}
	return result, nil
}

func (service *Service) RevokeDevice(
	ctx context.Context,
	actor admin.Actor,
	deviceID uuid.UUID,
	expectedRevision int64,
	reason admin.ActionReason,
	idempotencyKey string,
) (operations.Result, error) {
	return service.operations.EnqueueImmediate(ctx, operations.EnqueueRequest{
		Actor: actor, Action: operations.RevokeDevice, TargetID: deviceID,
		ExpectedRevision: expectedRevision, Reason: reason, BrowserIdempotencyKey: idempotencyKey,
	})
}

func (service *Service) RevokeSession(
	ctx context.Context,
	actor admin.Actor,
	sessionID uuid.UUID,
	expectedRevision int64,
	reason admin.ActionReason,
	idempotencyKey string,
) (operations.Result, error) {
	return service.operations.EnqueueImmediate(ctx, operations.EnqueueRequest{
		Actor: actor, Action: operations.RevokeSession, TargetID: sessionID,
		ExpectedRevision: expectedRevision, Reason: reason, BrowserIdempotencyKey: idempotencyKey,
	})
}

func (service *Service) CreateApproval(ctx context.Context, input approval.CreateRequest) (approval.Request, error) {
	return service.approvals.Create(ctx, input)
}

func (service *Service) ListApprovals(ctx context.Context, actor admin.Actor, filter approval.ListFilter) (approval.Page, error) {
	return service.approvals.List(ctx, actor, filter)
}

func (service *Service) GetApproval(ctx context.Context, actor admin.Actor, id uuid.UUID) (approval.Request, error) {
	return service.approvals.Get(ctx, actor, id)
}

func (service *Service) ApproveApproval(ctx context.Context, actor admin.Actor, id uuid.UUID, key string) (approval.Request, error) {
	return service.approvals.Approve(ctx, actor, id, key)
}

func (service *Service) RejectApproval(ctx context.Context, actor admin.Actor, id uuid.UUID) (approval.Request, error) {
	return service.approvals.Reject(ctx, actor, id)
}

func (service *Service) CancelApproval(ctx context.Context, actor admin.Actor, id uuid.UUID) (approval.Request, error) {
	return service.approvals.Cancel(ctx, actor, id)
}

func (service *Service) GetOperation(ctx context.Context, actor admin.Actor, id uuid.UUID) (operations.Result, error) {
	return service.operations.Get(ctx, actor, id)
}

func (service *Service) Health(ctx context.Context, actor admin.Actor) (HealthDocument, error) {
	if actor.AdminID == uuid.Nil || !rbac.Allowed(actor.Role, rbac.ReadServiceHealth) {
		return HealthDocument{}, ErrPermissionDenied
	}
	document := HealthDocument{Admin: "ok", PostgreSQL: "ok", Redis: "ok"}
	if err := service.postgres.Ping(ctx); err != nil {
		document.PostgreSQL = "unavailable"
	}
	if err := service.redis.Ping(ctx).Err(); err != nil {
		document.Redis = "unavailable"
	}
	cloudHealth, err := service.cloud.Health(ctx)
	if err != nil && cloudHealth.Availability == "" {
		cloudHealth = cloudadmin.Health{
			Configured: true, Availability: cloudadmin.Unavailable, CheckedAt: service.clock().UTC(),
		}
	}
	if cloudHealth.CheckedAt.IsZero() {
		cloudHealth.CheckedAt = service.clock().UTC()
	}
	document.Cloud = cloudHealth
	return document, nil
}

func validLookup(input cloudadmin.LookupRequest) bool {
	if len(input.Value) < 3 || len(input.Value) > 320 || strings.TrimSpace(input.Value) != input.Value {
		return false
	}
	for _, character := range input.Value {
		if character <= 0x20 || character == 0x7f {
			return false
		}
	}
	switch input.Kind {
	case cloudadmin.IdentityEmail:
		parts := strings.Split(input.Value, "@")
		return len(parts) == 2 && parts[0] != "" && parts[1] != "" && !strings.Contains(input.Value, "*")
	case cloudadmin.IdentityPhone:
		return exactPhonePattern.MatchString(input.Value)
	default:
		return false
	}
}

func validPage(page cloudadmin.PageRequest) bool {
	return page.Limit >= 1 && page.Limit <= 100 && len(page.Cursor) <= 512
}

func stableLookupError(err error) string {
	switch {
	case errors.Is(err, cloudadmin.ErrNotFound):
		return "USER_NOT_FOUND"
	case errors.Is(err, cloudadmin.ErrNotConfigured):
		return "CLOUD_NOT_CONFIGURED"
	case errors.Is(err, cloudadmin.ErrContractViolation):
		return "CLOUD_CONTRACT_VIOLATION"
	default:
		return "CLOUD_UNAVAILABLE"
	}
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

var _ HandlerService = (*Service)(nil)
