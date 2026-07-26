package rbacadmin

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/bignormal/aera-admin/internal/audit"
	"github.com/bignormal/aera-admin/internal/rbac"
	"github.com/google/uuid"
)

type fakeStore struct {
	roles map[string]Role
}

func newFakeStore() *fakeStore {
	return &fakeStore{roles: map[string]Role{
		"super_admin": {
			Slug: "super_admin", Name: "超级管理员", IsSystem: true,
			Permissions: []rbac.Permission{rbac.ManageAdministrators, rbac.ReadAdministrators},
		},
	}}
}

func (store *fakeStore) LoadMatrix(context.Context) ([]rbac.Role, map[rbac.Role][]rbac.Permission, error) {
	roles := make([]rbac.Role, 0, len(store.roles))
	perms := make(map[rbac.Role][]rbac.Permission, len(store.roles))
	for slug, role := range store.roles {
		roles = append(roles, rbac.Role(slug))
		perms[rbac.Role(slug)] = append([]rbac.Permission(nil), role.Permissions...)
	}
	return roles, perms, nil
}

func (store *fakeStore) List(context.Context) ([]Role, error) {
	out := make([]Role, 0, len(store.roles))
	for _, role := range store.roles {
		out = append(out, role)
	}
	return out, nil
}

func (store *fakeStore) Get(_ context.Context, slug string) (Role, error) {
	role, ok := store.roles[slug]
	if !ok {
		return Role{}, ErrRoleNotFound
	}
	return role, nil
}

func (store *fakeStore) Create(_ context.Context, slug, name, description string, permissions []rbac.Permission, _ time.Time) error {
	if _, ok := store.roles[slug]; ok {
		return ErrRoleExists
	}
	store.roles[slug] = Role{Slug: slug, Name: name, Description: description, Permissions: permissions}
	return nil
}

func (store *fakeStore) Update(_ context.Context, slug string, name, description *string, permissions *[]rbac.Permission, _ time.Time) error {
	role, ok := store.roles[slug]
	if !ok {
		return ErrRoleNotFound
	}
	if name != nil {
		role.Name = *name
	}
	if description != nil {
		role.Description = *description
	}
	if permissions != nil {
		role.Permissions = *permissions
	}
	store.roles[slug] = role
	return nil
}

func (store *fakeStore) Delete(_ context.Context, slug string) error {
	if _, ok := store.roles[slug]; !ok {
		return ErrRoleNotFound
	}
	delete(store.roles, slug)
	return nil
}

type fakeAudit struct{ count int }

func (recorder *fakeAudit) Append(context.Context, audit.Record) (uuid.UUID, error) {
	recorder.count++
	return uuid.New(), nil
}

func newTestService(t *testing.T) (*Service, *fakeStore) {
	t.Helper()
	store := newFakeStore()
	service, err := NewService(ServiceConfig{Store: store, Audit: &fakeAudit{}, Clock: func() time.Time { return time.Unix(0, 0).UTC() }})
	if err != nil {
		t.Fatalf("NewService() error = %v", err)
	}
	if err := service.Refresh(context.Background()); err != nil {
		t.Fatalf("Refresh() error = %v", err)
	}
	return service, store
}

func testActor() MutationContext {
	return MutationContext{ActorAdminID: uuid.NewString(), ActorRole: rbac.SuperAdmin, RequestID: "req-" + uuid.NewString()}
}

func TestCreateRolePersistsAndRefreshesMatrix(t *testing.T) {
	service, store := newTestService(t)
	role, err := service.CreateRole(context.Background(), testActor(), CreateRoleInput{
		Slug: "content_reviewer", Name: "内容审核员",
		Permissions: []string{"official_agent.read", "official_agent.review"},
	})
	if err != nil {
		t.Fatalf("CreateRole() error = %v", err)
	}
	if role.Slug != "content_reviewer" || len(role.Permissions) != 2 {
		t.Fatalf("CreateRole() = %+v", role)
	}
	if _, ok := store.roles["content_reviewer"]; !ok {
		t.Fatal("role was not persisted")
	}
	if !rbac.Allowed("content_reviewer", rbac.ReviewOfficialAgents) {
		t.Fatal("active matrix was not refreshed after create")
	}
}

func TestCreateRoleRejectsUnknownPermission(t *testing.T) {
	service, _ := newTestService(t)
	_, err := service.CreateRole(context.Background(), testActor(), CreateRoleInput{
		Slug: "broken", Name: "坏角色", Permissions: []string{"not.a.real.permission"},
	})
	if !errors.Is(err, ErrInvalidRequest) {
		t.Fatalf("CreateRole() error = %v, want ErrInvalidRequest", err)
	}
}

func TestCreateRoleRejectsInvalidSlug(t *testing.T) {
	service, _ := newTestService(t)
	_, err := service.CreateRole(context.Background(), testActor(), CreateRoleInput{Slug: "Bad Slug", Name: "x"})
	if !errors.Is(err, ErrInvalidRequest) {
		t.Fatalf("CreateRole() error = %v, want ErrInvalidRequest", err)
	}
}

func TestUpdateSuperAdminCannotDropManagePermission(t *testing.T) {
	service, _ := newTestService(t)
	perms := []string{"administrator.read"}
	_, err := service.UpdateRole(context.Background(), testActor(), "super_admin", UpdateRoleInput{Permissions: &perms})
	if !errors.Is(err, ErrProtectedPermission) {
		t.Fatalf("UpdateRole() error = %v, want ErrProtectedPermission", err)
	}
}

func TestDeleteSystemRoleRejected(t *testing.T) {
	service, _ := newTestService(t)
	err := service.DeleteRole(context.Background(), testActor(), "super_admin")
	if !errors.Is(err, ErrSystemRole) {
		t.Fatalf("DeleteRole() error = %v, want ErrSystemRole", err)
	}
}

func TestDeleteCustomRoleSucceeds(t *testing.T) {
	service, store := newTestService(t)
	actor := testActor()
	if _, err := service.CreateRole(context.Background(), actor, CreateRoleInput{Slug: "temp_role", Name: "临时"}); err != nil {
		t.Fatalf("CreateRole() error = %v", err)
	}
	if err := service.DeleteRole(context.Background(), actor, "temp_role"); err != nil {
		t.Fatalf("DeleteRole() error = %v", err)
	}
	if _, ok := store.roles["temp_role"]; ok {
		t.Fatal("custom role was not deleted")
	}
}
