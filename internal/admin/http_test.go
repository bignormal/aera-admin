package admin

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
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
	if fake.inviteCalls != 1 || fake.lastInvite.Email != "Admin@Example.com" || fake.lastInvite.Reason.Meta.RequestID == "req-http-test" ||
		!strings.HasPrefix(fake.lastInvite.Reason.Meta.RequestID, "req-") {
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

func TestAdministratorMutationRequiresRecentTOTP(t *testing.T) {
	fake := &fakeHandlerService{invitation: InvitationResult{InvitationID: uuid.New(), AdminID: uuid.New(), ActivationURL: "https://admin.example.test/activate#token=one-time-token"}}
	handler := NewHandler(fake)
	stale := principal(uuid.New(), rbac.SuperAdmin)
	stale.MFAAuthenticatedAt = time.Now().Add(-11 * time.Minute)
	stale.TOTPAuthenticatedAt = timePointer(time.Now().Add(-11 * time.Minute))
	response := serveAdminHTTP(
		handler,
		http.MethodPost,
		"/admin-users/invitations",
		`{"email":"admin@example.com","display_name":"管理员","role":"support","reason_code":"staff_change"}`,
		stale,
	)
	if response.Code != http.StatusForbidden || fake.inviteCalls != 0 || !strings.Contains(response.Body.String(), `"code":"STEP_UP_REQUIRED"`) {
		t.Fatalf("stale mutation response/calls = %d/%d %q", response.Code, fake.inviteCalls, response.Body.String())
	}
}

func TestRevokeAdministratorSessionsHTTPRequiresManagementPermission(t *testing.T) {
	fake := &fakeHandlerService{}
	handler := NewHandler(fake)
	targetID := uuid.New()
	body := `{"reason_code":"suspected_compromise","ticket_reference":"SEC-42","note":"approved session revocation"}`

	denied := serveAdminHTTP(handler, http.MethodPost, "/admin-users/"+targetID.String()+"/sessions/revoke", body, principal(uuid.New(), rbac.Support))
	if denied.Code != http.StatusForbidden || fake.revokeCalls != 0 {
		t.Fatalf("support revoke response/calls = %d/%d", denied.Code, fake.revokeCalls)
	}

	response := serveAdminHTTP(handler, http.MethodPost, "/admin-users/"+targetID.String()+"/sessions/revoke", body, principal(uuid.New(), rbac.SuperAdmin))
	if response.Code != http.StatusOK || fake.revokeCalls != 1 || !strings.Contains(response.Body.String(), `"status":"ok"`) {
		t.Fatalf("session revoke response/calls = %d/%d %q", response.Code, fake.revokeCalls, response.Body.String())
	}
	assertNoStoreJSON(t, response)
}

func timePointer(value time.Time) *time.Time {
	return &value
}

func TestActivationHTTPAppliesDigestBasedRateLimitBeforeService(t *testing.T) {
	fake := &fakeHandlerService{}
	limiter := &fakeActivationLimiter{reserveErr: &auth.RateLimitError{RetryAfter: 2 * time.Second}}
	handler := NewHandlerWithActivationLimiter(fake, limiter)
	response := serveAdminHTTP(handler, http.MethodPost, "/auth/activation/prepare", `{"token":"raw-invitation-token"}`, nil)
	if response.Code != http.StatusTooManyRequests || response.Header().Get("Retry-After") != "2" || fake.prepareToken != "" {
		t.Fatalf("rate-limited activation response/token = %d %q / %q", response.Code, response.Body.String(), fake.prepareToken)
	}
	if len(limiter.subjectDigest) != 32 || bytes.Contains(limiter.subjectDigest, []byte("raw-invitation-token")) {
		t.Fatalf("activation limiter received non-digest subject: %x", limiter.subjectDigest)
	}
}

func TestActivationReservationsReleaseValidPrepareAndCompleteActivation(t *testing.T) {
	for name, path := range map[string]string{
		"prepare":  "/auth/activation/prepare",
		"activate": "/auth/activate",
	} {
		t.Run(name, func(t *testing.T) {
			fake := &fakeHandlerService{}
			limiter := &fakeActivationLimiter{reservationID: "reservation-1"}
			handler := NewHandlerWithActivationLimiter(fake, limiter)
			body := `{"token":"raw-invitation-token"}`
			if path == "/auth/activate" {
				body = `{"token":"raw-invitation-token","password":"correct horse battery staple","totp_code":"123456"}`
			}

			response := serveAdminHTTP(handler, http.MethodPost, path, body, nil)
			if response.Code != http.StatusOK {
				t.Fatalf("response = %d %q", response.Code, response.Body.String())
			}
			if limiter.reserveCalls != 1 {
				t.Fatalf("reserve calls = %d, want 1", limiter.reserveCalls)
			}
			if path == "/auth/activation/prepare" && (limiter.releaseCalls != 1 || limiter.completeCalls != 0) {
				t.Fatalf("prepare finish calls = release:%d complete:%d", limiter.releaseCalls, limiter.completeCalls)
			}
			if path == "/auth/activate" && (limiter.releaseCalls != 0 || limiter.completeCalls != 1) {
				t.Fatalf("activation finish calls = release:%d complete:%d", limiter.releaseCalls, limiter.completeCalls)
			}
		})
	}
}

func TestActivationInfrastructureFailureReleasesReservationButCredentialFailureDoesNot(t *testing.T) {
	for name, domainErr := range map[string]error{
		"infrastructure": auth.ErrUnavailable,
		"credential":     ErrInvalidInvitation,
	} {
		t.Run(name, func(t *testing.T) {
			fake := &fakeHandlerService{err: domainErr}
			limiter := &fakeActivationLimiter{reservationID: "reservation-1"}
			handler := NewHandlerWithActivationLimiter(fake, limiter)
			_ = serveAdminHTTP(handler, http.MethodPost, "/auth/activation/prepare", `{"token":"raw-invitation-token"}`, nil)
			if limiter.reserveCalls != 1 {
				t.Fatalf("reserve calls = %d, want 1", limiter.reserveCalls)
			}
			wantRelease := 0
			if errors.Is(domainErr, auth.ErrUnavailable) {
				wantRelease = 1
			}
			if limiter.releaseCalls != wantRelease {
				t.Fatalf("release calls = %d, want %d", limiter.releaseCalls, wantRelease)
			}
		})
	}
}

type fakeHandlerService struct {
	invitation     InvitationResult
	preparation    ActivationPreparation
	activation     ActivationResult
	administrators []Administrator
	err            error
	inviteCalls    int
	revokeCalls    int
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

func (fake *fakeHandlerService) RevokeSessions(context.Context, Actor, uuid.UUID, ActionReason) error {
	fake.revokeCalls++
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
	now := time.Now()
	return &auth.Principal{
		AdminID: id.String(), SessionID: uuid.NewString(), Role: role, SecurityVersion: 1,
		MFAMethod: auth.MFAMethodTOTP, MFAAuthenticatedAt: now, TOTPAuthenticatedAt: &now,
	}
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

type fakeActivationLimiter struct {
	reservationID string
	reserveErr    error
	reserveCalls  int
	releaseCalls  int
	completeCalls int
	subjectDigest []byte
}

func (fake *fakeActivationLimiter) ReserveActivationAttempt(_ context.Context, subjectDigest, _ []byte) (string, error) {
	fake.reserveCalls++
	fake.subjectDigest = append([]byte(nil), subjectDigest...)
	return fake.reservationID, fake.reserveErr
}

func (fake *fakeActivationLimiter) ReleaseActivationAttempt(context.Context, string, []byte, []byte) error {
	fake.releaseCalls++
	return nil
}

func (fake *fakeActivationLimiter) CompleteActivationAttempt(context.Context, string, []byte, []byte) error {
	fake.completeCalls++
	return nil
}

var _ ActivationAttemptLimiter = (*fakeActivationLimiter)(nil)
