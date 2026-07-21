package auth

import (
	"encoding/json"
	"net/http"
	"time"

	"github.com/bignormal/aera-admin/internal/rbac"
)

const recentTOTPLifetime = 10 * time.Minute

func Require(permission rbac.Permission, next http.Handler) http.Handler {
	return http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		principal, ok := PrincipalFromContext(request.Context())
		if !ok || principal.AdminID == "" || !principal.Role.Valid() {
			writeAuthorizationError(response, http.StatusUnauthorized, "AUTH_REQUIRED", "需要有效的管理员会话")
			return
		}
		if !rbac.Allowed(principal.Role, permission) {
			writeAuthorizationError(response, http.StatusForbidden, "PERMISSION_DENIED", "没有执行此操作的权限")
			return
		}
		next.ServeHTTP(response, request)
	})
}

func RequireRecentTOTP(clock func() time.Time, next http.Handler) http.Handler {
	if clock == nil {
		clock = time.Now
	}
	return http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		principal, ok := PrincipalFromContext(request.Context())
		if !ok || principal.AdminID == "" || !principal.Role.Valid() {
			writeAuthorizationError(response, http.StatusUnauthorized, "AUTH_REQUIRED", "需要有效的管理员会话")
			return
		}
		now := clock().UTC()
		if principal.TOTPAuthenticatedAt == nil {
			writeAuthorizationError(response, http.StatusForbidden, "STEP_UP_REQUIRED", "此操作需要近期完成 TOTP 二次验证")
			return
		}
		totpAt := principal.TOTPAuthenticatedAt.UTC()
		if totpAt.IsZero() || totpAt.After(now) || now.Sub(totpAt) > recentTOTPLifetime {
			writeAuthorizationError(response, http.StatusForbidden, "STEP_UP_REQUIRED", "此操作需要近期完成 TOTP 二次验证")
			return
		}
		next.ServeHTTP(response, request)
	})
}

func writeAuthorizationError(response http.ResponseWriter, status int, code, message string) {
	response.Header().Set("Cache-Control", "no-store")
	response.Header().Set("Content-Type", "application/json")
	response.Header().Set("X-Content-Type-Options", "nosniff")
	response.WriteHeader(status)
	_ = json.NewEncoder(response).Encode(struct {
		Error struct {
			Code    string `json:"code"`
			Message string `json:"message"`
		} `json:"error"`
	}{Error: struct {
		Code    string `json:"code"`
		Message string `json:"message"`
	}{Code: code, Message: message}})
}
