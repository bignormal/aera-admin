package settings

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

func TestHTTPSettingsReadUsesFixedRBACScope(t *testing.T) {
	now := time.Date(2026, 7, 22, 8, 0, 0, 0, time.UTC)
	fake := &fakeHTTPService{policy: Policy{
		SessionIdleMinutes: 30, SessionAbsoluteHours: 12, AuditRetentionDays: 730,
		Revision: 4, UpdatedAt: now,
	}}
	handler := NewHandlerWithClock(fake, func() time.Time { return now })

	for _, role := range []rbac.Role{rbac.SuperAdmin, rbac.Auditor} {
		response := serveSettingsHTTP(handler, http.MethodGet, "/system/settings", "", settingsHTTPPrincipal(uuid.New(), role, now))
		if response.Code != http.StatusOK {
			t.Fatalf("%s settings status = %d, body=%q", role, response.Code, response.Body.String())
		}
		assertSettingsJSON(t, response)
	}
	for _, role := range []rbac.Role{rbac.Developer, rbac.Operator, rbac.Support, rbac.Finance} {
		response := serveSettingsHTTP(handler, http.MethodGet, "/system/settings", "", settingsHTTPPrincipal(uuid.New(), role, now))
		if response.Code != http.StatusForbidden || !strings.Contains(response.Body.String(), `"code":"PERMISSION_DENIED"`) {
			t.Fatalf("%s settings response = %d %q", role, response.Code, response.Body.String())
		}
	}
	if fake.policyCalls != 2 {
		t.Fatalf("GetPolicy calls = %d, want 2", fake.policyCalls)
	}
}

func TestHTTPActiveReasonLookupIsAvailableToEveryAuthenticatedRole(t *testing.T) {
	now := time.Date(2026, 7, 22, 8, 0, 0, 0, time.UTC)
	fake := &fakeHTTPService{page: Page{Items: []ReasonCode{{
		Code: "security_review", Category: CategorySecurity, Label: "安全复核", Active: true,
		Revision: 1, CreatedAt: now, UpdatedAt: now,
	}}, SettingsRevision: 4}}
	handler := NewHandlerWithClock(fake, func() time.Time { return now })

	for _, role := range rbac.Roles() {
		response := serveSettingsHTTP(handler, http.MethodGet, "/system/reason-codes?usage=session", "", settingsHTTPPrincipal(uuid.New(), role, now))
		if response.Code != http.StatusOK {
			t.Fatalf("%s active reason response = %d %q", role, response.Code, response.Body.String())
		}
	}
	if fake.reasonCalls != len(rbac.Roles()) || fake.lastQuery != (ReasonQuery{Usage: UsageSession}) {
		t.Fatalf("reason calls/query = %d/%+v", fake.reasonCalls, fake.lastQuery)
	}
}

func TestHTTPReasonCatalogDetailsRequireSettingsReadPermission(t *testing.T) {
	now := time.Date(2026, 7, 22, 8, 0, 0, 0, time.UTC)
	fake := &fakeHTTPService{page: Page{Items: []ReasonCode{}, SettingsRevision: 4}}
	handler := NewHandlerWithClock(fake, func() time.Time { return now })

	for _, path := range []string{
		"/system/reason-codes?include_inactive=true",
		"/system/reason-codes?category=security",
		"/system/reason-codes",
	} {
		response := serveSettingsHTTP(handler, http.MethodGet, path, "", settingsHTTPPrincipal(uuid.New(), rbac.Support, now))
		if response.Code != http.StatusForbidden || fake.reasonCalls != 0 {
			t.Fatalf("restricted catalog %s response/calls = %d/%d", path, response.Code, fake.reasonCalls)
		}
	}
	response := serveSettingsHTTP(handler, http.MethodGet, "/system/reason-codes?category=security&include_inactive=true", "", settingsHTTPPrincipal(uuid.New(), rbac.Auditor, now))
	if response.Code != http.StatusOK || fake.lastQuery != (ReasonQuery{Category: CategorySecurity, IncludeInactive: true}) {
		t.Fatalf("auditor catalog response/query = %d/%+v, body=%q", response.Code, fake.lastQuery, response.Body.String())
	}
}

func TestHTTPPolicyMutationRequiresSuperAdminRecentTOTPAndIdempotency(t *testing.T) {
	now := time.Date(2026, 7, 22, 8, 0, 0, 0, time.UTC)
	operationID := uuid.New()
	fake := &fakeHTTPService{policyResult: PolicyMutationResult{
		OperationID:     operationID,
		Policy:          Policy{SessionIdleMinutes: 20, SessionAbsoluteHours: 8, AuditRetentionDays: 900, Revision: 5, UpdatedAt: now},
		SessionsRevoked: true,
	}}
	handler := NewHandlerWithClock(fake, func() time.Time { return now })
	body := `{"expected_revision":4,"session_idle_minutes":20,"session_absolute_hours":8,"audit_retention_days":900,"reason_code":"security_policy_change","ticket_reference":"SEC-42","note":"approved policy update"}`

	denied := serveSettingsMutation(handler, http.MethodPut, "/system/settings/security-policy", body, settingsHTTPPrincipal(uuid.New(), rbac.Auditor, now), "settings-policy-0001")
	if denied.Code != http.StatusForbidden || fake.updatePolicyCalls != 0 {
		t.Fatalf("auditor mutation response/calls = %d/%d", denied.Code, fake.updatePolicyCalls)
	}
	stale := settingsHTTPPrincipal(uuid.New(), rbac.SuperAdmin, now.Add(-11*time.Minute))
	staleResponse := serveSettingsMutation(handler, http.MethodPut, "/system/settings/security-policy", body, stale, "settings-policy-0001")
	if staleResponse.Code != http.StatusForbidden || !strings.Contains(staleResponse.Body.String(), `"code":"STEP_UP_REQUIRED"`) || fake.updatePolicyCalls != 0 {
		t.Fatalf("stale mutation response/calls = %d/%d %q", staleResponse.Code, fake.updatePolicyCalls, staleResponse.Body.String())
	}
	missingKey := serveSettingsMutation(handler, http.MethodPut, "/system/settings/security-policy", body, settingsHTTPPrincipal(uuid.New(), rbac.SuperAdmin, now), "")
	if missingKey.Code != http.StatusBadRequest || !strings.Contains(missingKey.Body.String(), `"code":"INVALID_REQUEST"`) || fake.updatePolicyCalls != 0 {
		t.Fatalf("missing key response/calls = %d/%d %q", missingKey.Code, fake.updatePolicyCalls, missingKey.Body.String())
	}

	actorID := uuid.New()
	allowed := serveSettingsMutation(handler, http.MethodPut, "/system/settings/security-policy", body, settingsHTTPPrincipal(actorID, rbac.SuperAdmin, now), "settings-policy-0001")
	if allowed.Code != http.StatusOK || fake.updatePolicyCalls != 1 || fake.lastMutation.ActorAdminID != actorID ||
		fake.lastMutation.IdempotencyKey != "settings-policy-0001" || fake.lastMutation.RequestID != "req-settings-http" ||
		fake.lastPolicyInput.ExpectedRevision != 4 || !strings.Contains(allowed.Body.String(), operationID.String()) {
		t.Fatalf("allowed mutation response/capture = %d %+v %+v %q", allowed.Code, fake.lastMutation, fake.lastPolicyInput, allowed.Body.String())
	}
	assertSettingsJSON(t, allowed)
}

func TestHTTPReasonMutationsAreStrictAndRouteToService(t *testing.T) {
	now := time.Date(2026, 7, 22, 8, 0, 0, 0, time.UTC)
	fake := &fakeHTTPService{reasonResult: ReasonMutationResult{
		OperationID: uuid.New(), SettingsRevision: 5,
		Reason: ReasonCode{Code: "staff_transfer", Category: CategoryAdministrator, Label: "人员调动", Active: true, Revision: 1, CreatedAt: now, UpdatedAt: now},
	}}
	handler := NewHandlerWithClock(fake, func() time.Time { return now })
	principal := settingsHTTPPrincipal(uuid.New(), rbac.SuperAdmin, now)

	createBody := `{"code":"staff_transfer","category":"administrator","label":"人员调动","expected_settings_revision":4,"reason_code":"reason_catalog_change","ticket_reference":"SEC-43","note":"approved catalog change"}`
	created := serveSettingsMutation(handler, http.MethodPost, "/system/reason-codes", createBody, principal, "settings-reason-0001")
	if created.Code != http.StatusCreated || fake.createReasonCalls != 1 || fake.lastCreateInput.Code != "staff_transfer" {
		t.Fatalf("create response/capture = %d/%d %+v %q", created.Code, fake.createReasonCalls, fake.lastCreateInput, created.Body.String())
	}

	updateBody := `{"expected_settings_revision":5,"expected_reason_revision":1,"label":"人员调整","active":false,"reason_code":"reason_catalog_change","ticket_reference":"SEC-44","note":"approved catalog update"}`
	updated := serveSettingsMutation(handler, http.MethodPut, "/system/reason-codes/staff_transfer", updateBody, principal, "settings-reason-0002")
	if updated.Code != http.StatusOK || fake.updateReasonCalls != 1 || fake.lastReasonCode != "staff_transfer" || fake.lastUpdateInput.Active {
		t.Fatalf("update response/capture = %d/%d %q %+v", updated.Code, fake.updateReasonCalls, fake.lastReasonCode, fake.lastUpdateInput)
	}

	unknown := serveSettingsMutation(handler, http.MethodPost, "/system/reason-codes", createBody[:len(createBody)-1]+`,"unexpected":"secret@example.com"}`, principal, "settings-reason-0003")
	if unknown.Code != http.StatusBadRequest || fake.createReasonCalls != 1 || strings.Contains(unknown.Body.String(), "secret@example.com") {
		t.Fatalf("unknown field response/calls = %d/%d %q", unknown.Code, fake.createReasonCalls, unknown.Body.String())
	}
	trailing := serveSettingsMutation(handler, http.MethodPost, "/system/reason-codes", createBody+` {}`, principal, "settings-reason-0004")
	if trailing.Code != http.StatusBadRequest || fake.createReasonCalls != 1 {
		t.Fatalf("trailing JSON response/calls = %d/%d", trailing.Code, fake.createReasonCalls)
	}
}

func TestHTTPMapsStableSettingsErrors(t *testing.T) {
	now := time.Date(2026, 7, 22, 8, 0, 0, 0, time.UTC)
	tests := []struct {
		domainErr error
		status    int
		code      string
	}{
		{ErrInvalidRequest, http.StatusBadRequest, "SETTINGS_POLICY_INVALID"},
		{ErrPermissionDenied, http.StatusForbidden, "PERMISSION_DENIED"},
		{ErrRevisionConflict, http.StatusConflict, "SETTINGS_REVISION_CONFLICT"},
		{ErrIdempotencyKeyReused, http.StatusConflict, "IDEMPOTENCY_KEY_REUSED"},
		{ErrReasonExists, http.StatusConflict, "REASON_CODE_ALREADY_EXISTS"},
		{ErrReasonNotFound, http.StatusNotFound, "REASON_CODE_NOT_FOUND"},
		{ErrReasonInactive, http.StatusConflict, "REASON_CODE_INACTIVE"},
		{ErrReasonIncompatible, http.StatusConflict, "REASON_CODE_CATEGORY_MISMATCH"},
		{ErrLastActiveReason, http.StatusConflict, "REASON_CODE_LAST_ACTIVE"},
		{ErrReasonProtected, http.StatusConflict, "REASON_CODE_PROTECTED"},
		{ErrUnavailable, http.StatusServiceUnavailable, "SETTINGS_UNAVAILABLE"},
	}
	for _, test := range tests {
		t.Run(test.code, func(t *testing.T) {
			fake := &fakeHTTPService{err: test.domainErr}
			handler := NewHandlerWithClock(fake, func() time.Time { return now })
			response := serveSettingsMutation(handler, http.MethodPut, "/system/settings/security-policy",
				`{"expected_revision":4,"session_idle_minutes":20,"session_absolute_hours":8,"audit_retention_days":900,"reason_code":"security_policy_change"}`,
				settingsHTTPPrincipal(uuid.New(), rbac.SuperAdmin, now), "settings-errors-0001")
			if response.Code != test.status || !strings.Contains(response.Body.String(), `"code":"`+test.code+`"`) {
				t.Fatalf("response = %d %q, want %d/%s", response.Code, response.Body.String(), test.status, test.code)
			}
			assertSettingsJSON(t, response)
		})
	}
}

type fakeHTTPService struct {
	policy            Policy
	page              Page
	policyResult      PolicyMutationResult
	reasonResult      ReasonMutationResult
	err               error
	policyCalls       int
	reasonCalls       int
	updatePolicyCalls int
	createReasonCalls int
	updateReasonCalls int
	lastQuery         ReasonQuery
	lastMutation      MutationContext
	lastPolicyInput   UpdatePolicyInput
	lastCreateInput   CreateReasonCodeInput
	lastReasonCode    string
	lastUpdateInput   UpdateReasonCodeInput
}

func (fake *fakeHTTPService) GetPolicy(context.Context) (Policy, error) {
	fake.policyCalls++
	return fake.policy, fake.err
}

func (fake *fakeHTTPService) ListReasonCodes(_ context.Context, query ReasonQuery) (Page, error) {
	fake.reasonCalls++
	fake.lastQuery = query
	return fake.page, fake.err
}

func (fake *fakeHTTPService) UpdatePolicy(_ context.Context, mutation MutationContext, input UpdatePolicyInput) (PolicyMutationResult, error) {
	fake.updatePolicyCalls++
	fake.lastMutation = mutation
	fake.lastPolicyInput = input
	return fake.policyResult, fake.err
}

func (fake *fakeHTTPService) CreateReasonCode(_ context.Context, mutation MutationContext, input CreateReasonCodeInput) (ReasonMutationResult, error) {
	fake.createReasonCalls++
	fake.lastMutation = mutation
	fake.lastCreateInput = input
	return fake.reasonResult, fake.err
}

func (fake *fakeHTTPService) UpdateReasonCode(_ context.Context, mutation MutationContext, code string, input UpdateReasonCodeInput) (ReasonMutationResult, error) {
	fake.updateReasonCalls++
	fake.lastMutation = mutation
	fake.lastReasonCode = code
	fake.lastUpdateInput = input
	return fake.reasonResult, fake.err
}

func serveSettingsHTTP(handler http.Handler, method, path, body string, principal *auth.Principal) *httptest.ResponseRecorder {
	request := httptest.NewRequest(method, path, strings.NewReader(body))
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("User-Agent", "AeraAdminTest/1.0")
	request = auth.WithRequestMeta(request, auth.RequestMeta{
		RequestID: "req-settings-http", SourceIPHMAC: bytes.Repeat([]byte{8}, 32), UserAgent: "AeraAdminTest/1.0",
	})
	if principal != nil {
		request = auth.WithPrincipal(request, *principal)
	}
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	return response
}

func serveSettingsMutation(handler http.Handler, method, path, body string, principal *auth.Principal, idempotencyKey string) *httptest.ResponseRecorder {
	request := httptest.NewRequest(method, path, strings.NewReader(body))
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("User-Agent", "AeraAdminTest/1.0")
	request.Header.Set("Idempotency-Key", idempotencyKey)
	request = auth.WithRequestMeta(request, auth.RequestMeta{
		RequestID: "req-settings-http", SourceIPHMAC: bytes.Repeat([]byte{8}, 32), UserAgent: "AeraAdminTest/1.0",
	})
	if principal != nil {
		request = auth.WithPrincipal(request, *principal)
	}
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	return response
}

func settingsHTTPPrincipal(id uuid.UUID, role rbac.Role, totpAt time.Time) *auth.Principal {
	return &auth.Principal{
		AdminID: id.String(), SessionID: uuid.NewString(), Role: role, SecurityVersion: 1,
		MFAAuthenticatedAt: totpAt, TOTPAuthenticatedAt: &totpAt, MFAMethod: auth.MFAMethodTOTP,
	}
}

func assertSettingsJSON(t *testing.T, response *httptest.ResponseRecorder) {
	t.Helper()
	if response.Header().Get("Cache-Control") != "no-store" || response.Header().Get("Content-Type") != "application/json" ||
		response.Header().Get("X-Content-Type-Options") != "nosniff" {
		t.Fatalf("security headers = cache:%q type:%q nosniff:%q", response.Header().Get("Cache-Control"), response.Header().Get("Content-Type"), response.Header().Get("X-Content-Type-Options"))
	}
	var document any
	if err := json.Unmarshal(response.Body.Bytes(), &document); err != nil {
		t.Fatalf("response is not JSON: %q: %v", response.Body.String(), err)
	}
}

var _ HandlerService = (*fakeHTTPService)(nil)
