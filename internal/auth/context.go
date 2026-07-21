package auth

import (
	"context"
	"net/http"
	"time"

	"github.com/bignormal/aera-admin/internal/rbac"
)

type Principal struct {
	AdminID            string
	SessionID          string
	Role               rbac.Role
	SecurityVersion    int64
	MFAAuthenticatedAt time.Time
}

type principalContextKey struct{}

func WithPrincipal(request *http.Request, principal Principal) *http.Request {
	return request.WithContext(context.WithValue(request.Context(), principalContextKey{}, principal))
}

func PrincipalFromContext(ctx context.Context) (Principal, bool) {
	principal, ok := ctx.Value(principalContextKey{}).(Principal)
	return principal, ok
}
