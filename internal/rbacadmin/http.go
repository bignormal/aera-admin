package rbacadmin

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"mime"
	"net/http"
	"time"

	"github.com/bignormal/aera-admin/internal/auth"
	"github.com/bignormal/aera-admin/internal/rbac"
	"github.com/go-chi/chi/v5"
)

const maximumRoleJSONBody = 32 << 10

type HandlerService interface {
	Catalog() Catalog
	ListRoles(context.Context) (RoleList, error)
	CreateRole(context.Context, MutationContext, CreateRoleInput) (Role, error)
	UpdateRole(context.Context, MutationContext, string, UpdateRoleInput) (Role, error)
	DeleteRole(context.Context, MutationContext, string) error
}

func NewHandler(service HandlerService) http.Handler {
	return NewHandlerWithClock(service, time.Now)
}

func NewHandlerWithClock(service HandlerService, clock func() time.Time) http.Handler {
	if service == nil {
		panic("rbac admin HTTP service is required")
	}
	if clock == nil {
		clock = time.Now
	}
	router := chi.NewRouter()
	router.With(rolePermission(rbac.ReadAdministrators)).Get("/rbac/permissions", catalogHTTP(service))
	router.With(rolePermission(rbac.ReadAdministrators)).Get("/rbac/roles", listRolesHTTP(service))
	router.With(rolePermission(rbac.ManageAdministrators), roleRecentTOTP(clock)).Post("/rbac/roles", createRoleHTTP(service))
	router.With(rolePermission(rbac.ManageAdministrators), roleRecentTOTP(clock)).Patch("/rbac/roles/{slug}", updateRoleHTTP(service))
	router.With(rolePermission(rbac.ManageAdministrators), roleRecentTOTP(clock)).Delete("/rbac/roles/{slug}", deleteRoleHTTP(service))
	router.NotFound(func(response http.ResponseWriter, _ *http.Request) {
		writeRoleError(response, http.StatusNotFound, "NOT_FOUND", "请求的资源不存在")
	})
	router.MethodNotAllowed(func(response http.ResponseWriter, _ *http.Request) {
		writeRoleError(response, http.StatusMethodNotAllowed, "METHOD_NOT_ALLOWED", "请求方法不受支持")
	})
	return http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		response.Header().Set("Cache-Control", "no-store")
		response.Header().Set("Content-Type", "application/json")
		response.Header().Set("X-Content-Type-Options", "nosniff")
		router.ServeHTTP(response, request)
	})
}

func rolePermission(permission rbac.Permission) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return auth.Require(permission, next)
	}
}

func roleRecentTOTP(clock func() time.Time) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return auth.RequireRecentTOTP(clock, next)
	}
}

func catalogHTTP(service HandlerService) http.HandlerFunc {
	return func(response http.ResponseWriter, _ *http.Request) {
		writeRoleJSON(response, http.StatusOK, service.Catalog())
	}
}

func listRolesHTTP(service HandlerService) http.HandlerFunc {
	return func(response http.ResponseWriter, request *http.Request) {
		list, err := service.ListRoles(request.Context())
		if err != nil {
			writeRoleDomainError(response, err)
			return
		}
		writeRoleJSON(response, http.StatusOK, list)
	}
}

func createRoleHTTP(service HandlerService) http.HandlerFunc {
	return func(response http.ResponseWriter, request *http.Request) {
		actor, ok := roleMutationContext(response, request)
		if !ok {
			return
		}
		var input CreateRoleInput
		if err := decodeRoleJSON(response, request, &input); err != nil {
			writeRoleError(response, http.StatusBadRequest, "INVALID_REQUEST", "请求内容无效")
			return
		}
		role, err := service.CreateRole(request.Context(), actor, input)
		if err != nil {
			writeRoleDomainError(response, err)
			return
		}
		writeRoleJSON(response, http.StatusCreated, role)
	}
}

func updateRoleHTTP(service HandlerService) http.HandlerFunc {
	return func(response http.ResponseWriter, request *http.Request) {
		actor, ok := roleMutationContext(response, request)
		if !ok {
			return
		}
		slug := chi.URLParam(request, "slug")
		var input UpdateRoleInput
		if err := decodeRoleJSON(response, request, &input); err != nil {
			writeRoleError(response, http.StatusBadRequest, "INVALID_REQUEST", "请求内容无效")
			return
		}
		role, err := service.UpdateRole(request.Context(), actor, slug, input)
		if err != nil {
			writeRoleDomainError(response, err)
			return
		}
		writeRoleJSON(response, http.StatusOK, role)
	}
}

func deleteRoleHTTP(service HandlerService) http.HandlerFunc {
	return func(response http.ResponseWriter, request *http.Request) {
		actor, ok := roleMutationContext(response, request)
		if !ok {
			return
		}
		slug := chi.URLParam(request, "slug")
		if err := service.DeleteRole(request.Context(), actor, slug); err != nil {
			writeRoleDomainError(response, err)
			return
		}
		writeRoleJSON(response, http.StatusOK, map[string]string{"status": "deleted", "slug": slug})
	}
}

func roleMutationContext(response http.ResponseWriter, request *http.Request) (MutationContext, bool) {
	principal, ok := auth.PrincipalFromContext(request.Context())
	if !ok || principal.AdminID == "" || !principal.Role.Valid() {
		writeRoleError(response, http.StatusUnauthorized, "AUTH_REQUIRED", "需要有效的管理员会话")
		return MutationContext{}, false
	}
	actor := MutationContext{ActorAdminID: principal.AdminID, ActorRole: principal.Role}
	if meta, present := auth.RequestMetaFromContext(request.Context()); present {
		actor.RequestID = meta.RequestID
		actor.SourceIPHMAC = append([]byte(nil), meta.SourceIPHMAC...)
		actor.UserAgent = meta.UserAgent
	}
	if actor.RequestID == "" {
		writeRoleError(response, http.StatusServiceUnavailable, "ROLE_UNAVAILABLE", "角色服务暂时不可用")
		return MutationContext{}, false
	}
	return actor, true
}

func decodeRoleJSON(response http.ResponseWriter, request *http.Request, target any) error {
	mediaType, _, err := mime.ParseMediaType(request.Header.Get("Content-Type"))
	if err != nil || mediaType != "application/json" {
		return ErrInvalidRequest
	}
	request.Body = http.MaxBytesReader(response, request.Body, maximumRoleJSONBody)
	decoder := json.NewDecoder(request.Body)
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(target); err != nil {
		return ErrInvalidRequest
	}
	var extra any
	if err := decoder.Decode(&extra); !errors.Is(err, io.EOF) {
		return ErrInvalidRequest
	}
	return nil
}

func writeRoleDomainError(response http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, ErrInvalidRequest):
		writeRoleError(response, http.StatusBadRequest, "INVALID_REQUEST", "请求内容无效")
	case errors.Is(err, ErrPermissionDenied):
		writeRoleError(response, http.StatusForbidden, "PERMISSION_DENIED", "没有执行此操作的权限")
	case errors.Is(err, ErrProtectedPermission):
		writeRoleError(response, http.StatusConflict, "PROTECTED_PERMISSION", "超级管理员的核心权限不可移除")
	case errors.Is(err, ErrRoleExists):
		writeRoleError(response, http.StatusConflict, "ROLE_ALREADY_EXISTS", "角色标识已存在")
	case errors.Is(err, ErrRoleNotFound):
		writeRoleError(response, http.StatusNotFound, "ROLE_NOT_FOUND", "角色不存在")
	case errors.Is(err, ErrRoleInUse):
		writeRoleError(response, http.StatusConflict, "ROLE_IN_USE", "仍有管理员使用该角色，无法删除")
	case errors.Is(err, ErrSystemRole):
		writeRoleError(response, http.StatusConflict, "SYSTEM_ROLE_PROTECTED", "系统内置角色不可删除")
	case errors.Is(err, ErrUnavailable):
		writeRoleError(response, http.StatusServiceUnavailable, "ROLE_UNAVAILABLE", "角色服务暂时不可用")
	default:
		writeRoleError(response, http.StatusInternalServerError, "INTERNAL_ERROR", "服务暂时不可用")
	}
}

func writeRoleError(response http.ResponseWriter, status int, code, message string) {
	writeRoleJSON(response, status, struct {
		Error struct {
			Code    string `json:"code"`
			Message string `json:"message"`
		} `json:"error"`
	}{Error: struct {
		Code    string `json:"code"`
		Message string `json:"message"`
	}{Code: code, Message: message}})
}

func writeRoleJSON(response http.ResponseWriter, status int, document any) {
	response.Header().Set("Cache-Control", "no-store")
	response.Header().Set("Content-Type", "application/json")
	response.Header().Set("X-Content-Type-Options", "nosniff")
	response.WriteHeader(status)
	_ = json.NewEncoder(response).Encode(document)
}
