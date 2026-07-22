package cloudcontrol

import (
	"bytes"
	"context"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/bignormal/aera-admin/internal/admin"
	"github.com/bignormal/aera-admin/internal/approval"
	"github.com/bignormal/aera-admin/internal/auth"
	"github.com/bignormal/aera-admin/internal/cloudadmin"
	"github.com/bignormal/aera-admin/internal/operations"
	"github.com/bignormal/aera-admin/internal/rbac"
	"github.com/google/uuid"
)

func TestCloudRoutesEnforceFixedRBACAtTheAPI(t *testing.T) {
	service := &handlerStub{}
	handler := NewHandler(service)
	cases := []struct {
		role   rbac.Role
		method string
		path   string
		body   string
		want   int
	}{
		{rbac.Support, http.MethodPost, "/cloud-users/lookup", `{"type":"email","value":"alice@example.test"}`, http.StatusOK},
		{rbac.Developer, http.MethodPost, "/cloud-users/lookup", `{"type":"email","value":"alice@example.test"}`, http.StatusForbidden},
		{rbac.Support, http.MethodPost, "/approval-requests", `{}`, http.StatusForbidden},
		{rbac.Operator, http.MethodPost, "/approval-requests", validApprovalJSON(), http.StatusCreated},
		{rbac.Operator, http.MethodPost, "/approval-requests/019f0000-0000-7000-8000-000000000041/approve", `{}`, http.StatusForbidden},
		{rbac.SuperAdmin, http.MethodPost, "/approval-requests/019f0000-0000-7000-8000-000000000041/approve", `{}`, http.StatusAccepted},
		{rbac.Finance, http.MethodGet, "/cloud-users", "", http.StatusForbidden},
	}
	for _, item := range cases {
		t.Run(string(item.role)+item.method+item.path, func(t *testing.T) {
			request := httptest.NewRequest(item.method, item.path, strings.NewReader(item.body))
			request.Header.Set("Content-Type", "application/json")
			request.Header.Set("Idempotency-Key", "019f0000-0000-7000-8000-000000000042")
			request = auth.WithPrincipal(request, testPrincipal(item.role, true))
			response := httptest.NewRecorder()
			handler.ServeHTTP(response, request)
			if response.Code != item.want {
				t.Fatalf("status/body = %d %q", response.Code, response.Body.String())
			}
		})
	}
}

func TestExactLookupDoesNotEchoOrLogRawIdentity(t *testing.T) {
	rawIdentity := "lookup.canary@example.test"
	service := &handlerStub{lookupResult: maskedUser()}
	var logs bytes.Buffer
	handler := NewHandlerWithLogger(service, slog.New(slog.NewJSONHandler(&logs, nil)))
	request := httptest.NewRequest(http.MethodPost, "/cloud-users/lookup", strings.NewReader(
		`{"type":"email","value":"`+rawIdentity+`"}`,
	))
	request.Header.Set("Content-Type", "application/json")
	request = auth.WithPrincipal(request, testPrincipal(rbac.Support, false))
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusOK {
		t.Fatalf("status/body = %d %q", response.Code, response.Body.String())
	}
	if strings.Contains(response.Body.String(), rawIdentity) || strings.Contains(logs.String(), rawIdentity) {
		t.Fatal("raw lookup identity escaped the one-request boundary")
	}
	if service.observedLookup.Value != rawIdentity {
		t.Fatal("service did not receive exact lookup value")
	}
}

func TestEveryCloudRouteHasFixedSixRoleMatrix(t *testing.T) {
	allRoles := []rbac.Role{rbac.SuperAdmin, rbac.Developer, rbac.Operator, rbac.Support, rbac.Finance, rbac.Auditor}
	allowed := func(roles ...rbac.Role) map[rbac.Role]bool {
		result := make(map[rbac.Role]bool, len(roles))
		for _, role := range roles {
			result[role] = true
		}
		return result
	}
	cases := []struct {
		method  string
		path    string
		body    string
		success int
		allowed map[rbac.Role]bool
	}{
		{http.MethodGet, "/cloud-users?limit=50", "", 200, allowed(rbac.SuperAdmin, rbac.Operator, rbac.Support)},
		{http.MethodPost, "/cloud-users/lookup", `{"type":"email","value":"matrix@example.test"}`, 200, allowed(rbac.SuperAdmin, rbac.Operator, rbac.Support)},
		{http.MethodGet, "/cloud-users/019f0000-0000-7000-8000-000000000043", "", 200, allowed(rbac.SuperAdmin, rbac.Developer, rbac.Operator, rbac.Support)},
		{http.MethodGet, "/cloud-users/019f0000-0000-7000-8000-000000000043/devices?limit=50", "", 200, allowed(rbac.SuperAdmin, rbac.Developer, rbac.Operator, rbac.Support)},
		{http.MethodGet, "/cloud-users/019f0000-0000-7000-8000-000000000043/sessions?limit=50", "", 200, allowed(rbac.SuperAdmin, rbac.Developer, rbac.Operator, rbac.Support)},
		{http.MethodPost, "/cloud-devices/019f0000-0000-7000-8000-000000000044/revoke", `{"expected_revision":1,"reason_code":"lost_device","ticket_reference":"","note":""}`, 202, allowed(rbac.SuperAdmin, rbac.Operator, rbac.Support)},
		{http.MethodPost, "/cloud-sessions/019f0000-0000-7000-8000-000000000045/revoke", `{"expected_revision":1,"reason_code":"session_cleanup","ticket_reference":"","note":""}`, 202, allowed(rbac.SuperAdmin, rbac.Operator, rbac.Support)},
		{http.MethodPost, "/approval-requests", validApprovalJSON(), 201, allowed(rbac.Operator)},
		{http.MethodGet, "/approval-requests?view=all&limit=50", "", 200, allowed(rbac.SuperAdmin, rbac.Operator)},
		{http.MethodGet, "/approval-requests/019f0000-0000-7000-8000-000000000046", "", 200, allowed(rbac.SuperAdmin, rbac.Operator)},
		{http.MethodPost, "/approval-requests/019f0000-0000-7000-8000-000000000046/approve", `{}`, 202, allowed(rbac.SuperAdmin)},
		{http.MethodPost, "/approval-requests/019f0000-0000-7000-8000-000000000046/reject", `{}`, 200, allowed(rbac.SuperAdmin)},
		{http.MethodPost, "/approval-requests/019f0000-0000-7000-8000-000000000046/cancel", `{}`, 200, allowed(rbac.Operator)},
		{http.MethodGet, "/operations/019f0000-0000-7000-8000-000000000047", "", 200, allowed(rbac.SuperAdmin, rbac.Developer, rbac.Operator, rbac.Support, rbac.Auditor)},
		{http.MethodGet, "/system/health", "", 200, allowed(rbac.SuperAdmin, rbac.Developer, rbac.Operator, rbac.Auditor)},
	}
	handler := NewHandler(&handlerStub{})
	for _, route := range cases {
		for _, role := range allRoles {
			t.Run(string(role)+" "+route.method+" "+route.path, func(t *testing.T) {
				request := httptest.NewRequest(route.method, route.path, strings.NewReader(route.body))
				if route.method == http.MethodPost {
					request.Header.Set("Content-Type", "application/json")
					request.Header.Set("Idempotency-Key", uuid.NewString())
				}
				request = auth.WithPrincipal(request, testPrincipal(role, true))
				response := httptest.NewRecorder()
				handler.ServeHTTP(response, request)
				want := http.StatusForbidden
				if route.allowed[role] {
					want = route.success
				}
				if response.Code != want {
					t.Fatalf("status/body = %d %q, want %d", response.Code, response.Body.String(), want)
				}
			})
		}
	}
}

type handlerStub struct {
	lookupResult   cloudadmin.User
	observedLookup cloudadmin.LookupRequest
}

func (stub *handlerStub) ListUsers(context.Context, admin.Actor, cloudadmin.ListUsersRequest) (cloudadmin.Page[cloudadmin.User], error) {
	return cloudadmin.Page[cloudadmin.User]{Items: []cloudadmin.User{}}, nil
}

func (stub *handlerStub) LookupUser(_ context.Context, _ admin.Actor, input cloudadmin.LookupRequest) (cloudadmin.User, error) {
	stub.observedLookup = input
	if stub.lookupResult.ID == uuid.Nil {
		return maskedUser(), nil
	}
	return stub.lookupResult, nil
}

func (stub *handlerStub) GetUser(context.Context, admin.Actor, uuid.UUID) (cloudadmin.User, error) {
	return maskedUser(), nil
}

func (stub *handlerStub) ListDevices(context.Context, admin.Actor, uuid.UUID, cloudadmin.PageRequest) (cloudadmin.Page[cloudadmin.Device], error) {
	return cloudadmin.Page[cloudadmin.Device]{Items: []cloudadmin.Device{}}, nil
}

func (stub *handlerStub) ListSessions(context.Context, admin.Actor, uuid.UUID, cloudadmin.PageRequest) (cloudadmin.Page[cloudadmin.Session], error) {
	return cloudadmin.Page[cloudadmin.Session]{Items: []cloudadmin.Session{}}, nil
}

func (stub *handlerStub) RevokeDevice(context.Context, admin.Actor, uuid.UUID, int64, admin.ActionReason, string) (operations.Result, error) {
	return operations.Result{OperationID: uuid.New(), State: operations.StateQueued, UpdatedAt: testNow()}, nil
}

func (stub *handlerStub) RevokeSession(context.Context, admin.Actor, uuid.UUID, int64, admin.ActionReason, string) (operations.Result, error) {
	return operations.Result{OperationID: uuid.New(), State: operations.StateQueued, UpdatedAt: testNow()}, nil
}

func (stub *handlerStub) CreateApproval(_ context.Context, input approval.CreateRequest) (approval.Request, error) {
	return approval.Request{
		ID: uuid.New(), Action: input.Action, TargetUserID: input.TargetUserID,
		Status: approval.PendingReview, ExecutionStatus: approval.NotStarted,
		CreatedAt: testNow(), UpdatedAt: testNow(), ExpiresAt: testNow().Add(24 * time.Hour), Version: 1,
	}, nil
}

func (stub *handlerStub) ListApprovals(context.Context, admin.Actor, approval.ListFilter) (approval.Page, error) {
	return approval.Page{Items: []approval.Request{}}, nil
}

func (stub *handlerStub) GetApproval(context.Context, admin.Actor, uuid.UUID) (approval.Request, error) {
	return approval.Request{ID: uuid.New()}, nil
}

func (stub *handlerStub) ApproveApproval(context.Context, admin.Actor, uuid.UUID, string) (approval.Request, error) {
	operationID := uuid.New()
	return approval.Request{ID: uuid.New(), Status: approval.Approved, ExecutionStatus: approval.Queued, OperationID: &operationID}, nil
}

func (stub *handlerStub) RejectApproval(context.Context, admin.Actor, uuid.UUID) (approval.Request, error) {
	return approval.Request{ID: uuid.New(), Status: approval.Rejected}, nil
}

func (stub *handlerStub) CancelApproval(context.Context, admin.Actor, uuid.UUID) (approval.Request, error) {
	return approval.Request{ID: uuid.New(), Status: approval.Cancelled}, nil
}

func (stub *handlerStub) GetOperation(context.Context, admin.Actor, uuid.UUID) (operations.Result, error) {
	return operations.Result{OperationID: uuid.New(), State: operations.StateQueued, UpdatedAt: testNow()}, nil
}

func (stub *handlerStub) Health(context.Context, admin.Actor) (HealthDocument, error) {
	return HealthDocument{
		Admin: "ok", PostgreSQL: "ok", Redis: "ok",
		Cloud: cloudadmin.Health{Configured: true, Availability: cloudadmin.Available, CheckedAt: testNow()},
	}, nil
}

func testNow() time.Time {
	return time.Date(2026, 7, 22, 8, 0, 0, 0, time.UTC)
}

func testPrincipal(role rbac.Role, recentTOTP bool) auth.Principal {
	now := time.Now().UTC()
	principal := auth.Principal{
		AdminID: uuid.NewString(), SessionID: uuid.NewString(), Role: role, SecurityVersion: 1,
		MFAAuthenticatedAt: now, MFAMethod: auth.MFAMethodTOTP,
	}
	if recentTOTP {
		principal.TOTPAuthenticatedAt = &now
	}
	return principal
}

func maskedUser() cloudadmin.User {
	return cloudadmin.User{
		ID:          uuid.MustParse("019f0000-0000-7000-8000-000000000043"),
		MaskedEmail: "a***@example.test", Status: cloudadmin.UserActive,
		AdministrativeRevision: 1, CreatedAt: testNow(),
	}
}

func validApprovalJSON() string {
	return `{"action":"disable_user","target_user_id":"019f0000-0000-7000-8000-000000000043","reason_code":"policy_violation","ticket_reference":"SEC-42","note":""}`
}
