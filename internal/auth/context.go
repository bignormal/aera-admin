package auth

import (
	"context"
	"net/http"
	"time"

	"github.com/bignormal/aera-admin/internal/rbac"
)

type Principal struct {
	AdminID            string    `json:"admin_id"`
	SessionID          string    `json:"session_id"`
	Role               rbac.Role `json:"role"`
	SecurityVersion    int64     `json:"security_version"`
	MFAAuthenticatedAt time.Time `json:"mfa_authenticated_at"`
	MFAMethod          MFAMethod `json:"mfa_method"`
}

type principalContextKey struct{}

func WithPrincipal(request *http.Request, principal Principal) *http.Request {
	return request.WithContext(context.WithValue(request.Context(), principalContextKey{}, principal))
}

func PrincipalFromContext(ctx context.Context) (Principal, bool) {
	principal, ok := ctx.Value(principalContextKey{}).(Principal)
	return principal, ok
}
