package rbacadmin

import (
	"errors"
	"regexp"
	"strings"
	"time"

	"github.com/bignormal/aera-admin/internal/rbac"
)

// SuperAdminSlug is the protected system role that must always retain the
// administrator-management permission so operators can never lock themselves
// out of role management.
const SuperAdminSlug = "super_admin"

// RequiredSuperAdminPermission can never be removed from the super admin role.
const RequiredSuperAdminPermission = rbac.ManageAdministrators

var (
	ErrInvalidRequest      = errors.New("role request is invalid")
	ErrPermissionDenied    = errors.New("role management permission denied")
	ErrRoleExists          = errors.New("role slug already exists")
	ErrRoleNotFound        = errors.New("role not found")
	ErrRoleInUse           = errors.New("role is assigned to administrators")
	ErrSystemRole          = errors.New("system role cannot be changed this way")
	ErrProtectedPermission = errors.New("required system permission cannot be removed")
	ErrUnavailable         = errors.New("role service is unavailable")
)

var slugPattern = regexp.MustCompile(`^[a-z][a-z0-9_]{1,49}$`)

// Role is a data-driven administrator role plus its granted permissions.
type Role struct {
	Slug        string            `json:"slug"`
	Name        string            `json:"name"`
	Description string            `json:"description"`
	IsSystem    bool              `json:"is_system"`
	Permissions []rbac.Permission `json:"permissions"`
	UserCount   int64             `json:"user_count"`
	CreatedAt   time.Time         `json:"created_at"`
	UpdatedAt   time.Time         `json:"updated_at"`
}

// Catalog is the code-defined permission catalog returned to the console so the
// editor can render every assignable permission without hardcoding the list.
type Catalog struct {
	Permissions []rbac.Permission `json:"permissions"`
}

// RoleList is the response for listing roles.
type RoleList struct {
	Roles []Role `json:"roles"`
}

// CreateRoleInput creates a brand new custom role.
type CreateRoleInput struct {
	Slug        string   `json:"slug"`
	Name        string   `json:"name"`
	Description string   `json:"description"`
	Permissions []string `json:"permissions"`
}

// UpdateRoleInput mutates name, description and/or the permission set. Nil
// fields are left unchanged; the slug and is_system flag are never editable.
type UpdateRoleInput struct {
	Name        *string   `json:"name"`
	Description *string   `json:"description"`
	Permissions *[]string `json:"permissions"`
}

// MutationContext carries the authenticated actor and request metadata for
// auditing role changes.
type MutationContext struct {
	ActorAdminID string
	ActorRole    rbac.Role
	RequestID    string
	SourceIPHMAC []byte
	UserAgent    string
}

func validName(value string) bool {
	trimmed := strings.TrimSpace(value)
	return len(trimmed) >= 1 && len([]rune(trimmed)) <= 100
}

func validDescription(value string) bool {
	return len([]rune(value)) <= 500
}

// normalizePermissions validates every code against the canonical catalog and
// removes duplicates, returning them in catalog order. Any unknown permission
// makes the whole input invalid so the console cannot silently drop grants.
func normalizePermissions(raw []string) ([]rbac.Permission, error) {
	seen := make(map[rbac.Permission]struct{}, len(raw))
	for _, code := range raw {
		permission := rbac.Permission(code)
		if !permission.Valid() {
			return nil, ErrInvalidRequest
		}
		seen[permission] = struct{}{}
	}
	ordered := make([]rbac.Permission, 0, len(seen))
	for _, permission := range rbac.AllPermissions() {
		if _, ok := seen[permission]; ok {
			ordered = append(ordered, permission)
		}
	}
	return ordered, nil
}

func (input CreateRoleInput) validate() ([]rbac.Permission, error) {
	if !slugPattern.MatchString(input.Slug) || !validName(input.Name) || !validDescription(input.Description) {
		return nil, ErrInvalidRequest
	}
	return normalizePermissions(input.Permissions)
}

func containsPermission(permissions []rbac.Permission, target rbac.Permission) bool {
	for _, permission := range permissions {
		if permission == target {
			return true
		}
	}
	return false
}
