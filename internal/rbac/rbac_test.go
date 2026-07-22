package rbac

import (
	"reflect"
	"testing"
)

func TestFixedMatrix(t *testing.T) {
	tests := []struct {
		role       Role
		permission Permission
		want       bool
	}{
		{Support, RevokeCloudSession, true},
		{Support, InitiateAccountLifecycle, false},
		{Operator, InitiateAccountLifecycle, true},
		{Operator, ApproveAccountLifecycle, false},
		{SuperAdmin, ApproveAccountLifecycle, true},
		{Developer, ExactIdentityLookup, false},
		{Auditor, ReadFullAudit, true},
		{Auditor, RevokeCloudSession, false},
		{Finance, ReadCloudUsers, false},
		{Finance, ReadServiceHealth, false},
		{Developer, ReadTechnicalUserFields, true},
		{SuperAdmin, InitiateAccountLifecycle, false},
		{SuperAdmin, ReadSystemSettings, true},
		{SuperAdmin, ManageSystemSettings, true},
		{Auditor, ReadSystemSettings, true},
		{Auditor, ManageSystemSettings, false},
		{Developer, ReadSystemSettings, false},
		{Operator, ReadSystemSettings, false},
		{Support, ReadSystemSettings, false},
		{Finance, ReadSystemSettings, false},
	}

	for _, test := range tests {
		t.Run(string(test.role)+"/"+string(test.permission), func(t *testing.T) {
			if got := Allowed(test.role, test.permission); got != test.want {
				t.Errorf("Allowed(%s, %s) = %v, want %v", test.role, test.permission, got, test.want)
			}
		})
	}
}

func TestFixedRolesAreCompleteAndOrdered(t *testing.T) {
	want := []Role{SuperAdmin, Developer, Operator, Support, Finance, Auditor}
	if got := Roles(); !reflect.DeepEqual(got, want) {
		t.Fatalf("Roles() = %v, want %v", got, want)
	}
	for _, role := range want {
		if !role.Valid() {
			t.Errorf("role %q is not valid", role)
		}
	}
	if Role("custom_admin").Valid() {
		t.Fatal("custom role was accepted")
	}
}

func TestPermissionsAreDefensiveAndUnknownValuesDeny(t *testing.T) {
	first := Permissions(SuperAdmin)
	if len(first) == 0 {
		t.Fatal("super_admin has no permissions")
	}
	first[0] = Permission("tampered")
	if reflect.DeepEqual(first, Permissions(SuperAdmin)) {
		t.Fatal("Permissions returned mutable shared storage")
	}
	if Allowed(Role("unknown"), ReadCloudUsers) {
		t.Fatal("unknown role was allowed")
	}
	if Allowed(SuperAdmin, Permission("unknown")) {
		t.Fatal("unknown permission was allowed")
	}
}

func TestOfficialAgentPermissionMatrix(t *testing.T) {
	officialPermissions := []Permission{
		ReadOfficialAgents,
		ManageOfficialDrafts,
		ReviewOfficialAgents,
		ManageOfficialReleases,
		RequestOfficialRollback,
		ApproveOfficialRollback,
		ReadOfficialAgentAudit,
	}
	want := map[Role]map[Permission]bool{
		Developer: {
			ReadOfficialAgents: true, ManageOfficialDrafts: true,
		},
		SuperAdmin: {
			ReadOfficialAgents: true, ReviewOfficialAgents: true,
			ApproveOfficialRollback: true, ReadOfficialAgentAudit: true,
		},
		Operator: {
			ReadOfficialAgents: true, ManageOfficialReleases: true, RequestOfficialRollback: true,
		},
		Auditor: {
			ReadOfficialAgents: true, ReadOfficialAgentAudit: true,
		},
		Support: {},
		Finance: {},
	}
	for role, permissions := range want {
		for _, permission := range officialPermissions {
			if got := Allowed(role, permission); got != permissions[permission] {
				t.Errorf("Allowed(%s, %s) = %v, want %v", role, permission, got, permissions[permission])
			}
			if !permission.Valid() {
				t.Errorf("official permission %q is not registered", permission)
			}
		}
	}
}
