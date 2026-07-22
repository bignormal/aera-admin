package settings

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
	"github.com/google/uuid"
)

const maximumSettingsJSONBody = 64 << 10

type HandlerService interface {
	GetPolicy(context.Context) (Policy, error)
	ListReasonCodes(context.Context, ReasonQuery) (Page, error)
	UpdatePolicy(context.Context, MutationContext, UpdatePolicyInput) (PolicyMutationResult, error)
	CreateReasonCode(context.Context, MutationContext, CreateReasonCodeInput) (ReasonMutationResult, error)
	UpdateReasonCode(context.Context, MutationContext, string, UpdateReasonCodeInput) (ReasonMutationResult, error)
}

func NewHandler(service HandlerService) http.Handler {
	return NewHandlerWithClock(service, time.Now)
}

func NewHandlerWithClock(service HandlerService, clock func() time.Time) http.Handler {
	if service == nil {
		panic("settings HTTP service is required")
	}
	if clock == nil {
		clock = time.Now
	}
	router := chi.NewRouter()
	router.With(settingsPermission(rbac.ReadSystemSettings)).Get("/system/settings", getPolicyHTTP(service))
	router.With(settingsPermission(rbac.ManageSystemSettings), settingsRecentTOTP(clock)).
		Put("/system/settings/security-policy", updatePolicyHTTP(service))
	router.Get("/system/reason-codes", listReasonCodesHTTP(service))
	router.With(settingsPermission(rbac.ManageSystemSettings), settingsRecentTOTP(clock)).
		Post("/system/reason-codes", createReasonCodeHTTP(service))
	router.With(settingsPermission(rbac.ManageSystemSettings), settingsRecentTOTP(clock)).
		Put("/system/reason-codes/{code}", updateReasonCodeHTTP(service))
	router.NotFound(func(response http.ResponseWriter, request *http.Request) {
		writeSettingsError(response, request, http.StatusNotFound, "NOT_FOUND", "请求的资源不存在")
	})
	router.MethodNotAllowed(func(response http.ResponseWriter, request *http.Request) {
		writeSettingsError(response, request, http.StatusMethodNotAllowed, "METHOD_NOT_ALLOWED", "请求方法不受支持")
	})
	return http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		response.Header().Set("Cache-Control", "no-store")
		response.Header().Set("Content-Type", "application/json")
		response.Header().Set("X-Content-Type-Options", "nosniff")
		router.ServeHTTP(response, request)
	})
}

func settingsPermission(permission rbac.Permission) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return auth.Require(permission, next)
	}
}

func settingsRecentTOTP(clock func() time.Time) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return auth.RequireRecentTOTP(clock, next)
	}
}

func getPolicyHTTP(service HandlerService) http.HandlerFunc {
	return func(response http.ResponseWriter, request *http.Request) {
		policy, err := service.GetPolicy(request.Context())
		if err != nil {
			writeSettingsDomainError(response, request, err, false)
			return
		}
		writeSettingsJSON(response, http.StatusOK, policy)
	}
}

func listReasonCodesHTTP(service HandlerService) http.HandlerFunc {
	return func(response http.ResponseWriter, request *http.Request) {
		principal, ok := auth.PrincipalFromContext(request.Context())
		if !ok || principal.AdminID == "" || !principal.Role.Valid() {
			writeSettingsError(response, request, http.StatusUnauthorized, "AUTH_REQUIRED", "需要有效的管理员会话")
			return
		}
		query, err := parseReasonQuery(request)
		if err != nil {
			writeSettingsError(response, request, http.StatusBadRequest, "INVALID_REQUEST", "原因码查询条件无效")
			return
		}
		if query.Usage == "" && !rbac.Allowed(principal.Role, rbac.ReadSystemSettings) {
			writeSettingsError(response, request, http.StatusForbidden, "PERMISSION_DENIED", "没有查看完整原因目录的权限")
			return
		}
		page, err := service.ListReasonCodes(request.Context(), query)
		if err != nil {
			writeSettingsDomainError(response, request, err, false)
			return
		}
		writeSettingsJSON(response, http.StatusOK, page)
	}
}

func updatePolicyHTTP(service HandlerService) http.HandlerFunc {
	return func(response http.ResponseWriter, request *http.Request) {
		mutation, ok := settingsMutationContext(response, request)
		if !ok {
			return
		}
		var input UpdatePolicyInput
		if err := decodeSettingsJSON(response, request, &input); err != nil {
			writeSettingsError(response, request, http.StatusBadRequest, "INVALID_REQUEST", "请求内容无效")
			return
		}
		if err := input.Validate(); err != nil {
			writeSettingsError(response, request, http.StatusBadRequest, "SETTINGS_POLICY_INVALID", "安全策略参数无效")
			return
		}
		result, err := service.UpdatePolicy(request.Context(), mutation, input)
		if err != nil {
			writeSettingsDomainError(response, request, err, true)
			return
		}
		writeSettingsJSON(response, http.StatusOK, result)
	}
}

func createReasonCodeHTTP(service HandlerService) http.HandlerFunc {
	return func(response http.ResponseWriter, request *http.Request) {
		mutation, ok := settingsMutationContext(response, request)
		if !ok {
			return
		}
		var input CreateReasonCodeInput
		if err := decodeSettingsJSON(response, request, &input); err != nil || input.Validate() != nil {
			writeSettingsError(response, request, http.StatusBadRequest, "INVALID_REQUEST", "请求内容无效")
			return
		}
		result, err := service.CreateReasonCode(request.Context(), mutation, input)
		if err != nil {
			writeSettingsDomainError(response, request, err, false)
			return
		}
		writeSettingsJSON(response, http.StatusCreated, result)
	}
}

func updateReasonCodeHTTP(service HandlerService) http.HandlerFunc {
	return func(response http.ResponseWriter, request *http.Request) {
		mutation, ok := settingsMutationContext(response, request)
		if !ok {
			return
		}
		code := chi.URLParam(request, "code")
		var input UpdateReasonCodeInput
		if !reasonCodePattern.MatchString(code) {
			writeSettingsError(response, request, http.StatusBadRequest, "INVALID_REQUEST", "请求内容无效")
			return
		}
		if err := decodeSettingsJSON(response, request, &input); err != nil || input.Validate() != nil {
			writeSettingsError(response, request, http.StatusBadRequest, "INVALID_REQUEST", "请求内容无效")
			return
		}
		result, err := service.UpdateReasonCode(request.Context(), mutation, code, input)
		if err != nil {
			writeSettingsDomainError(response, request, err, false)
			return
		}
		writeSettingsJSON(response, http.StatusOK, result)
	}
}

func parseReasonQuery(request *http.Request) (ReasonQuery, error) {
	values := request.URL.Query()
	allowed := map[string]struct{}{"usage": {}, "category": {}, "include_inactive": {}}
	for key, entries := range values {
		if _, ok := allowed[key]; !ok || len(entries) != 1 {
			return ReasonQuery{}, ErrInvalidRequest
		}
	}
	query := ReasonQuery{
		Usage: ReasonUsage(values.Get("usage")), Category: ReasonCategory(values.Get("category")),
	}
	if raw := values.Get("include_inactive"); raw != "" {
		if raw != "true" && raw != "false" {
			return ReasonQuery{}, ErrInvalidRequest
		}
		query.IncludeInactive = raw == "true"
	}
	if err := query.Validate(); err != nil {
		return ReasonQuery{}, err
	}
	return query, nil
}

func settingsMutationContext(response http.ResponseWriter, request *http.Request) (MutationContext, bool) {
	principal, ok := auth.PrincipalFromContext(request.Context())
	if !ok || principal.AdminID == "" || !principal.Role.Valid() {
		writeSettingsError(response, request, http.StatusUnauthorized, "AUTH_REQUIRED", "需要有效的管理员会话")
		return MutationContext{}, false
	}
	adminID, err := uuid.Parse(principal.AdminID)
	if err != nil || adminID == uuid.Nil {
		writeSettingsError(response, request, http.StatusUnauthorized, "AUTH_REQUIRED", "需要有效的管理员会话")
		return MutationContext{}, false
	}
	idempotencyKey := request.Header.Get("Idempotency-Key")
	if !idempotencyKeyPattern.MatchString(idempotencyKey) {
		writeSettingsError(response, request, http.StatusBadRequest, "INVALID_REQUEST", "Idempotency-Key 无效")
		return MutationContext{}, false
	}
	meta, ok := auth.RequestMetaFromContext(request.Context())
	if !ok || meta.RequestID == "" {
		writeSettingsError(response, request, http.StatusServiceUnavailable, "SETTINGS_UNAVAILABLE", "系统设置服务暂时不可用")
		return MutationContext{}, false
	}
	mutation := MutationContext{
		ActorAdminID: adminID, ActorRole: principal.Role, IdempotencyKey: idempotencyKey,
		RequestID: meta.RequestID, SourceIPHMAC: append([]byte(nil), meta.SourceIPHMAC...), UserAgent: meta.UserAgent,
	}
	if mutation.Validate() != nil {
		writeSettingsError(response, request, http.StatusBadRequest, "INVALID_REQUEST", "请求上下文无效")
		return MutationContext{}, false
	}
	return mutation, true
}

func decodeSettingsJSON(response http.ResponseWriter, request *http.Request, target any) error {
	mediaType, _, err := mime.ParseMediaType(request.Header.Get("Content-Type"))
	if err != nil || mediaType != "application/json" {
		return ErrInvalidRequest
	}
	request.Body = http.MaxBytesReader(response, request.Body, maximumSettingsJSONBody)
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

func writeSettingsDomainError(response http.ResponseWriter, request *http.Request, err error, policy bool) {
	switch {
	case errors.Is(err, ErrInvalidRequest) && policy:
		writeSettingsError(response, request, http.StatusBadRequest, "SETTINGS_POLICY_INVALID", "安全策略参数无效")
	case errors.Is(err, ErrInvalidRequest):
		writeSettingsError(response, request, http.StatusBadRequest, "INVALID_REQUEST", "请求内容无效")
	case errors.Is(err, ErrPermissionDenied):
		writeSettingsError(response, request, http.StatusForbidden, "PERMISSION_DENIED", "没有执行此操作的权限")
	case errors.Is(err, ErrRevisionConflict):
		writeSettingsError(response, request, http.StatusConflict, "SETTINGS_REVISION_CONFLICT", "设置版本已变化，请刷新后重试")
	case errors.Is(err, ErrIdempotencyKeyReused):
		writeSettingsError(response, request, http.StatusConflict, "IDEMPOTENCY_KEY_REUSED", "幂等键已用于其他请求")
	case errors.Is(err, ErrReasonExists):
		writeSettingsError(response, request, http.StatusConflict, "REASON_CODE_ALREADY_EXISTS", "原因码已存在")
	case errors.Is(err, ErrReasonNotFound):
		writeSettingsError(response, request, http.StatusNotFound, "REASON_CODE_NOT_FOUND", "原因码不存在")
	case errors.Is(err, ErrReasonInactive):
		writeSettingsError(response, request, http.StatusConflict, "REASON_CODE_INACTIVE", "原因码已停用")
	case errors.Is(err, ErrReasonIncompatible):
		writeSettingsError(response, request, http.StatusConflict, "REASON_CODE_CATEGORY_MISMATCH", "原因码不适用于此操作")
	case errors.Is(err, ErrLastActiveReason):
		writeSettingsError(response, request, http.StatusConflict, "REASON_CODE_LAST_ACTIVE", "每个分类必须保留至少一个有效原因码")
	case errors.Is(err, ErrReasonProtected):
		writeSettingsError(response, request, http.StatusConflict, "REASON_CODE_PROTECTED", "受保护原因码不能停用")
	case errors.Is(err, ErrUnavailable):
		writeSettingsError(response, request, http.StatusServiceUnavailable, "SETTINGS_UNAVAILABLE", "系统设置服务暂时不可用")
	default:
		writeSettingsError(response, request, http.StatusInternalServerError, "INTERNAL_ERROR", "服务暂时不可用")
	}
}

func writeSettingsError(response http.ResponseWriter, request *http.Request, status int, code, message string) {
	requestID := ""
	if meta, ok := auth.RequestMetaFromContext(request.Context()); ok {
		requestID = meta.RequestID
	}
	writeSettingsJSON(response, status, struct {
		Error struct {
			Code      string `json:"code"`
			Message   string `json:"message"`
			RequestID string `json:"request_id,omitempty"`
		} `json:"error"`
	}{Error: struct {
		Code      string `json:"code"`
		Message   string `json:"message"`
		RequestID string `json:"request_id,omitempty"`
	}{Code: code, Message: message, RequestID: requestID}})
}

func writeSettingsJSON(response http.ResponseWriter, status int, document any) {
	response.Header().Set("Cache-Control", "no-store")
	response.Header().Set("Content-Type", "application/json")
	response.Header().Set("X-Content-Type-Options", "nosniff")
	response.WriteHeader(status)
	_ = json.NewEncoder(response).Encode(document)
}
