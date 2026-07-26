package rbac

import "testing"

func TestSetMatrixHotUpdatesActiveMatrix(t *testing.T) {
	t.Cleanup(func() { SetMatrix(fixedRoles, fixedPermissions) })
	custom := Role("content_reviewer")
	SetMatrix([]Role{SuperAdmin, custom}, map[Role][]Permission{
		SuperAdmin: {ManageAdministrators},
		custom:     {ReadOfficialAgents, ReviewOfficialAgents},
	})
	if !Allowed(custom, ReadOfficialAgents) || !Allowed(custom, ReviewOfficialAgents) {
		t.Fatal("custom role missing its granted permissions after SetMatrix")
	}
	if Allowed(custom, ManageAdministrators) {
		t.Fatal("custom role must not hold a permission it was not granted")
	}
	if !custom.Valid() {
		t.Fatal("custom role should be valid once present in the matrix")
	}
	if !Allowed(SuperAdmin, ManageAdministrators) {
		t.Fatal("super_admin lost its granted permission")
	}
	if Allowed(SuperAdmin, ReadCloudUsers) {
		t.Fatal("super_admin gained a permission absent from the new matrix")
	}
	roles := Roles()
	if len(roles) != 2 || roles[0] != SuperAdmin || roles[1] != custom {
		t.Fatalf("Roles() = %v, want ordered [super_admin content_reviewer]", roles)
	}
}

func TestSetMatrixDropsUnknownPermissions(t *testing.T) {
	t.Cleanup(func() { SetMatrix(fixedRoles, fixedPermissions) })
	custom := Role("weird")
	SetMatrix([]Role{custom}, map[Role][]Permission{
		custom: {Permission("not.a.real.permission"), ReadCloudUsers},
	})
	if Allowed(custom, Permission("not.a.real.permission")) {
		t.Fatal("unknown permission must never be retained")
	}
	if !Allowed(custom, ReadCloudUsers) {
		t.Fatal("known permission was dropped")
	}
	got := Permissions(custom)
	if len(got) != 1 || got[0] != ReadCloudUsers {
		t.Fatalf("Permissions(custom) = %v, want [cloud_user.read]", got)
	}
}

func TestDeletedRoleDeniesEverything(t *testing.T) {
	t.Cleanup(func() { SetMatrix(fixedRoles, fixedPermissions) })
	SetMatrix([]Role{SuperAdmin}, map[Role][]Permission{SuperAdmin: {ManageAdministrators}})
	if Operator.Valid() {
		t.Fatal("role removed from the matrix must be invalid")
	}
	if Allowed(Operator, ReadCloudUsers) {
		t.Fatal("role removed from the matrix must be denied every permission")
	}
}

func TestAllPermissionsCoversCatalog(t *testing.T) {
	all := AllPermissions()
	if len(all) != len(allPermissions) {
		t.Fatalf("AllPermissions() len = %d, want %d", len(all), len(allPermissions))
	}
	for _, permission := range all {
		if !permission.Valid() {
			t.Fatalf("catalog permission %q is not valid", permission)
		}
	}
}
