package auth

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/bignormal/aera-admin/internal/rbac"
)

func TestRequireRejectsAuthenticatedRoleWithoutPermission(t *testing.T) {
	called := false
	handler := Require(rbac.RevokeCloudSession, http.HandlerFunc(func(response http.ResponseWriter, _ *http.Request) {
		called = true
		response.WriteHeader(http.StatusNoContent)
	}))
	request := WithPrincipal(
		httptest.NewRequest(http.MethodPost, "/action", nil),
		Principal{AdminID: "00000000-0000-4000-8000-000000000001", Role: rbac.Auditor},
	)
	response := httptest.NewRecorder()

	handler.ServeHTTP(response, request)

	if response.Code != http.StatusForbidden {
		t.Fatalf("status = %d, want 403", response.Code)
	}
	if called {
		t.Fatal("protected handler ran for a denied role")
	}
	assertAPIError(t, response, "PERMISSION_DENIED")
}

func TestRequireRejectsMissingOrInvalidPrincipal(t *testing.T) {
	tests := []struct {
		name      string
		principal *Principal
	}{
		{name: "missing"},
		{name: "invalid role", principal: &Principal{AdminID: "admin-1", Role: rbac.Role("custom")}},
		{name: "missing administrator", principal: &Principal{Role: rbac.Support}},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			request := httptest.NewRequest(http.MethodGet, "/action", nil)
			if test.principal != nil {
				request = WithPrincipal(request, *test.principal)
			}
			response := httptest.NewRecorder()

			Require(rbac.ReadCloudUsers, http.HandlerFunc(func(http.ResponseWriter, *http.Request) {
				t.Fatal("protected handler ran without a valid principal")
			})).ServeHTTP(response, request)

			if response.Code != http.StatusUnauthorized {
				t.Fatalf("status = %d, want 401", response.Code)
			}
			assertAPIError(t, response, "AUTH_REQUIRED")
		})
	}
}

func TestRequireAllowsAuthorizedRoleAndPreservesPrincipal(t *testing.T) {
	principal := Principal{
		AdminID:            "00000000-0000-4000-8000-000000000001",
		SessionID:          "00000000-0000-4000-8000-000000000002",
		Role:               rbac.Support,
		SecurityVersion:    4,
		MFAAuthenticatedAt: time.Unix(100, 0).UTC(),
	}
	handler := Require(rbac.RevokeCloudSession, http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		got, ok := PrincipalFromContext(request.Context())
		if !ok || got != principal {
			t.Fatalf("PrincipalFromContext() = %+v, %v, want %+v, true", got, ok, principal)
		}
		response.WriteHeader(http.StatusNoContent)
	}))
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, WithPrincipal(httptest.NewRequest(http.MethodPost, "/action", nil), principal))

	if response.Code != http.StatusNoContent {
		t.Fatalf("status = %d, want 204", response.Code)
	}
}

func TestPrincipalContextDoesNotAcceptForeignContextValues(t *testing.T) {
	ctx := context.WithValue(context.Background(), "principal", Principal{AdminID: "forged", Role: rbac.SuperAdmin})
	if _, ok := PrincipalFromContext(ctx); ok {
		t.Fatal("PrincipalFromContext accepted a foreign context key")
	}
}

func TestRequireRecentTOTPRejectsRecoveryAndStaleAuthentication(t *testing.T) {
	now := time.Date(2026, 7, 21, 16, 0, 0, 0, time.UTC)
	for name, principal := range map[string]Principal{
		"recovery": {
			AdminID: "00000000-0000-4000-8000-000000000001", Role: rbac.SuperAdmin,
			MFAMethod: MFAMethodRecovery, MFAAuthenticatedAt: now,
		},
		"stale": {
			AdminID: "00000000-0000-4000-8000-000000000001", Role: rbac.SuperAdmin,
			MFAMethod: MFAMethodTOTP, MFAAuthenticatedAt: now.Add(-20 * time.Minute), TOTPAuthenticatedAt: timePointer(now.Add(-11 * time.Minute)),
		},
	} {
		t.Run(name, func(t *testing.T) {
			request := WithPrincipal(httptest.NewRequest(http.MethodPost, "/dangerous", nil), principal)
			response := httptest.NewRecorder()
			RequireRecentTOTP(func() time.Time { return now }, http.HandlerFunc(func(http.ResponseWriter, *http.Request) {
				t.Fatal("high-risk handler ran without recent TOTP")
			})).ServeHTTP(response, request)
			if response.Code != http.StatusForbidden {
				t.Fatalf("status = %d, want 403", response.Code)
			}
			assertAPIError(t, response, "STEP_UP_REQUIRED")
		})
	}
	fresh := Principal{
		AdminID: "00000000-0000-4000-8000-000000000001", Role: rbac.SuperAdmin,
		MFAMethod: MFAMethodRecovery, MFAAuthenticatedAt: now.Add(-20 * time.Minute), TOTPAuthenticatedAt: timePointer(now.Add(-10 * time.Minute)),
	}
	response := httptest.NewRecorder()
	RequireRecentTOTP(func() time.Time { return now }, http.HandlerFunc(func(response http.ResponseWriter, _ *http.Request) {
		response.WriteHeader(http.StatusNoContent)
	})).ServeHTTP(response, WithPrincipal(httptest.NewRequest(http.MethodPost, "/dangerous", nil), fresh))
	if response.Code != http.StatusNoContent {
		t.Fatalf("fresh status = %d, want 204", response.Code)
	}
}

func timePointer(value time.Time) *time.Time {
	return &value
}

func assertAPIError(t *testing.T, response *httptest.ResponseRecorder, code string) {
	t.Helper()
	if contentType := response.Header().Get("Content-Type"); contentType != "application/json" {
		t.Fatalf("Content-Type = %q", contentType)
	}
	if cacheControl := response.Header().Get("Cache-Control"); cacheControl != "no-store" {
		t.Fatalf("Cache-Control = %q", cacheControl)
	}
	if body := response.Body.String(); !strings.Contains(body, `"code":"`+code+`"`) || strings.Contains(body, "custom") {
		t.Fatalf("body = %q", body)
	}
}
