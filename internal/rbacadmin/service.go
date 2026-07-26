package rbacadmin

import (
	"context"
	"errors"
	"strings"
	"time"

	"github.com/bignormal/aera-admin/internal/audit"
	"github.com/bignormal/aera-admin/internal/rbac"
	"github.com/google/uuid"
)

// Store abstraction consumed by the service (satisfied by *Store).
type roleStore interface {
	LoadMatrix(context.Context) ([]rbac.Role, map[rbac.Role][]rbac.Permission, error)
	List(context.Context) ([]Role, error)
	Get(context.Context, string) (Role, error)
	Create(context.Context, string, string, string, []rbac.Permission, time.Time) error
	Update(context.Context, string, *string, *string, *[]rbac.Permission, time.Time) error
	Delete(context.Context, string) error
}

// Service coordinates role CRUD with the active rbac matrix and the audit log.
type Service struct {
	store roleStore
	audit audit.Recorder
	clock func() time.Time
}

type ServiceConfig struct {
	Store roleStore
	Audit audit.Recorder
	Clock func() time.Time
}

func NewService(config ServiceConfig) (*Service, error) {
	if config.Store == nil || config.Audit == nil {
		return nil, errors.New("rbac admin service dependencies are required")
	}
	clock := config.Clock
	if clock == nil {
		clock = time.Now
	}
	return &Service{store: config.Store, audit: config.Audit, clock: clock}, nil
}

// Refresh loads the persisted matrix and publishes it into the active rbac
// matrix. It runs at startup and after every successful mutation.
func (service *Service) Refresh(ctx context.Context) error {
	if service == nil {
		return ErrUnavailable
	}
	roles, permissions, err := service.store.LoadMatrix(ctx)
	if err != nil {
		return err
	}
	rbac.SetMatrix(roles, permissions)
	return nil
}

// Catalog returns the immutable code-defined permission catalog.
func (service *Service) Catalog() Catalog {
	return Catalog{Permissions: rbac.AllPermissions()}
}

// ListRoles returns all roles with permissions and assignment counts.
func (service *Service) ListRoles(ctx context.Context) (RoleList, error) {
	if service == nil {
		return RoleList{}, ErrUnavailable
	}
	roles, err := service.store.List(ctx)
	if err != nil {
		return RoleList{}, err
	}
	return RoleList{Roles: roles}, nil
}

// CreateRole adds a new custom (non-system) role.
func (service *Service) CreateRole(ctx context.Context, actor MutationContext, input CreateRoleInput) (Role, error) {
	if service == nil {
		return Role{}, ErrUnavailable
	}
	permissions, err := input.validate()
	if err != nil {
		return Role{}, err
	}
	now := service.clock().UTC()
	if err := service.store.Create(ctx, input.Slug, strings.TrimSpace(input.Name), input.Description, permissions, now); err != nil {
		service.auditMutation(ctx, actor, "admin_role_created", input.Slug, audit.OutcomeFailure, mutationError(err))
		return Role{}, err
	}
	if err := service.Refresh(ctx); err != nil {
		return Role{}, err
	}
	service.auditMutation(ctx, actor, "admin_role_created", input.Slug, audit.OutcomeSuccess, "")
	return service.store.Get(ctx, input.Slug)
}

// UpdateRole edits an existing role. System roles keep their slug and is_system
// flag; super_admin can never lose the administrator-management permission.
func (service *Service) UpdateRole(ctx context.Context, actor MutationContext, slug string, input UpdateRoleInput) (Role, error) {
	if service == nil {
		return Role{}, ErrUnavailable
	}
	if !slugPattern.MatchString(slug) {
		return Role{}, ErrInvalidRequest
	}
	if _, err := service.store.Get(ctx, slug); err != nil {
		return Role{}, err
	}
	var namePtr *string
	if input.Name != nil {
		if !validName(*input.Name) {
			return Role{}, ErrInvalidRequest
		}
		trimmed := strings.TrimSpace(*input.Name)
		namePtr = &trimmed
	}
	var descriptionPtr *string
	if input.Description != nil {
		if !validDescription(*input.Description) {
			return Role{}, ErrInvalidRequest
		}
		descriptionPtr = input.Description
	}
	var permissionsPtr *[]rbac.Permission
	if input.Permissions != nil {
		permissions, permErr := normalizePermissions(*input.Permissions)
		if permErr != nil {
			return Role{}, permErr
		}
		if slug == SuperAdminSlug && !containsPermission(permissions, RequiredSuperAdminPermission) {
			return Role{}, ErrProtectedPermission
		}
		permissionsPtr = &permissions
	}
	now := service.clock().UTC()
	if err := service.store.Update(ctx, slug, namePtr, descriptionPtr, permissionsPtr, now); err != nil {
		service.auditMutation(ctx, actor, "admin_role_updated", slug, audit.OutcomeFailure, mutationError(err))
		return Role{}, err
	}
	if err := service.Refresh(ctx); err != nil {
		return Role{}, err
	}
	service.auditMutation(ctx, actor, "admin_role_updated", slug, audit.OutcomeSuccess, "")
	return service.store.Get(ctx, slug)
}

// DeleteRole removes a custom role. System roles cannot be deleted, and a role
// still assigned to any administrator is rejected as in use.
func (service *Service) DeleteRole(ctx context.Context, actor MutationContext, slug string) error {
	if service == nil {
		return ErrUnavailable
	}
	if !slugPattern.MatchString(slug) {
		return ErrInvalidRequest
	}
	existing, err := service.store.Get(ctx, slug)
	if err != nil {
		return err
	}
	if existing.IsSystem {
		return ErrSystemRole
	}
	if err := service.store.Delete(ctx, slug); err != nil {
		service.auditMutation(ctx, actor, "admin_role_deleted", slug, audit.OutcomeFailure, mutationError(err))
		return err
	}
	if err := service.Refresh(ctx); err != nil {
		return err
	}
	service.auditMutation(ctx, actor, "admin_role_deleted", slug, audit.OutcomeSuccess, "")
	return nil
}

func (service *Service) auditMutation(ctx context.Context, actor MutationContext, eventType, slug string, outcome audit.Outcome, errorCode string) {
	if service.audit == nil {
		return
	}
	record := audit.Record{
		EventType: eventType, ObjectType: "admin_role", Outcome: outcome,
		AfterState: map[string]string{"role": slug}, RequestID: actor.RequestID,
		SourceIPHMAC: append([]byte(nil), actor.SourceIPHMAC...), UserAgent: actor.UserAgent,
		ErrorCode: errorCode,
	}
	if actor.ActorAdminID != "" {
		if adminID, err := uuid.Parse(actor.ActorAdminID); err == nil {
			record.ActorAdminID = &adminID
			record.ActorRole = actor.ActorRole
		}
	}
	_, _ = service.audit.Append(ctx, record)
}

func mutationError(err error) string {
	switch {
	case errors.Is(err, ErrRoleExists):
		return "ROLE_ALREADY_EXISTS"
	case errors.Is(err, ErrRoleNotFound):
		return "ROLE_NOT_FOUND"
	case errors.Is(err, ErrRoleInUse):
		return "ROLE_IN_USE"
	case errors.Is(err, ErrSystemRole):
		return "SYSTEM_ROLE_PROTECTED"
	case errors.Is(err, ErrProtectedPermission):
		return "PROTECTED_PERMISSION"
	case errors.Is(err, ErrInvalidRequest):
		return "INVALID_REQUEST"
	default:
		return "ROLE_UNAVAILABLE"
	}
}
