package rbac

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
	},
	Developer: {
		ReadTechnicalUserFields,
		ReadCloudDevices,
		ReadServiceHealth,
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
	},
}

var knownPermissions = func() map[Permission]struct{} {
	known := make(map[Permission]struct{})
	for _, permissions := range fixedPermissions {
		for _, permission := range permissions {
			known[permission] = struct{}{}
		}
	}
	known[InitiateAccountLifecycle] = struct{}{}
	return known
}()

func (role Role) Valid() bool {
	_, ok := fixedPermissions[role]
	return ok
}

func (permission Permission) Valid() bool {
	_, ok := knownPermissions[permission]
	return ok
}

func Roles() []Role {
	return append([]Role(nil), fixedRoles...)
}

func Permissions(role Role) []Permission {
	permissions, ok := fixedPermissions[role]
	if !ok {
		return nil
	}
	return append([]Permission(nil), permissions...)
}

func Allowed(role Role, permission Permission) bool {
	if !permission.Valid() {
		return false
	}
	for _, candidate := range fixedPermissions[role] {
		if candidate == permission {
			return true
		}
	}
	return false
}
