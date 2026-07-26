package rbac

import (
	"sort"
	"sync/atomic"
)

type Role string

const (
	SuperAdmin Role = "super_admin"
	Developer  Role = "developer"
	Operator   Role = "operator"
	Support    Role = "support"
	Finance    Role = "finance"
	Auditor    Role = "auditor"
)

type Permission string

const (
	ManageAdministrators     Permission = "administrator.manage"
	ReadAdministrators       Permission = "administrator.read"
	ReadCloudUsers           Permission = "cloud_user.read"
	ReadTechnicalUserFields  Permission = "cloud_user.read_technical"
	ExactIdentityLookup      Permission = "cloud_identity.lookup_exact"
	ReadCloudDevices         Permission = "cloud_device.read"
	RevokeCloudSession       Permission = "cloud_session.revoke"
	RevokeCloudDevice        Permission = "cloud_device.revoke"
	InitiateAccountLifecycle Permission = "account_lifecycle.initiate"
	ApproveAccountLifecycle  Permission = "account_lifecycle.approve"
	ReadFullAudit            Permission = "audit.read_full"
	ReadOwnAudit             Permission = "audit.read_own"
	ReadServiceHealth        Permission = "service_health.read"
	ReadSystemSettings       Permission = "system_settings.read"
	ManageSystemSettings     Permission = "system_settings.manage"
	ReadOfficialAgents       Permission = "official_agent.read"
	ManageOfficialDrafts     Permission = "official_agent.draft.manage"
	ReviewOfficialAgents     Permission = "official_agent.review"
	ManageOfficialReleases   Permission = "official_agent.release.manage"
	RequestOfficialRollback  Permission = "official_agent.rollback.request"
	ApproveOfficialRollback  Permission = "official_agent.rollback.approve"
	ReadOfficialAgentAudit   Permission = "official_agent.audit.read"
)

var fixedRoles = []Role{
	SuperAdmin,
	Developer,
	Operator,
	Support,
	Finance,
	Auditor,
}

var fixedPermissions = map[Role][]Permission{
	SuperAdmin: {
		ManageAdministrators,
		ReadAdministrators,
		ReadCloudUsers,
		ReadTechnicalUserFields,
		ExactIdentityLookup,
		ReadCloudDevices,
		RevokeCloudSession,
		RevokeCloudDevice,
		ApproveAccountLifecycle,
		ReadFullAudit,
		ReadServiceHealth,
		ReadSystemSettings,
		ManageSystemSettings,
		ReadOfficialAgents,
		ReviewOfficialAgents,
		ApproveOfficialRollback,
		ReadOfficialAgentAudit,
	},
	Developer: {
		ReadTechnicalUserFields,
		ReadCloudDevices,
		ReadServiceHealth,
		ReadOfficialAgents,
		ManageOfficialDrafts,
	},
	Operator: {
		ReadCloudUsers,
		ExactIdentityLookup,
		ReadCloudDevices,
		RevokeCloudSession,
		RevokeCloudDevice,
		InitiateAccountLifecycle,
		ReadOwnAudit,
		ReadServiceHealth,
		ReadOfficialAgents,
		ManageOfficialReleases,
		RequestOfficialRollback,
	},
	Support: {
		ReadCloudUsers,
		ExactIdentityLookup,
		ReadCloudDevices,
		RevokeCloudSession,
		RevokeCloudDevice,
		ReadOwnAudit,
	},
	Finance: {},
	Auditor: {
		ReadAdministrators,
		ReadFullAudit,
		ReadServiceHealth,
		ReadSystemSettings,
		ReadOfficialAgents,
		ReadOfficialAgentAudit,
	},
}

// allPermissions is the code-defined permission catalog. Roles may only be
// granted permissions from this list; new permissions cannot be created at
// runtime. The order here drives display order and Permissions() ordering.
var allPermissions = []Permission{
	ManageAdministrators,
	ReadAdministrators,
	ReadCloudUsers,
	ReadTechnicalUserFields,
	ExactIdentityLookup,
	ReadCloudDevices,
	RevokeCloudSession,
	RevokeCloudDevice,
	InitiateAccountLifecycle,
	ApproveAccountLifecycle,
	ReadFullAudit,
	ReadOwnAudit,
	ReadServiceHealth,
	ReadSystemSettings,
	ManageSystemSettings,
	ReadOfficialAgents,
	ManageOfficialDrafts,
	ReviewOfficialAgents,
	ManageOfficialReleases,
	RequestOfficialRollback,
	ApproveOfficialRollback,
	ReadOfficialAgentAudit,
}

var permissionCatalog = func() map[Permission]int {
	catalog := make(map[Permission]int, len(allPermissions))
	for index, permission := range allPermissions {
		catalog[permission] = index
	}
	return catalog
}()

// matrix is an immutable snapshot of role -> permission assignments. The active
// matrix is swapped atomically so that Allowed and friends stay lock-free and
// every in-flight request observes a consistent view.
type matrix struct {
	roles []Role
	perms map[Role]map[Permission]struct{}
}

var active atomic.Pointer[matrix]

func init() {
	SetMatrix(fixedRoles, fixedPermissions)
}

func buildMatrix(roles []Role, perms map[Role][]Permission) *matrix {
	snapshot := &matrix{
		roles: append([]Role(nil), roles...),
		perms: make(map[Role]map[Permission]struct{}, len(roles)),
	}
	for _, role := range roles {
		snapshot.perms[role] = make(map[Permission]struct{})
	}
	for role, list := range perms {
		set, ok := snapshot.perms[role]
		if !ok {
			set = make(map[Permission]struct{})
			snapshot.perms[role] = set
		}
		for _, permission := range list {
			if _, known := permissionCatalog[permission]; known {
				set[permission] = struct{}{}
			}
		}
	}
	return snapshot
}

// SetMatrix atomically replaces the active role -> permission matrix. Callers
// pass the ordered set of roles and each role's granted permissions; unknown
// permissions are dropped so the code-defined catalog stays canonical.
func SetMatrix(roles []Role, perms map[Role][]Permission) {
	active.Store(buildMatrix(roles, perms))
}

func current() *matrix {
	snapshot := active.Load()
	if snapshot == nil {
		snapshot = buildMatrix(fixedRoles, fixedPermissions)
		active.Store(snapshot)
	}
	return snapshot
}

func (role Role) Valid() bool {
	_, ok := current().perms[role]
	return ok
}

func (permission Permission) Valid() bool {
	_, ok := permissionCatalog[permission]
	return ok
}

// AllPermissions returns the immutable code-defined permission catalog.
func AllPermissions() []Permission {
	return append([]Permission(nil), allPermissions...)
}

func Roles() []Role {
	return append([]Role(nil), current().roles...)
}

func Permissions(role Role) []Permission {
	set, ok := current().perms[role]
	if !ok {
		return nil
	}
	result := make([]Permission, 0, len(set))
	for permission := range set {
		result = append(result, permission)
	}
	sort.Slice(result, func(left, right int) bool {
		return permissionCatalog[result[left]] < permissionCatalog[result[right]]
	})
	return result
}

func Allowed(role Role, permission Permission) bool {
	if _, known := permissionCatalog[permission]; !known {
		return false
	}
	set, ok := current().perms[role]
	if !ok {
		return false
	}
	_, allowed := set[permission]
	return allowed
}
