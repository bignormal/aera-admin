package auth

import (
	"context"
	"crypto/subtle"
	"errors"
	"net"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/google/uuid"
)

const SessionCookieName = "__Host-aera_admin_session"

type BrowserSecurityConfig struct {
	Service         *Service
	PublicURL       string
	SourceIPHMACKey []byte
}

type BrowserSecurity struct {
	service         *Service
	origin          string
	sourceIPHMACKey []byte
}

type requestMetaContextKey struct{}
type browserSessionContextKey struct{}

type browserSession struct {
	rawToken string
	session  AuthenticatedSession
}

func NewBrowserSecurity(config BrowserSecurityConfig) (*BrowserSecurity, error) {
	if config.Service == nil || len(config.SourceIPHMACKey) < 32 {
		return nil, errors.New("browser security dependencies are required")
	}
	parsed, err := url.Parse(config.PublicURL)
	if err != nil || (parsed.Scheme != "http" && parsed.Scheme != "https") || parsed.Host == "" || parsed.User != nil ||
		parsed.RawQuery != "" || parsed.Fragment != "" || (parsed.Path != "" && parsed.Path != "/") {
		return nil, errors.New("browser security public URL is invalid")
	}
	origin := parsed.Scheme + "://" + parsed.Host
	return &BrowserSecurity{
		service: config.Service, origin: origin,
		sourceIPHMACKey: append([]byte(nil), config.SourceIPHMACKey...),
	}, nil
}

func (security *BrowserSecurity) Wrap(next http.Handler) http.Handler {
	if security == nil || next == nil {
		return http.HandlerFunc(func(response http.ResponseWriter, _ *http.Request) {
			writeAuthorizationError(response, http.StatusServiceUnavailable, "AUTH_UNAVAILABLE", "认证服务暂时不可用")
		})
	}
	return security.withRequestMeta(security.withSession(security.auditDeniedRequest(security.requireBrowserMutation(next))))
}

func RequestMetaFromContext(ctx context.Context) (RequestMeta, bool) {
	meta, ok := ctx.Value(requestMetaContextKey{}).(RequestMeta)
	return meta, ok
}

func (security *BrowserSecurity) withRequestMeta(next http.Handler) http.Handler {
	return http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		requestID := strings.TrimSpace(request.Header.Get("X-Request-ID"))
		if !authenticationRequestIDPattern.MatchString(requestID) {
			requestID = "req-" + uuid.NewString()
		}
		sourceIP := canonicalRemoteIP(request.RemoteAddr)
		meta := RequestMeta{
			RequestID:    requestID,
			SourceIPHMAC: keyedDigest(security.sourceIPHMACKey, "aera-admin.source-ip.v1", sourceIP),
			UserAgent:    request.UserAgent(),
		}
		response.Header().Set("X-Request-ID", requestID)
		next.ServeHTTP(response, request.WithContext(context.WithValue(request.Context(), requestMetaContextKey{}, meta)))
	})
}

func (security *BrowserSecurity) withSession(next http.Handler) http.Handler {
	return http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		cookie, err := request.Cookie(SessionCookieName)
		if errors.Is(err, http.ErrNoCookie) || (err == nil && cookie.Value == "") {
			next.ServeHTTP(response, request)
			return
		}
		if err != nil {
			clearSessionCookie(response)
			next.ServeHTTP(response, request)
			return
		}
		authenticated, err := security.service.Authenticate(request.Context(), cookie.Value)
		if errors.Is(err, ErrInvalidSession) {
			clearSessionCookie(response)
			next.ServeHTTP(response, request)
			return
		}
		if err != nil {
			writeAuthorizationError(response, http.StatusServiceUnavailable, "AUTH_UNAVAILABLE", "认证服务暂时不可用")
			return
		}
		request = WithPrincipal(request, authenticated.Principal)
		state := browserSession{rawToken: cookie.Value, session: authenticated}
		request = request.WithContext(context.WithValue(request.Context(), browserSessionContextKey{}, state))
		next.ServeHTTP(response, request)
	})
}

func (security *BrowserSecurity) requireBrowserMutation(next http.Handler) http.Handler {
	return http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		if request.Method == http.MethodGet || request.Method == http.MethodHead || request.Method == http.MethodOptions {
			next.ServeHTTP(response, request)
			return
		}
		if request.Header.Get("Origin") != security.origin {
			writeAuthorizationError(response, http.StatusForbidden, "ORIGIN_INVALID", "请求来源无效")
			return
		}
		if state, ok := browserSessionFromContext(request.Context()); ok {
			provided := request.Header.Get("X-CSRF-Token")
			expected := state.session.CSRFToken
			if len(provided) == 0 || len(provided) != len(expected) || subtle.ConstantTimeCompare([]byte(provided), []byte(expected)) != 1 {
				writeAuthorizationError(response, http.StatusForbidden, "CSRF_INVALID", "CSRF 验证失败")
				return
			}
		}
		next.ServeHTTP(response, request)
	})
}

type statusCapturingWriter struct {
	http.ResponseWriter
	status int
}

func (writer *statusCapturingWriter) WriteHeader(status int) {
	if writer.status != 0 {
		return
	}
	writer.status = status
	writer.ResponseWriter.WriteHeader(status)
}

func (writer *statusCapturingWriter) Write(body []byte) (int, error) {
	if writer.status == 0 {
		writer.status = http.StatusOK
	}
	return writer.ResponseWriter.Write(body)
}

func (security *BrowserSecurity) auditDeniedRequest(next http.Handler) http.Handler {
	return http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		captured := &statusCapturingWriter{ResponseWriter: response}
		next.ServeHTTP(captured, request)
		status := captured.status
		if status == 0 {
			status = http.StatusOK
		}
		if status != http.StatusUnauthorized && status != http.StatusForbidden && status != http.StatusTooManyRequests &&
			!(status == http.StatusBadRequest && strings.HasPrefix(request.URL.Path, "/auth/activat")) {
			return
		}
		meta, ok := RequestMetaFromContext(request.Context())
		if !ok {
			return
		}
		principal, _ := PrincipalFromContext(request.Context())
		auditCtx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		defer cancel()
		security.service.auditHTTPDenial(auditCtx, request.URL.Path, status, principal, meta)
	})
}

func browserSessionFromContext(ctx context.Context) (browserSession, bool) {
	state, ok := ctx.Value(browserSessionContextKey{}).(browserSession)
	return state, ok
}

func canonicalRemoteIP(remoteAddress string) string {
	host, _, err := net.SplitHostPort(remoteAddress)
	if err != nil {
		host = remoteAddress
	}
	parsed := net.ParseIP(strings.TrimSpace(host))
	if parsed == nil {
		return "invalid"
	}
	return parsed.String()
}

func setSessionCookie(response http.ResponseWriter, rawToken string, expiresAt time.Time) {
	http.SetCookie(response, &http.Cookie{
		Name: SessionCookieName, Value: rawToken, Path: "/", Expires: expiresAt,
		Secure: true, HttpOnly: true, SameSite: http.SameSiteStrictMode,
	})
}

func clearSessionCookie(response http.ResponseWriter) {
	http.SetCookie(response, &http.Cookie{
		Name: SessionCookieName, Value: "", Path: "/", Expires: time.Unix(1, 0).UTC(), MaxAge: -1,
		Secure: true, HttpOnly: true, SameSite: http.SameSiteStrictMode,
	})
}
