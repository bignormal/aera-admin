package auth

import (
	"bytes"
	"context"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"strings"
	"testing"

	"github.com/bignormal/aera-admin/internal/audit"
)

func TestStatusCapturingWriterForwardsOnlyFirstStatus(t *testing.T) {
	underlying := &statusWriterSpy{header: make(http.Header)}
	writer := &statusCapturingWriter{ResponseWriter: underlying}

	writer.WriteHeader(http.StatusCreated)
	writer.WriteHeader(http.StatusInternalServerError)

	if writer.status != http.StatusCreated {
		t.Fatalf("captured status = %d, want %d", writer.status, http.StatusCreated)
	}
	if len(underlying.statuses) != 1 || underlying.statuses[0] != http.StatusCreated {
		t.Fatalf("forwarded statuses = %v, want [%d]", underlying.statuses, http.StatusCreated)
	}
}

func TestBrowserGeneratesAuthoritativeRequestIDsForSecretShapedHeaders(t *testing.T) {
	fixture := newAuthFixture(t)
	challenge, err := fixture.service.BeginLogin(context.Background(), fixture.email, fixture.password, fixture.meta("req-request-id-password"))
	if err != nil {
		t.Fatalf("BeginLogin() error = %v", err)
	}
	login, err := fixture.service.CompleteLogin(context.Background(), CompleteLoginRequest{
		ChallengeID: challenge.ID,
		TOTPCode:    fixture.totp.Code(fixture.totpSecret, fixture.now),
		Meta:        fixture.meta("req-request-id-totp"),
	})
	if err != nil {
		t.Fatalf("CompleteLogin() error = %v", err)
	}
	security, err := NewBrowserSecurity(BrowserSecurityConfig{
		Service: fixture.service, PublicURL: "https://admin.example.test", SourceIPHMACKey: bytes.Repeat([]byte{4}, 32),
	})
	if err != nil {
		t.Fatalf("NewBrowserSecurity() error = %v", err)
	}
	handler := security.Wrap(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		meta, ok := RequestMetaFromContext(request.Context())
		if !ok {
			t.Fatal("request metadata missing")
		}
		response.Header().Set("Observed-Request-ID", meta.RequestID)
		response.WriteHeader(http.StatusNoContent)
	}))
	for name, callerID := range map[string]string{
		"challenge": challenge.ID,
		"session":   login.RawSessionToken,
		"csrf":      login.CSRFToken,
		"recovery":  fixture.recoveryCode,
		"totp":      fixture.totp.Code(fixture.totpSecret, fixture.now),
		"password":  strings.ReplaceAll(fixture.password, " ", "-"),
	} {
		t.Run(name, func(t *testing.T) {
			request := httptest.NewRequest(http.MethodGet, "/probe", nil)
			request.RemoteAddr = "192.0.2.10:4242"
			request.Header.Set("X-Request-ID", callerID)
			response := httptest.NewRecorder()
			handler.ServeHTTP(response, request)
			generated := response.Header().Get("X-Request-ID")
			if generated == "" || generated == callerID || response.Header().Get("Observed-Request-ID") != generated {
				t.Fatalf("request IDs = response:%q observed:%q caller:%q", generated, response.Header().Get("Observed-Request-ID"), callerID)
			}
		})
	}
}

func TestCredentialLikeUserAgentIsDroppedButDenialIsAudited(t *testing.T) {
	fixture := newAuthFixture(t)
	security, err := NewBrowserSecurity(BrowserSecurityConfig{
		Service: fixture.service, PublicURL: "https://admin.example.test", SourceIPHMACKey: bytes.Repeat([]byte{4}, 32),
	})
	if err != nil {
		t.Fatalf("NewBrowserSecurity() error = %v", err)
	}
	handler := security.Wrap(http.HandlerFunc(func(response http.ResponseWriter, _ *http.Request) {
		writeAuthorizationError(response, http.StatusForbidden, "PERMISSION_DENIED", "没有执行此操作的权限")
	}))
	request := httptest.NewRequest(http.MethodGet, "/admin-users", nil)
	request.RemoteAddr = "192.0.2.10:4242"
	request.Header.Set("User-Agent", "AdminBrowser/1.0 token=abcdef123456")
	request.Header.Set("X-Request-ID", fixture.recoveryCode)
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusForbidden {
		t.Fatalf("response = %d %q", response.Code, response.Body.String())
	}
	var requestID, userAgent string
	if err := fixture.postgres.QueryRow(context.Background(), `
		SELECT request_id, COALESCE(user_agent, '')
		FROM admin_audit_events
		WHERE event_type = 'admin_authorization_denied'
		ORDER BY created_at DESC
		LIMIT 1
	`).Scan(&requestID, &userAgent); err != nil {
		t.Fatalf("read denial audit: %v", err)
	}
	if userAgent != "" && strings.Contains(userAgent, "abcdef123456") {
		t.Fatalf("denial audit retained credential-like User-Agent %q", userAgent)
	}
	if requestID == fixture.recoveryCode || requestID != response.Header().Get("X-Request-ID") {
		t.Fatalf("denial audit request ID = %q, response = %q, caller = %q", requestID, response.Header().Get("X-Request-ID"), fixture.recoveryCode)
	}
}

func TestDenialAuditFailureReplacesBufferedDenialWithUnavailable(t *testing.T) {
	fixture := newAuthFixture(t)
	fixture.service.audit = &audit.Service{}
	security, err := NewBrowserSecurity(BrowserSecurityConfig{
		Service: fixture.service, PublicURL: "https://admin.example.test", SourceIPHMACKey: bytes.Repeat([]byte{4}, 32),
	})
	if err != nil {
		t.Fatalf("NewBrowserSecurity() error = %v", err)
	}
	handler := security.Wrap(http.HandlerFunc(func(response http.ResponseWriter, _ *http.Request) {
		writeAuthorizationError(response, http.StatusForbidden, "PERMISSION_DENIED", "没有执行此操作的权限")
	}))
	request := httptest.NewRequest(http.MethodGet, "/admin-users", nil)
	request.RemoteAddr = "192.0.2.10:4242"
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusServiceUnavailable || !strings.Contains(response.Body.String(), `"code":"AUTH_UNAVAILABLE"`) || strings.Contains(response.Body.String(), "PERMISSION_DENIED") {
		t.Fatalf("response = %d %q", response.Code, response.Body.String())
	}
}

func TestClientIPIgnoresForwardingHeadersFromUntrustedPeer(t *testing.T) {
	request := httptest.NewRequest(http.MethodGet, "/", nil)
	request.RemoteAddr = "198.51.100.9:4242"
	request.Header.Set("X-Forwarded-For", "203.0.113.7")
	trusted := []netip.Prefix{netip.MustParsePrefix("10.0.0.0/8")}
	if got := canonicalClientIP(request, trusted); got != "198.51.100.9" {
		t.Fatalf("canonicalClientIP() = %q, want untrusted peer", got)
	}
}

func TestClientIPWalksForwardingChainOnlyThroughTrustedProxies(t *testing.T) {
	request := httptest.NewRequest(http.MethodGet, "/", nil)
	request.RemoteAddr = "10.0.0.9:4242"
	request.Header.Set("X-Forwarded-For", "203.0.113.7, 10.0.0.8")
	trusted := []netip.Prefix{netip.MustParsePrefix("10.0.0.0/8")}
	if got := canonicalClientIP(request, trusted); got != "203.0.113.7" {
		t.Fatalf("canonicalClientIP() = %q, want original untrusted client", got)
	}

	request.Header.Set("X-Forwarded-For", "203.0.113.7, invalid")
	if got := canonicalClientIP(request, trusted); got != "10.0.0.9" {
		t.Fatalf("canonicalClientIP(malformed) = %q, want trusted peer fallback", got)
	}
}

type statusWriterSpy struct {
	header   http.Header
	statuses []int
}

func (writer *statusWriterSpy) Header() http.Header {
	return writer.header
}

func (writer *statusWriterSpy) Write(body []byte) (int, error) {
	return len(body), nil
}

func (writer *statusWriterSpy) WriteHeader(status int) {
	writer.statuses = append(writer.statuses, status)
}
