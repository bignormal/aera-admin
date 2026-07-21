package admin

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/bignormal/aera-admin/internal/auth"
	"github.com/bignormal/aera-admin/internal/rbac"
	"github.com/google/uuid"
)

func TestInvitationHTTPRequiresPermissionAndNeverEchoesRawIdentity(t *testing.T) {
	adminID := uuid.New()
	fake := &fakeHandlerService{invitation: InvitationResult{
		InvitationID: uuid.New(), AdminID: adminID,
		ActivationURL: "https://admin.example.test/activate#token=one-time-token",
		ExpiresAt:     time.Date(2026, 7, 22, 0, 0, 0, 0, time.UTC),
	}}
	handler := NewHandler(fake)
	body := `{"email":"Admin@Example.com","display_name":"客服人员","role":"support","reason_code":"staff_change","ticket_reference":"SUP-42","note":"approved staffing change"}`

	denied := serveAdminHTTP(handler, http.MethodPost, "/admin-users/invitations", body, principal(uuid.New(), rbac.Support))
	if denied.Code != http.StatusForbidden || fake.inviteCalls != 0 {
		t.Fatalf("support invitation response/calls = %d/%d", denied.Code, fake.inviteCalls)
	}

	response := serveAdminHTTP(handler, http.MethodPost, "/admin-users/invitations", body, principal(uuid.New(), rbac.SuperAdmin))
	if response.Code != http.StatusCreated {
		t.Fatalf("invitation status = %d, body = %q", response.Code, response.Body.String())
	}
	if bytes.Contains(response.Body.Bytes(), []byte("Admin@Example.com")) || bytes.Contains(response.Body.Bytes(), []byte("admin@example.com")) {
		t.Fatalf("invitation response leaked raw identity: %s", response.Body.String())
	}
	if fake.inviteCalls != 1 || fake.lastInvite.Email != "Admin@Example.com" || fake.lastInvite.Reason.Meta.RequestID != "req-http-test" {
		t.Fatalf("captured invitation = %+v, calls = %d", fake.lastInvite, fake.inviteCalls)
	}
	assertNoStoreJSON(t, response)
}

func TestActivationHTTPUsesJSONTokenAndReturnsOneTimeSecurityMaterial(t *testing.T) {
	adminID := uuid.New()
	fake := &fakeHandlerService{
		preparation: ActivationPreparation{
			AdminID: adminID, DisplayName: "管理员", MaskedIdentity: "a***@example.com",
			Purpose: InvitationPurposeActivation, ProvisioningURI: "otpauth://totp/Aera%20Admin:a%2A%2A%2A@example.com?secret=MASKED",
			ExpiresAt: time.Now().Add(time.Hour),
		},
		activation: ActivationResult{AdminID: adminID, RecoveryCodes: []string{"recovery-one", "recovery-two"}},
	}
	handler := NewHandler(fake)
	prepare := serveAdminHTTP(handler, http.MethodPost, "/auth/activation/prepare", `{"token":"raw-invitation-token"}`, nil)
	if prepare.Code != http.StatusOK || fake.prepareToken != "raw-invitation-token" {
		t.Fatalf("prepare response/token = %d/%q, body=%q", prepare.Code, fake.prepareToken, prepare.Body.String())
	}
	if strings.Contains(prepare.Body.String(), "admin@example.com") {
		t.Fatalf("prepare response leaked raw identity: %s", prepare.Body.String())
	}
	assertNoStoreJSON(t, prepare)

	activateBody := `{"token":"raw-invitation-token","password":"correct horse battery staple","totp_code":"123456"}`
	activate := serveAdminHTTP(handler, http.MethodPost, "/auth/activate", activateBody, nil)
	if activate.Code != http.StatusOK || fake.lastActivation.Token != "raw-invitation-token" || fake.lastActivation.Password != "correct horse battery staple" {
		t.Fatalf("activate response/request = %d/%+v", activate.Code, fake.lastActivation)
	}
	if !strings.Contains(activate.Body.String(), "recovery-one") || strings.Contains(activate.Body.String(), "correct horse battery staple") || strings.Contains(activate.Body.String(), "123456") {
		t.Fatalf("activation response has wrong security material: %s", activate.Body.String())
	}
	assertNoStoreJSON(t, activate)
}

func TestAdministratorHTTPRejectsUnknownFieldsWithoutEchoingSecrets(t *testing.T) {
	handler := NewHandler(&fakeHandlerService{})
	body := `{"token":"raw-secret-token","password":"correct horse battery staple","totp_code":"123456","unexpected":"admin@example.com"}`
	response := serveAdminHTTP(handler, http.MethodPost, "/auth/activate", body, nil)
	if response.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, body = %q", response.Code, response.Body.String())
	}
	for _, secret := range []string{"raw-secret-token", "correct horse battery staple", "123456", "admin@example.com"} {
		if strings.Contains(response.Body.String(), secret) {
			t.Fatalf("error response leaked %q: %s", secret, response.Body.String())
		}
	}
	assertNoStoreJSON(t, response)
}

func TestAdministratorHTTPMapsStableDomainErrors(t *testing.T) {
	fake := &fakeHandlerService{err: ErrMinimumSuperAdmins}
	handler := NewHandler(fake)
	targetID := uuid.New()
	response := serveAdminHTTP(
		handler,
		http.MethodPut,
		"/admin-users/"+targetID.String()+"/role",
		`{"role":"operator","reason_code":"staff_change","ticket_reference":"SUP-42","note":"approved staffing change"}`,
		principal(uuid.New(), rbac.SuperAdmin),
	)
	if response.Code != http.StatusConflict || !strings.Contains(response.Body.String(), `"code":"MINIMUM_SUPER_ADMINS_REQUIRED"`) {
		t.Fatalf("response = %d %q", response.Code, response.Body.String())
	}
	assertNoStoreJSON(t, response)
}

type fakeHandlerService struct {
	invitation     InvitationResult
	preparation    ActivationPreparation
	activation     ActivationResult
	administrators []Administrator
	err            error
	inviteCalls    int
	lastInvite     InviteRequest
	prepareToken   string
	lastActivation ActivateRequest
}

func (fake *fakeHandlerService) Invite(_ context.Context, _ Actor, request InviteRequest) (InvitationResult, error) {
	fake.inviteCalls++
	fake.lastInvite = request
	return fake.invitation, fake.err
}

func (fake *fakeHandlerService) PrepareActivation(_ context.Context, token string) (ActivationPreparation, error) {
	fake.prepareToken = token
	return fake.preparation, fake.err
}

func (fake *fakeHandlerService) Activate(_ context.Context, request ActivateRequest) (ActivationResult, error) {
	fake.lastActivation = request
	return fake.activation, fake.err
}

func (fake *fakeHandlerService) List(context.Context, Actor) ([]Administrator, error) {
	return fake.administrators, fake.err
}

func (fake *fakeHandlerService) ChangeRole(context.Context, Actor, uuid.UUID, rbac.Role, ActionReason) error {
	return fake.err
}

func (fake *fakeHandlerService) Suspend(context.Context, Actor, uuid.UUID, ActionReason) error {
	return fake.err
}

func (fake *fakeHandlerService) ResetTOTP(context.Context, Actor, uuid.UUID, ActionReason) (InvitationResult, error) {
	return fake.invitation, fake.err
}

func serveAdminHTTP(handler http.Handler, method, path, body string, authPrincipal *auth.Principal) *httptest.ResponseRecorder {
	request := httptest.NewRequest(method, path, strings.NewReader(body))
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("X-Request-ID", "req-http-test")
	request.Header.Set("User-Agent", "AdminBrowser/1.0")
	if authPrincipal != nil {
		request = auth.WithPrincipal(request, *authPrincipal)
	}
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	return response
}

func principal(id uuid.UUID, role rbac.Role) *auth.Principal {
	return &auth.Principal{AdminID: id.String(), SessionID: uuid.NewString(), Role: role, SecurityVersion: 1}
}

func assertNoStoreJSON(t *testing.T, response *httptest.ResponseRecorder) {
	t.Helper()
	if response.Header().Get("Cache-Control") != "no-store" || response.Header().Get("Content-Type") != "application/json" {
		t.Fatalf("security headers = Cache-Control:%q Content-Type:%q", response.Header().Get("Cache-Control"), response.Header().Get("Content-Type"))
	}
	var document any
	if err := json.Unmarshal(response.Body.Bytes(), &document); err != nil {
		t.Fatalf("response is not JSON: %q, error=%v", response.Body.String(), err)
	}
}

var _ HandlerService = (*fakeHandlerService)(nil)
