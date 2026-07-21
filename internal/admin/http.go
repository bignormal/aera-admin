package admin

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"math"
	"mime"
	"net/http"
	"strconv"
	"time"

	"github.com/bignormal/aera-admin/internal/audit"
	"github.com/bignormal/aera-admin/internal/auth"
	"github.com/bignormal/aera-admin/internal/rbac"
	"github.com/bignormal/aera-admin/internal/secure"
	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
)

const maximumAdminJSONBody = 64 << 10

type HandlerService interface {
	Invite(context.Context, Actor, InviteRequest) (InvitationResult, error)
	PrepareActivation(context.Context, string) (ActivationPreparation, error)
	Activate(context.Context, ActivateRequest) (ActivationResult, error)
	List(context.Context, Actor) ([]Administrator, error)
	ChangeRole(context.Context, Actor, uuid.UUID, rbac.Role, ActionReason) error
	Suspend(context.Context, Actor, uuid.UUID, ActionReason) error
	RevokeSessions(context.Context, Actor, uuid.UUID, ActionReason) error
	ResetTOTP(context.Context, Actor, uuid.UUID, ActionReason) (InvitationResult, error)
}

type ActivationAttemptLimiter interface {
	ReserveActivationAttempt(context.Context, []byte, []byte) (string, error)
	ReleaseActivationAttempt(context.Context, string, []byte, []byte) error
	CompleteActivationAttempt(context.Context, string, []byte, []byte) error
}

func NewHandler(service HandlerService) http.Handler {
	return newHandler(service, nil)
}

func NewHandlerWithActivationLimiter(service HandlerService, limiter ActivationAttemptLimiter) http.Handler {
	return newHandler(service, limiter)
}

func newHandler(service HandlerService, limiter ActivationAttemptLimiter) http.Handler {
	router := chi.NewRouter()
	router.Post("/auth/activation/prepare", prepareActivationHTTP(service, limiter))
	router.Post("/auth/activate", activateHTTP(service, limiter))
	router.With(requirePermission(rbac.ReadAdministrators)).Get("/admin-users", listAdministratorsHTTP(service))
	router.With(requirePermission(rbac.ManageAdministrators), requireRecentTOTP).Post("/admin-users/invitations", inviteAdministratorHTTP(service))
	router.With(requirePermission(rbac.ManageAdministrators), requireRecentTOTP).Put("/admin-users/{adminID}/role", changeAdministratorRoleHTTP(service))
	router.With(requirePermission(rbac.ManageAdministrators), requireRecentTOTP).Post("/admin-users/{adminID}/suspend", suspendAdministratorHTTP(service))
	router.With(requirePermission(rbac.ManageAdministrators), requireRecentTOTP).Post("/admin-users/{adminID}/sessions/revoke", revokeAdministratorSessionsHTTP(service))
	router.With(requirePermission(rbac.ManageAdministrators), requireRecentTOTP).Post("/admin-users/{adminID}/totp/reset", resetAdministratorTOTPHTTP(service))
	return http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		response.Header().Set("Cache-Control", "no-store")
		response.Header().Set("X-Content-Type-Options", "nosniff")
		router.ServeHTTP(response, request)
	})
}

func requireRecentTOTP(next http.Handler) http.Handler {
	return auth.RequireRecentTOTP(time.Now, next)
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

func prepareActivationHTTP(service HandlerService, limiter ActivationAttemptLimiter) http.HandlerFunc {
	return func(response http.ResponseWriter, request *http.Request) {
		var payload struct {
			Token string `json:"token"`
		}
		if err := decodeAdminJSON(response, request, &payload); err != nil {
			writeHTTPError(response, http.StatusBadRequest, "INVALID_REQUEST", "请求内容无效")
			return
		}
		subjectDigest := activationAttemptDigest(payload.Token)
		meta := requestMetaFromRequest(request)
		reservationID, err := reserveActivationAttempt(request.Context(), limiter, subjectDigest, meta.SourceIPHMAC)
		if err != nil {
			writeAdminDomainError(response, err)
			return
		}
		result, err := service.PrepareActivation(request.Context(), payload.Token)
		if err != nil {
			if !isActivationCredentialFailure(err) {
				err = releaseActivationAttempt(request.Context(), limiter, reservationID, subjectDigest, meta.SourceIPHMAC, err)
			}
			writeAdminDomainError(response, err)
			return
		}
		if err := releaseActivationAttempt(request.Context(), limiter, reservationID, subjectDigest, meta.SourceIPHMAC, nil); err != nil {
			writeAdminDomainError(response, err)
			return
		}
		writeAdminJSON(response, http.StatusOK, result)
	}
}

func activateHTTP(service HandlerService, limiter ActivationAttemptLimiter) http.HandlerFunc {
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
		subjectDigest := activationAttemptDigest(payload.Token)
		meta := requestMetaFromRequest(request)
		reservationID, err := reserveActivationAttempt(request.Context(), limiter, subjectDigest, meta.SourceIPHMAC)
		if err != nil {
			payload.Password = ""
			payload.TOTPCode = ""
			payload.Token = ""
			writeAdminDomainError(response, err)
			return
		}
		result, err := service.Activate(request.Context(), ActivateRequest{
			Token: payload.Token, Password: payload.Password, TOTPCode: payload.TOTPCode,
			Meta: meta,
		})
		payload.Password = ""
		payload.TOTPCode = ""
		payload.Token = ""
		if err != nil {
			if !isActivationCredentialFailure(err) {
				err = releaseActivationAttempt(request.Context(), limiter, reservationID, subjectDigest, meta.SourceIPHMAC, err)
			}
			writeAdminDomainError(response, err)
			return
		}
		if limiter != nil {
			if err := limiter.CompleteActivationAttempt(request.Context(), reservationID, subjectDigest, meta.SourceIPHMAC); err != nil {
				writeAdminDomainError(response, auth.ErrUnavailable)
				return
			}
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

func revokeAdministratorSessionsHTTP(service HandlerService) http.HandlerFunc {
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
		if err := service.RevokeSessions(request.Context(), actor, targetID, payload.reason(requestMetaFromRequest(request))); err != nil {
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
	if meta, ok := auth.RequestMetaFromContext(request.Context()); ok {
		return RequestMeta{
			RequestID: meta.RequestID, SourceIPHMAC: append([]byte(nil), meta.SourceIPHMAC...), UserAgent: meta.UserAgent,
		}
	}
	requestID := "req-" + uuid.NewString()
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
	var rateLimit *auth.RateLimitError
	switch {
	case errors.As(err, &rateLimit):
		seconds := int(math.Ceil(rateLimit.RetryAfter.Seconds()))
		if seconds < 1 {
			seconds = 1
		}
		if seconds > 900 {
			seconds = 900
		}
		response.Header().Set("Retry-After", strconv.Itoa(seconds))
		writeHTTPError(response, http.StatusTooManyRequests, "RATE_LIMITED", "尝试过于频繁，请稍后重试")
	case errors.Is(err, auth.ErrUnavailable):
		writeHTTPError(response, http.StatusServiceUnavailable, "AUTH_UNAVAILABLE", "认证服务暂时不可用")
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

func activationAttemptDigest(rawToken string) []byte {
	digest := secure.DigestOpaqueToken(rawToken)
	return append([]byte(nil), digest[:]...)
}

func reserveActivationAttempt(
	ctx context.Context,
	limiter ActivationAttemptLimiter,
	subjectDigest, sourceIPHMAC []byte,
) (string, error) {
	if limiter == nil {
		return "", nil
	}
	reservationID, err := limiter.ReserveActivationAttempt(ctx, subjectDigest, sourceIPHMAC)
	if err != nil {
		if errors.Is(err, auth.ErrRateLimited) {
			return "", err
		}
		return "", auth.ErrUnavailable
	}
	return reservationID, nil
}

func releaseActivationAttempt(
	ctx context.Context,
	limiter ActivationAttemptLimiter,
	reservationID string,
	subjectDigest, sourceIPHMAC []byte,
	domainErr error,
) error {
	if limiter == nil {
		return domainErr
	}
	if err := limiter.ReleaseActivationAttempt(ctx, reservationID, subjectDigest, sourceIPHMAC); err != nil {
		return auth.ErrUnavailable
	}
	return domainErr
}

func isActivationCredentialFailure(err error) bool {
	return errors.Is(err, ErrInvalidInvitation) || errors.Is(err, ErrInvalidActivation)
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
