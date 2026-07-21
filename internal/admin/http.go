package admin

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"mime"
	"net/http"
	"regexp"
	"strings"

	"github.com/bignormal/aera-admin/internal/audit"
	"github.com/bignormal/aera-admin/internal/auth"
	"github.com/bignormal/aera-admin/internal/rbac"
	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
)

const maximumAdminJSONBody = 64 << 10

var httpRequestIDPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$`)

type HandlerService interface {
	Invite(context.Context, Actor, InviteRequest) (InvitationResult, error)
	PrepareActivation(context.Context, string) (ActivationPreparation, error)
	Activate(context.Context, ActivateRequest) (ActivationResult, error)
	List(context.Context, Actor) ([]Administrator, error)
	ChangeRole(context.Context, Actor, uuid.UUID, rbac.Role, ActionReason) error
	Suspend(context.Context, Actor, uuid.UUID, ActionReason) error
	ResetTOTP(context.Context, Actor, uuid.UUID, ActionReason) (InvitationResult, error)
}

func NewHandler(service HandlerService) http.Handler {
	router := chi.NewRouter()
	router.Post("/auth/activation/prepare", prepareActivationHTTP(service))
	router.Post("/auth/activate", activateHTTP(service))
	router.With(requirePermission(rbac.ReadAdministrators)).Get("/admin-users", listAdministratorsHTTP(service))
	router.With(requirePermission(rbac.ManageAdministrators)).Post("/admin-users/invitations", inviteAdministratorHTTP(service))
	router.With(requirePermission(rbac.ManageAdministrators)).Put("/admin-users/{adminID}/role", changeAdministratorRoleHTTP(service))
	router.With(requirePermission(rbac.ManageAdministrators)).Post("/admin-users/{adminID}/suspend", suspendAdministratorHTTP(service))
	router.With(requirePermission(rbac.ManageAdministrators)).Post("/admin-users/{adminID}/totp/reset", resetAdministratorTOTPHTTP(service))
	return http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		response.Header().Set("Cache-Control", "no-store")
		response.Header().Set("X-Content-Type-Options", "nosniff")
		router.ServeHTTP(response, request)
	})
}

func requirePermission(permission rbac.Permission) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return auth.Require(permission, next)
	}
}

type reasonPayload struct {
	ReasonCode      string `json:"reason_code"`
	TicketReference string `json:"ticket_reference"`
	Note            string `json:"note"`
}

type invitePayload struct {
	Email       string    `json:"email"`
	DisplayName string    `json:"display_name"`
	Role        rbac.Role `json:"role"`
	reasonPayload
}

func inviteAdministratorHTTP(service HandlerService) http.HandlerFunc {
	return func(response http.ResponseWriter, request *http.Request) {
		actor, ok := actorFromRequest(request)
		if !ok {
			writeHTTPError(response, http.StatusUnauthorized, "AUTH_REQUIRED", "需要有效的管理员会话")
			return
		}
		var payload invitePayload
		if err := decodeAdminJSON(response, request, &payload); err != nil {
			writeHTTPError(response, http.StatusBadRequest, "INVALID_REQUEST", "请求内容无效")
			return
		}
		result, err := service.Invite(request.Context(), actor, InviteRequest{
			Email: payload.Email, DisplayName: payload.DisplayName, Role: payload.Role,
			Reason: payload.reason(requestMetaFromRequest(request)),
		})
		if err != nil {
			writeAdminDomainError(response, err)
			return
		}
		writeAdminJSON(response, http.StatusCreated, result)
	}
}

func prepareActivationHTTP(service HandlerService) http.HandlerFunc {
	return func(response http.ResponseWriter, request *http.Request) {
		var payload struct {
			Token string `json:"token"`
		}
		if err := decodeAdminJSON(response, request, &payload); err != nil {
			writeHTTPError(response, http.StatusBadRequest, "INVALID_REQUEST", "请求内容无效")
			return
		}
		result, err := service.PrepareActivation(request.Context(), payload.Token)
		if err != nil {
			writeAdminDomainError(response, err)
			return
		}
		writeAdminJSON(response, http.StatusOK, result)
	}
}

func activateHTTP(service HandlerService) http.HandlerFunc {
	return func(response http.ResponseWriter, request *http.Request) {
		var payload struct {
			Token    string `json:"token"`
			Password string `json:"password"`
			TOTPCode string `json:"totp_code"`
		}
		if err := decodeAdminJSON(response, request, &payload); err != nil {
			writeHTTPError(response, http.StatusBadRequest, "INVALID_REQUEST", "请求内容无效")
			return
		}
		result, err := service.Activate(request.Context(), ActivateRequest{
			Token: payload.Token, Password: payload.Password, TOTPCode: payload.TOTPCode,
			Meta: requestMetaFromRequest(request),
		})
		payload.Password = ""
		payload.TOTPCode = ""
		payload.Token = ""
		if err != nil {
			writeAdminDomainError(response, err)
			return
		}
		writeAdminJSON(response, http.StatusOK, result)
	}
}

func listAdministratorsHTTP(service HandlerService) http.HandlerFunc {
	return func(response http.ResponseWriter, request *http.Request) {
		actor, ok := actorFromRequest(request)
		if !ok {
			writeHTTPError(response, http.StatusUnauthorized, "AUTH_REQUIRED", "需要有效的管理员会话")
			return
		}
		items, err := service.List(request.Context(), actor)
		if err != nil {
			writeAdminDomainError(response, err)
			return
		}
		writeAdminJSON(response, http.StatusOK, struct {
			Items []Administrator `json:"items"`
		}{Items: items})
	}
}

type rolePayload struct {
	Role rbac.Role `json:"role"`
	reasonPayload
}

func changeAdministratorRoleHTTP(service HandlerService) http.HandlerFunc {
	return func(response http.ResponseWriter, request *http.Request) {
		actor, targetID, ok := actorAndTargetFromRequest(request)
		if !ok {
			writeHTTPError(response, http.StatusBadRequest, "INVALID_REQUEST", "请求内容无效")
			return
		}
		var payload rolePayload
		if err := decodeAdminJSON(response, request, &payload); err != nil {
			writeHTTPError(response, http.StatusBadRequest, "INVALID_REQUEST", "请求内容无效")
			return
		}
		if err := service.ChangeRole(request.Context(), actor, targetID, payload.Role, payload.reason(requestMetaFromRequest(request))); err != nil {
			writeAdminDomainError(response, err)
			return
		}
		writeAdminJSON(response, http.StatusOK, map[string]string{"status": "ok"})
	}
}

func suspendAdministratorHTTP(service HandlerService) http.HandlerFunc {
	return func(response http.ResponseWriter, request *http.Request) {
		actor, targetID, ok := actorAndTargetFromRequest(request)
		if !ok {
			writeHTTPError(response, http.StatusBadRequest, "INVALID_REQUEST", "请求内容无效")
			return
		}
		var payload reasonPayload
		if err := decodeAdminJSON(response, request, &payload); err != nil {
			writeHTTPError(response, http.StatusBadRequest, "INVALID_REQUEST", "请求内容无效")
			return
		}
		if err := service.Suspend(request.Context(), actor, targetID, payload.reason(requestMetaFromRequest(request))); err != nil {
			writeAdminDomainError(response, err)
			return
		}
		writeAdminJSON(response, http.StatusOK, map[string]string{"status": "ok"})
	}
}

func resetAdministratorTOTPHTTP(service HandlerService) http.HandlerFunc {
	return func(response http.ResponseWriter, request *http.Request) {
		actor, targetID, ok := actorAndTargetFromRequest(request)
		if !ok {
			writeHTTPError(response, http.StatusBadRequest, "INVALID_REQUEST", "请求内容无效")
			return
		}
		var payload reasonPayload
		if err := decodeAdminJSON(response, request, &payload); err != nil {
			writeHTTPError(response, http.StatusBadRequest, "INVALID_REQUEST", "请求内容无效")
			return
		}
		result, err := service.ResetTOTP(request.Context(), actor, targetID, payload.reason(requestMetaFromRequest(request)))
		if err != nil {
			writeAdminDomainError(response, err)
			return
		}
		writeAdminJSON(response, http.StatusCreated, result)
	}
}

func (payload reasonPayload) reason(meta RequestMeta) ActionReason {
	return ActionReason{
		Code: payload.ReasonCode, TicketReference: payload.TicketReference, Note: payload.Note, Meta: meta,
	}
}

func actorFromRequest(request *http.Request) (Actor, bool) {
	principal, ok := auth.PrincipalFromContext(request.Context())
	if !ok || !principal.Role.Valid() {
		return Actor{}, false
	}
	adminID, err := uuid.Parse(principal.AdminID)
	if err != nil || adminID == uuid.Nil {
		return Actor{}, false
	}
	return Actor{AdminID: adminID, Role: principal.Role, Meta: requestMetaFromRequest(request)}, true
}

func actorAndTargetFromRequest(request *http.Request) (Actor, uuid.UUID, bool) {
	actor, ok := actorFromRequest(request)
	if !ok {
		return Actor{}, uuid.Nil, false
	}
	targetID, err := uuid.Parse(chi.URLParam(request, "adminID"))
	if err != nil || targetID == uuid.Nil {
		return Actor{}, uuid.Nil, false
	}
	return actor, targetID, true
}

func requestMetaFromRequest(request *http.Request) RequestMeta {
	requestID := strings.TrimSpace(request.Header.Get("X-Request-ID"))
	if !httpRequestIDPattern.MatchString(requestID) {
		requestID = "req-" + uuid.NewString()
	}
	return RequestMeta{RequestID: requestID, UserAgent: request.UserAgent()}
}

func decodeAdminJSON(response http.ResponseWriter, request *http.Request, target any) error {
	mediaType, _, err := mime.ParseMediaType(request.Header.Get("Content-Type"))
	if err != nil || mediaType != "application/json" {
		return errors.New("request content type is invalid")
	}
	request.Body = http.MaxBytesReader(response, request.Body, maximumAdminJSONBody)
	decoder := json.NewDecoder(request.Body)
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(target); err != nil {
		return errors.New("request JSON is invalid")
	}
	var extra any
	if err := decoder.Decode(&extra); !errors.Is(err, io.EOF) {
		return errors.New("request must contain one JSON object")
	}
	return nil
}

func writeAdminDomainError(response http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, ErrInvalidInvitation), errors.Is(err, ErrInvalidActivation):
		writeHTTPError(response, http.StatusBadRequest, "ACTIVATION_INVALID", "激活信息无效或已过期")
	case errors.Is(err, ErrInvalidRequest), errors.Is(err, audit.ErrInvalidRecord), errors.Is(err, audit.ErrSensitiveText):
		writeHTTPError(response, http.StatusBadRequest, "INVALID_REQUEST", "请求内容无效")
	case errors.Is(err, ErrPermissionDenied):
		writeHTTPError(response, http.StatusForbidden, "PERMISSION_DENIED", "没有执行此操作的权限")
	case errors.Is(err, ErrAdministratorNotFound):
		writeHTTPError(response, http.StatusNotFound, "ADMINISTRATOR_NOT_FOUND", "管理员不存在")
	case errors.Is(err, ErrIdentityExists):
		writeHTTPError(response, http.StatusConflict, "ADMINISTRATOR_IDENTITY_EXISTS", "该内部身份已存在")
	case errors.Is(err, ErrBootstrapIncomplete):
		writeHTTPError(response, http.StatusConflict, "BOOTSTRAP_INCOMPLETE", "需要先完成两名超级管理员初始化")
	case errors.Is(err, ErrBootstrapComplete):
		writeHTTPError(response, http.StatusConflict, "BOOTSTRAP_COMPLETE", "超级管理员初始化已经完成")
	case errors.Is(err, ErrMinimumSuperAdmins):
		writeHTTPError(response, http.StatusConflict, "MINIMUM_SUPER_ADMINS_REQUIRED", "必须保留至少两名有效超级管理员")
	case errors.Is(err, ErrSelfManagement):
		writeHTTPError(response, http.StatusConflict, "SELF_MANAGEMENT_FORBIDDEN", "不能对自己执行此操作")
	case errors.Is(err, ErrStateConflict):
		writeHTTPError(response, http.StatusConflict, "ADMINISTRATOR_STATE_CONFLICT", "管理员状态已变化，请刷新后重试")
	default:
		writeHTTPError(response, http.StatusInternalServerError, "INTERNAL_ERROR", "服务暂时不可用")
	}
}

func writeHTTPError(response http.ResponseWriter, status int, code, message string) {
	writeAdminJSON(response, status, struct {
		Error struct {
			Code    string `json:"code"`
			Message string `json:"message"`
		} `json:"error"`
	}{Error: struct {
		Code    string `json:"code"`
		Message string `json:"message"`
	}{Code: code, Message: message}})
}

func writeAdminJSON(response http.ResponseWriter, status int, document any) {
	response.Header().Set("Cache-Control", "no-store")
	response.Header().Set("Content-Type", "application/json")
	response.Header().Set("X-Content-Type-Options", "nosniff")
	response.WriteHeader(status)
	_ = json.NewEncoder(response).Encode(document)
}

var _ HandlerService = (*Service)(nil)
