package cloudcontrol

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"mime"
	"net/http"
	"strconv"
	"time"

	"github.com/bignormal/aera-admin/internal/admin"
	"github.com/bignormal/aera-admin/internal/approval"
	"github.com/bignormal/aera-admin/internal/auth"
	"github.com/bignormal/aera-admin/internal/cloudadmin"
	"github.com/bignormal/aera-admin/internal/operations"
	"github.com/bignormal/aera-admin/internal/rbac"
	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
)

const (
	maximumJSONBody   = 64 << 10
	maximumLookupBody = 4 << 10
)

type HandlerService interface {
	ListUsers(context.Context, admin.Actor, cloudadmin.ListUsersRequest) (cloudadmin.Page[cloudadmin.User], error)
	LookupUser(context.Context, admin.Actor, cloudadmin.LookupRequest) (cloudadmin.User, error)
	GetUser(context.Context, admin.Actor, uuid.UUID) (cloudadmin.User, error)
	ListDevices(context.Context, admin.Actor, uuid.UUID, cloudadmin.PageRequest) (cloudadmin.Page[cloudadmin.Device], error)
	ListSessions(context.Context, admin.Actor, uuid.UUID, cloudadmin.PageRequest) (cloudadmin.Page[cloudadmin.Session], error)
	RevokeDevice(context.Context, admin.Actor, uuid.UUID, int64, admin.ActionReason, string) (operations.Result, error)
	RevokeSession(context.Context, admin.Actor, uuid.UUID, int64, admin.ActionReason, string) (operations.Result, error)
	CreateApproval(context.Context, approval.CreateRequest) (approval.Request, error)
	ListApprovals(context.Context, admin.Actor, approval.ListFilter) (approval.Page, error)
	GetApproval(context.Context, admin.Actor, uuid.UUID) (approval.Request, error)
	ApproveApproval(context.Context, admin.Actor, uuid.UUID, string) (approval.Request, error)
	RejectApproval(context.Context, admin.Actor, uuid.UUID) (approval.Request, error)
	CancelApproval(context.Context, admin.Actor, uuid.UUID) (approval.Request, error)
	GetOperation(context.Context, admin.Actor, uuid.UUID) (operations.Result, error)
	Health(context.Context, admin.Actor) (HealthDocument, error)
}

type reasonPayload struct {
	ReasonCode      string `json:"reason_code"`
	TicketReference string `json:"ticket_reference"`
	Note            string `json:"note"`
}

type mutationPayload struct {
	ExpectedRevision int64 `json:"expected_revision"`
	reasonPayload
}

type errorResponse struct {
	match   error
	status  int
	code    string
	message string
}

var errorResponses = []errorResponse{
	{ErrInvalidRequest, http.StatusBadRequest, "INVALID_REQUEST", "请求内容无效"},
	{operations.ErrInvalidRequest, http.StatusBadRequest, "INVALID_REQUEST", "请求内容无效"},
	{approval.ErrInvalidRequest, http.StatusBadRequest, "INVALID_REQUEST", "请求内容无效"},
	{operations.ErrIdempotencyKeyReused, http.StatusConflict, "IDEMPOTENCY_KEY_REUSED", "幂等键已用于其他操作"},
	{approval.ErrSelfReview, http.StatusForbidden, "APPROVAL_SELF_REVIEW_FORBIDDEN", "发起人不能审批自己的申请"},
	{approval.ErrExpired, http.StatusConflict, "APPROVAL_EXPIRED", "审批申请已过期"},
	{approval.ErrStateConflict, http.StatusConflict, "APPROVAL_STATE_CONFLICT", "申请状态已变化，请刷新后重试"},
	{operations.ErrStateConflict, http.StatusConflict, "OPERATION_STATE_CONFLICT", "操作状态已变化，请刷新后重试"},
	{approval.ErrTargetState, http.StatusConflict, "TARGET_STATE_CONFLICT", "目标状态不允许执行此操作"},
	{operations.ErrCloudUnavailable, http.StatusServiceUnavailable, "CLOUD_UNAVAILABLE", "Cloud 管理服务暂时不可用"},
	{cloudadmin.ErrNotConfigured, http.StatusServiceUnavailable, "CLOUD_NOT_CONFIGURED", "Cloud 管理服务尚未配置"},
	{cloudadmin.ErrUnavailable, http.StatusServiceUnavailable, "CLOUD_UNAVAILABLE", "Cloud 管理服务暂时不可用"},
	{cloudadmin.ErrContractViolation, http.StatusBadGateway, "CLOUD_CONTRACT_VIOLATION", "Cloud 管理服务响应不符合安全契约"},
}

func NewHandler(service HandlerService) http.Handler {
	return NewHandlerWithLogger(service, slog.Default())
}

func NewHandlerWithLogger(service HandlerService, logger *slog.Logger) http.Handler {
	if service == nil {
		panic("Cloud control HandlerService is required")
	}
	if logger == nil {
		logger = slog.Default()
	}
	router := chi.NewRouter()
	router.With(requirePermission(rbac.ReadCloudUsers)).Get("/cloud-users", listUsersHTTP(service, logger))
	router.With(requirePermission(rbac.ExactIdentityLookup)).Post("/cloud-users/lookup", lookupUserHTTP(service, logger))
	router.With(anyPermission(rbac.ReadCloudUsers, rbac.ReadTechnicalUserFields)).Get("/cloud-users/{userID}", getUserHTTP(service))
	router.With(requirePermission(rbac.ReadCloudDevices)).Get("/cloud-users/{userID}/devices", listDevicesHTTP(service))
	router.With(requirePermission(rbac.ReadCloudDevices)).Get("/cloud-users/{userID}/sessions", listSessionsHTTP(service))
	router.With(requirePermission(rbac.RevokeCloudDevice), recentTOTP()).Post("/cloud-devices/{deviceID}/revoke", revokeDeviceHTTP(service))
	router.With(requirePermission(rbac.RevokeCloudSession), recentTOTP()).Post("/cloud-sessions/{sessionID}/revoke", revokeSessionHTTP(service))
	router.With(requirePermission(rbac.InitiateAccountLifecycle), recentTOTP()).Post("/approval-requests", createApprovalHTTP(service))
	router.With(anyPermission(rbac.InitiateAccountLifecycle, rbac.ApproveAccountLifecycle)).Get("/approval-requests", listApprovalsHTTP(service))
	router.With(anyPermission(rbac.InitiateAccountLifecycle, rbac.ApproveAccountLifecycle)).Get("/approval-requests/{approvalID}", getApprovalHTTP(service))
	router.With(requirePermission(rbac.ApproveAccountLifecycle), recentTOTP()).Post("/approval-requests/{approvalID}/approve", approveApprovalHTTP(service))
	router.With(requirePermission(rbac.ApproveAccountLifecycle), recentTOTP()).Post("/approval-requests/{approvalID}/reject", rejectApprovalHTTP(service))
	router.With(requirePermission(rbac.InitiateAccountLifecycle), recentTOTP()).Post("/approval-requests/{approvalID}/cancel", cancelApprovalHTTP(service))
	router.With(anyPermission(rbac.RevokeCloudDevice, rbac.RevokeCloudSession, rbac.ApproveAccountLifecycle)).Get("/operations/{operationID}", getOperationHTTP(service))
	router.With(requirePermission(rbac.ReadServiceHealth)).Get("/system/health", healthHTTP(service))
	return noStore(router)
}

func requirePermission(permission rbac.Permission) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return auth.Require(permission, next)
	}
}

func recentTOTP() func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return auth.RequireRecentTOTP(time.Now, next)
	}
}

func anyPermission(permissions ...rbac.Permission) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
			principal, ok := auth.PrincipalFromContext(request.Context())
			if !ok || principal.AdminID == "" || !principal.Role.Valid() {
				writeError(response, http.StatusUnauthorized, "AUTH_REQUIRED", "需要有效的管理员会话")
				return
			}
			for _, permission := range permissions {
				if rbac.Allowed(principal.Role, permission) {
					next.ServeHTTP(response, request)
					return
				}
			}
			writeError(response, http.StatusForbidden, "PERMISSION_DENIED", "没有执行此操作的权限")
		})
	}
}

func actorFromRequest(request *http.Request) (admin.Actor, bool) {
	principal, ok := auth.PrincipalFromContext(request.Context())
	if !ok || !principal.Role.Valid() {
		return admin.Actor{}, false
	}
	id, err := uuid.Parse(principal.AdminID)
	if err != nil || id == uuid.Nil {
		return admin.Actor{}, false
	}
	meta := admin.RequestMeta{RequestID: "req-" + uuid.NewString(), UserAgent: request.UserAgent()}
	if authenticatedMeta, present := auth.RequestMetaFromContext(request.Context()); present {
		meta = admin.RequestMeta{
			RequestID: authenticatedMeta.RequestID, SourceIPHMAC: append([]byte(nil), authenticatedMeta.SourceIPHMAC...),
			UserAgent: authenticatedMeta.UserAgent,
		}
	}
	return admin.Actor{AdminID: id, Role: principal.Role, Meta: meta}, true
}

func decodeJSON(response http.ResponseWriter, request *http.Request, maximum int64, target any) error {
	mediaType, _, err := mime.ParseMediaType(request.Header.Get("Content-Type"))
	if err != nil || mediaType != "application/json" {
		return ErrInvalidRequest
	}
	request.Body = http.MaxBytesReader(response, request.Body, maximum)
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

func writeJSON(response http.ResponseWriter, status int, value any) {
	var encoded bytes.Buffer
	if err := json.NewEncoder(&encoded).Encode(value); err != nil {
		response.Header().Set("Content-Type", "application/json")
		response.WriteHeader(http.StatusInternalServerError)
		_, _ = response.Write([]byte(`{"error":{"code":"INTERNAL_ERROR","message":"系统暂时无法完成请求"}}`))
		return
	}
	response.Header().Set("Content-Type", "application/json")
	response.WriteHeader(status)
	_, _ = response.Write(encoded.Bytes())
}

func requestActor(response http.ResponseWriter, request *http.Request) (admin.Actor, bool) {
	actor, ok := actorFromRequest(request)
	if !ok {
		writeError(response, http.StatusUnauthorized, "AUTH_REQUIRED", "需要有效的管理员会话")
	}
	return actor, ok
}

func parseID(response http.ResponseWriter, request *http.Request, name string) (uuid.UUID, bool) {
	id, err := uuid.Parse(chi.URLParam(request, name))
	if err != nil || id == uuid.Nil {
		writeError(response, http.StatusBadRequest, "INVALID_REQUEST", "请求内容无效")
		return uuid.Nil, false
	}
	return id, true
}

func pageFromRequest(request *http.Request) (cloudadmin.PageRequest, error) {
	limit := 50
	if raw := request.URL.Query().Get("limit"); raw != "" {
		parsed, err := strconv.Atoi(raw)
		if err != nil {
			return cloudadmin.PageRequest{}, ErrInvalidRequest
		}
		limit = parsed
	}
	page := cloudadmin.PageRequest{Cursor: request.URL.Query().Get("cursor"), Limit: limit}
	if page.Limit < 1 || page.Limit > 100 || len(page.Cursor) > 512 {
		return cloudadmin.PageRequest{}, ErrInvalidRequest
	}
	return page, nil
}

func listUsersHTTP(service HandlerService, logger *slog.Logger) http.HandlerFunc {
	return func(response http.ResponseWriter, request *http.Request) {
		actor, ok := requestActor(response, request)
		if !ok {
			return
		}
		page, err := pageFromRequest(request)
		if err != nil {
			writeDomainError(response, err)
			return
		}
		input := cloudadmin.ListUsersRequest{
			PageRequest: page,
			Status:      cloudadmin.UserStatus(request.URL.Query().Get("status")),
		}
		result, err := service.ListUsers(request.Context(), actor, input)
		logger.Info("Cloud user list", "result", stableHTTPResult(err), "request_id", actor.Meta.RequestID)
		if err != nil {
			writeDomainError(response, err)
			return
		}
		writeJSON(response, http.StatusOK, result)
	}
}

func lookupUserHTTP(service HandlerService, logger *slog.Logger) http.HandlerFunc {
	return func(response http.ResponseWriter, request *http.Request) {
		actor, ok := requestActor(response, request)
		if !ok {
			return
		}
		var input cloudadmin.LookupRequest
		if err := decodeJSON(response, request, maximumLookupBody, &input); err != nil {
			writeDomainError(response, err)
			return
		}
		result, err := service.LookupUser(request.Context(), actor, input)
		logger.Info(
			"Cloud exact identity lookup", "kind", input.Kind,
			"result", stableHTTPResult(err), "request_id", actor.Meta.RequestID,
		)
		input.Value = ""
		if err != nil {
			writeDomainError(response, err)
			return
		}
		writeJSON(response, http.StatusOK, result)
	}
}

func getUserHTTP(service HandlerService) http.HandlerFunc {
	return func(response http.ResponseWriter, request *http.Request) {
		actor, ok := requestActor(response, request)
		if !ok {
			return
		}
		id, ok := parseID(response, request, "userID")
		if !ok {
			return
		}
		result, err := service.GetUser(request.Context(), actor, id)
		if err != nil {
			writeDomainError(response, err)
			return
		}
		writeJSON(response, http.StatusOK, result)
	}
}

func listDevicesHTTP(service HandlerService) http.HandlerFunc {
	return func(response http.ResponseWriter, request *http.Request) {
		actor, ok := requestActor(response, request)
		if !ok {
			return
		}
		id, ok := parseID(response, request, "userID")
		if !ok {
			return
		}
		page, err := pageFromRequest(request)
		if err != nil {
			writeDomainError(response, err)
			return
		}
		result, err := service.ListDevices(request.Context(), actor, id, page)
		if err != nil {
			writeDomainError(response, err)
			return
		}
		writeJSON(response, http.StatusOK, result)
	}
}

func listSessionsHTTP(service HandlerService) http.HandlerFunc {
	return func(response http.ResponseWriter, request *http.Request) {
		actor, ok := requestActor(response, request)
		if !ok {
			return
		}
		id, ok := parseID(response, request, "userID")
		if !ok {
			return
		}
		page, err := pageFromRequest(request)
		if err != nil {
			writeDomainError(response, err)
			return
		}
		result, err := service.ListSessions(request.Context(), actor, id, page)
		if err != nil {
			writeDomainError(response, err)
			return
		}
		writeJSON(response, http.StatusOK, result)
	}
}

func mutationReason(payload mutationPayload, actor admin.Actor) admin.ActionReason {
	return admin.ActionReason{
		Code: payload.ReasonCode, TicketReference: payload.TicketReference, Note: payload.Note, Meta: actor.Meta,
	}
}

func revokeDeviceHTTP(service HandlerService) http.HandlerFunc {
	return func(response http.ResponseWriter, request *http.Request) {
		actor, ok := requestActor(response, request)
		if !ok {
			return
		}
		id, ok := parseID(response, request, "deviceID")
		if !ok {
			return
		}
		var payload mutationPayload
		if err := decodeJSON(response, request, maximumJSONBody, &payload); err != nil {
			writeDomainError(response, err)
			return
		}
		result, err := service.RevokeDevice(
			request.Context(), actor, id, payload.ExpectedRevision,
			mutationReason(payload, actor), request.Header.Get("Idempotency-Key"),
		)
		if err != nil {
			writeDomainError(response, err)
			return
		}
		writeJSON(response, http.StatusAccepted, result)
	}
}

func revokeSessionHTTP(service HandlerService) http.HandlerFunc {
	return func(response http.ResponseWriter, request *http.Request) {
		actor, ok := requestActor(response, request)
		if !ok {
			return
		}
		id, ok := parseID(response, request, "sessionID")
		if !ok {
			return
		}
		var payload mutationPayload
		if err := decodeJSON(response, request, maximumJSONBody, &payload); err != nil {
			writeDomainError(response, err)
			return
		}
		result, err := service.RevokeSession(
			request.Context(), actor, id, payload.ExpectedRevision,
			mutationReason(payload, actor), request.Header.Get("Idempotency-Key"),
		)
		if err != nil {
			writeDomainError(response, err)
			return
		}
		writeJSON(response, http.StatusAccepted, result)
	}
}

func createApprovalHTTP(service HandlerService) http.HandlerFunc {
	return func(response http.ResponseWriter, request *http.Request) {
		actor, ok := requestActor(response, request)
		if !ok {
			return
		}
		var payload struct {
			Action       approval.Action `json:"action"`
			TargetUserID uuid.UUID       `json:"target_user_id"`
			reasonPayload
		}
		if err := decodeJSON(response, request, maximumJSONBody, &payload); err != nil {
			writeDomainError(response, err)
			return
		}
		result, err := service.CreateApproval(request.Context(), approval.CreateRequest{
			Actor: actor, Action: payload.Action, TargetUserID: payload.TargetUserID,
			Reason: admin.ActionReason{
				Code: payload.ReasonCode, TicketReference: payload.TicketReference, Note: payload.Note, Meta: actor.Meta,
			},
		})
		if err != nil {
			writeDomainError(response, err)
			return
		}
		writeJSON(response, http.StatusCreated, result)
	}
}

func listApprovalsHTTP(service HandlerService) http.HandlerFunc {
	return func(response http.ResponseWriter, request *http.Request) {
		actor, ok := requestActor(response, request)
		if !ok {
			return
		}
		page, err := pageFromRequest(request)
		if err != nil {
			writeDomainError(response, err)
			return
		}
		result, err := service.ListApprovals(request.Context(), actor, approval.ListFilter{
			View: request.URL.Query().Get("view"), Cursor: page.Cursor, Limit: page.Limit,
		})
		if err != nil {
			writeDomainError(response, err)
			return
		}
		writeJSON(response, http.StatusOK, result)
	}
}

func getApprovalHTTP(service HandlerService) http.HandlerFunc {
	return func(response http.ResponseWriter, request *http.Request) {
		actor, ok := requestActor(response, request)
		if !ok {
			return
		}
		id, ok := parseID(response, request, "approvalID")
		if !ok {
			return
		}
		result, err := service.GetApproval(request.Context(), actor, id)
		if err != nil {
			writeDomainError(response, err)
			return
		}
		writeJSON(response, http.StatusOK, result)
	}
}

func approveApprovalHTTP(service HandlerService) http.HandlerFunc {
	return func(response http.ResponseWriter, request *http.Request) {
		actor, ok := requestActor(response, request)
		if !ok {
			return
		}
		id, ok := parseID(response, request, "approvalID")
		if !ok {
			return
		}
		var payload struct{}
		if err := decodeJSON(response, request, maximumJSONBody, &payload); err != nil {
			writeDomainError(response, err)
			return
		}
		result, err := service.ApproveApproval(request.Context(), actor, id, request.Header.Get("Idempotency-Key"))
		if err != nil {
			writeDomainError(response, err)
			return
		}
		writeJSON(response, http.StatusAccepted, result)
	}
}

func rejectApprovalHTTP(service HandlerService) http.HandlerFunc {
	return func(response http.ResponseWriter, request *http.Request) {
		actor, ok := requestActor(response, request)
		if !ok {
			return
		}
		id, ok := parseID(response, request, "approvalID")
		if !ok {
			return
		}
		var payload struct{}
		if err := decodeJSON(response, request, maximumJSONBody, &payload); err != nil {
			writeDomainError(response, err)
			return
		}
		result, err := service.RejectApproval(request.Context(), actor, id)
		if err != nil {
			writeDomainError(response, err)
			return
		}
		writeJSON(response, http.StatusOK, result)
	}
}

func cancelApprovalHTTP(service HandlerService) http.HandlerFunc {
	return func(response http.ResponseWriter, request *http.Request) {
		actor, ok := requestActor(response, request)
		if !ok {
			return
		}
		id, ok := parseID(response, request, "approvalID")
		if !ok {
			return
		}
		var payload struct{}
		if err := decodeJSON(response, request, maximumJSONBody, &payload); err != nil {
			writeDomainError(response, err)
			return
		}
		result, err := service.CancelApproval(request.Context(), actor, id)
		if err != nil {
			writeDomainError(response, err)
			return
		}
		writeJSON(response, http.StatusOK, result)
	}
}

func getOperationHTTP(service HandlerService) http.HandlerFunc {
	return func(response http.ResponseWriter, request *http.Request) {
		actor, ok := requestActor(response, request)
		if !ok {
			return
		}
		id, ok := parseID(response, request, "operationID")
		if !ok {
			return
		}
		result, err := service.GetOperation(request.Context(), actor, id)
		if err != nil {
			writeDomainError(response, err)
			return
		}
		writeJSON(response, http.StatusOK, result)
	}
}

func healthHTTP(service HandlerService) http.HandlerFunc {
	return func(response http.ResponseWriter, request *http.Request) {
		actor, ok := requestActor(response, request)
		if !ok {
			return
		}
		result, err := service.Health(request.Context(), actor)
		if err != nil {
			writeDomainError(response, err)
			return
		}
		writeJSON(response, http.StatusOK, result)
	}
}

func stableHTTPResult(err error) string {
	if err == nil {
		return "OK"
	}
	for _, item := range errorResponses {
		if errors.Is(err, item.match) {
			return item.code
		}
	}
	return "INTERNAL_ERROR"
}

func writeDomainError(response http.ResponseWriter, err error) {
	for _, item := range errorResponses {
		if errors.Is(err, item.match) {
			writeError(response, item.status, item.code, item.message)
			return
		}
	}
	switch {
	case errors.Is(err, ErrPermissionDenied),
		errors.Is(err, operations.ErrPermissionDenied),
		errors.Is(err, approval.ErrPermissionDenied):
		writeError(response, http.StatusForbidden, "PERMISSION_DENIED", "没有执行此操作的权限")
	case errors.Is(err, cloudadmin.ErrNotFound),
		errors.Is(err, approval.ErrNotFound),
		errors.Is(err, operations.ErrOperationNotFound):
		writeError(response, http.StatusNotFound, "NOT_FOUND", "目标不存在")
	case errors.Is(err, cloudadmin.ErrConflict):
		writeError(response, http.StatusConflict, "STATE_CONFLICT", "目标状态已变化")
	default:
		writeError(response, http.StatusInternalServerError, "INTERNAL_ERROR", "系统暂时无法完成请求")
	}
}

func writeError(response http.ResponseWriter, status int, code, message string) {
	writeJSON(response, status, struct {
		Error struct {
			Code    string `json:"code"`
			Message string `json:"message"`
		} `json:"error"`
	}{Error: struct {
		Code    string `json:"code"`
		Message string `json:"message"`
	}{Code: code, Message: message}})
}

func noStore(next http.Handler) http.Handler {
	return http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		response.Header().Set("Cache-Control", "no-store")
		response.Header().Set("X-Content-Type-Options", "nosniff")
		next.ServeHTTP(response, request)
	})
}
