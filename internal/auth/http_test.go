package auth

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestBrowserLoginCookieSessionCSRFOriginAndLogout(t *testing.T) {
	fixture := newAuthFixture(t)
	security, err := NewBrowserSecurity(BrowserSecurityConfig{
		Service: fixture.service, PublicURL: "https://admin.example.test", SourceIPHMACKey: bytes.Repeat([]byte{4}, 32),
	})
	if err != nil {
		t.Fatalf("NewBrowserSecurity() error = %v", err)
	}
	handler := security.Wrap(NewHandler(fixture.service))

	loginResponse := serveAuthHTTP(handler, http.MethodPost, "/auth/login", `{"email":"admin@example.com","password":"correct horse battery staple"}`, nil, "https://admin.example.test", "")
	if loginResponse.Code != http.StatusOK {
		t.Fatalf("login response = %d %q", loginResponse.Code, loginResponse.Body.String())
	}
	var challenge LoginChallenge
	if err := json.Unmarshal(loginResponse.Body.Bytes(), &challenge); err != nil || challenge.ID == "" {
		t.Fatalf("decode login challenge: %+v, %v", challenge, err)
	}
	verifyBody, _ := json.Marshal(map[string]string{
		"challenge_id": challenge.ID,
		"totp_code":    fixture.totp.Code(fixture.totpSecret, fixture.now),
	})
	verifyResponse := serveAuthHTTP(handler, http.MethodPost, "/auth/totp/verify", string(verifyBody), nil, "https://admin.example.test", "")
	if verifyResponse.Code != http.StatusOK {
		t.Fatalf("verify response = %d %q", verifyResponse.Code, verifyResponse.Body.String())
	}
	cookies := verifyResponse.Result().Cookies()
	if len(cookies) != 1 {
		t.Fatalf("login cookies = %d, want 1", len(cookies))
	}
	cookie := cookies[0]
	if cookie.Name != SessionCookieName || cookie.Value == "" || !cookie.Secure || !cookie.HttpOnly ||
		cookie.SameSite != http.SameSiteStrictMode || cookie.Path != "/" || cookie.Domain != "" {
		t.Fatalf("session cookie = %+v", cookie)
	}
	var document sessionDocument
	if err := json.Unmarshal(verifyResponse.Body.Bytes(), &document); err != nil {
		t.Fatalf("decode verified session: %v", err)
	}
	if document.CSRFToken == "" || document.Principal.AdminID != fixture.adminID.String() || document.Principal.MFAMethod != MFAMethodTOTP {
		t.Fatalf("verified session document = %+v", document)
	}
	for _, secret := range []string{fixture.password, fixture.totp.Code(fixture.totpSecret, fixture.now), cookie.Value} {
		if strings.Contains(verifyResponse.Body.String(), secret) {
			t.Fatalf("verified session body leaked secret material")
		}
	}

	meResponse := serveAuthHTTP(handler, http.MethodGet, "/me", "", cookie, "", "")
	if meResponse.Code != http.StatusOK || !strings.Contains(meResponse.Body.String(), document.CSRFToken) {
		t.Fatalf("me response = %d %q", meResponse.Code, meResponse.Body.String())
	}
	missingOrigin := serveAuthHTTP(handler, http.MethodPost, "/auth/step-up", `{"totp_code":"000000"}`, cookie, "", document.CSRFToken)
	if missingOrigin.Code != http.StatusForbidden || !strings.Contains(missingOrigin.Body.String(), `"code":"ORIGIN_INVALID"`) {
		t.Fatalf("missing-origin response = %d %q", missingOrigin.Code, missingOrigin.Body.String())
	}
	wrongCSRF := serveAuthHTTP(handler, http.MethodPost, "/auth/step-up", `{"totp_code":"000000"}`, cookie, "https://admin.example.test", "wrong-csrf")
	if wrongCSRF.Code != http.StatusForbidden || !strings.Contains(wrongCSRF.Body.String(), `"code":"CSRF_INVALID"`) {
		t.Fatalf("wrong-CSRF response = %d %q", wrongCSRF.Code, wrongCSRF.Body.String())
	}
	var deniedCount int
	var deniedHaveActor, deniedHaveSource bool
	if err := fixture.postgres.QueryRow(t.Context(), `
		SELECT count(*), bool_and(actor_admin_id = $1), bool_and(source_ip_hmac IS NOT NULL)
		FROM admin_audit_events
		WHERE event_type = 'admin_authorization_denied'
	`, fixture.adminID).Scan(&deniedCount, &deniedHaveActor, &deniedHaveSource); err != nil {
		t.Fatalf("read denied request audit: %v", err)
	}
	if deniedCount != 2 || !deniedHaveActor || !deniedHaveSource {
		t.Fatalf("denied audit = count:%d actor:%v source:%v", deniedCount, deniedHaveActor, deniedHaveSource)
	}

	logoutResponse := serveAuthHTTP(handler, http.MethodPost, "/auth/logout", `{}`, cookie, "https://admin.example.test", document.CSRFToken)
	if logoutResponse.Code != http.StatusOK {
		t.Fatalf("logout response = %d %q", logoutResponse.Code, logoutResponse.Body.String())
	}
	logoutCookies := logoutResponse.Result().Cookies()
	if len(logoutCookies) != 1 || logoutCookies[0].Name != SessionCookieName || logoutCookies[0].MaxAge != -1 {
		t.Fatalf("logout cookies = %+v", logoutCookies)
	}
	meAfterLogout := serveAuthHTTP(handler, http.MethodGet, "/me", "", cookie, "", "")
	if meAfterLogout.Code != http.StatusUnauthorized || !strings.Contains(meAfterLogout.Body.String(), `"code":"AUTH_REQUIRED"`) {
		t.Fatalf("me after logout = %d %q", meAfterLogout.Code, meAfterLogout.Body.String())
	}
}

func serveAuthHTTP(
	handler http.Handler,
	method, path, body string,
	cookie *http.Cookie,
	origin, csrf string,
) *httptest.ResponseRecorder {
	request := httptest.NewRequest(method, path, strings.NewReader(body))
	request.RemoteAddr = "192.0.2.10:4242"
	request.Header.Set("User-Agent", "AdminBrowser/1.0")
	request.Header.Set("X-Request-ID", "req-auth-http-test")
	if method != http.MethodGet && method != http.MethodHead {
		request.Header.Set("Content-Type", "application/json")
	}
	if cookie != nil {
		request.AddCookie(cookie)
	}
	if origin != "" {
		request.Header.Set("Origin", origin)
	}
	if csrf != "" {
		request.Header.Set("X-CSRF-Token", csrf)
	}
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	return response
}
