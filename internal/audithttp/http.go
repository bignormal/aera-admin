package audithttp

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strconv"
	"time"

	"github.com/bignormal/aera-admin/internal/audit"
	"github.com/bignormal/aera-admin/internal/auth"
	"github.com/bignormal/aera-admin/internal/rbac"
	"github.com/google/uuid"
)

type Service interface {
	List(context.Context, audit.Query) (audit.Page, error)
	Append(context.Context, audit.Record) (uuid.UUID, error)
}

func NewHandler(service Service) http.Handler {
	if service == nil {
		panic("audit HTTP service is required")
	}
	return http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		response.Header().Set("Cache-Control", "no-store")
		response.Header().Set("Content-Type", "application/json")
		response.Header().Set("X-Content-Type-Options", "nosniff")
		if request.Method != http.MethodGet {
			writeError(response, request, http.StatusMethodNotAllowed, "METHOD_NOT_ALLOWED", "请求方法不受支持")
			return
		}

		principal, ok := auth.PrincipalFromContext(request.Context())
		if !ok || principal.AdminID == "" || !principal.Role.Valid() {
			writeError(response, request, http.StatusUnauthorized, "AUTH_REQUIRED", "需要有效的管理员会话")
			return
		}
		adminID, err := uuid.Parse(principal.AdminID)
		if err != nil || adminID == uuid.Nil {
			writeError(response, request, http.StatusUnauthorized, "AUTH_REQUIRED", "需要有效的管理员会话")
			return
		}
		full := rbac.Allowed(principal.Role, rbac.ReadFullAudit)
		own := rbac.Allowed(principal.Role, rbac.ReadOwnAudit)
		if !full && !own {
			writeError(response, request, http.StatusForbidden, "PERMISSION_DENIED", "没有查看审计记录的权限")
			return
		}

		query, err := parseQuery(request, full, adminID)
		if err != nil {
			code := "INVALID_REQUEST"
			message := "审计查询条件无效"
			if request.URL.Query().Get("cursor") != "" {
				if _, _, cursorErr := audit.DecodeCursor(request.URL.Query().Get("cursor")); cursorErr != nil {
					code = "AUDIT_CURSOR_INVALID"
					message = "审计分页游标无效"
				}
			}
			writeError(response, request, http.StatusBadRequest, code, message)
			return
		}
		meta, ok := auth.RequestMetaFromContext(request.Context())
		if !ok || meta.RequestID == "" {
			writeError(response, request, http.StatusServiceUnavailable, "AUDIT_UNAVAILABLE", "审计服务暂时不可用")
			return
		}
		page, err := service.List(request.Context(), query)
		if err != nil {
			status := http.StatusServiceUnavailable
			code := "AUDIT_UNAVAILABLE"
			message := "审计服务暂时不可用"
			if errors.Is(err, audit.ErrInvalidQuery) {
				status = http.StatusBadRequest
				code = "INVALID_REQUEST"
				message = "审计查询条件无效"
			}
			writeError(response, request, status, code, message)
			return
		}
		state := queryAuditState(query, len(page.Items))
		if _, err := service.Append(request.Context(), audit.Record{
			ActorAdminID: &adminID, ActorRole: principal.Role,
			EventType: "audit_events_viewed", ObjectType: "admin_audit",
			Outcome: audit.OutcomeSuccess, AfterState: state,
			RequestID: meta.RequestID, SourceIPHMAC: meta.SourceIPHMAC, UserAgent: meta.UserAgent,
		}); err != nil {
			writeError(response, request, http.StatusServiceUnavailable, "AUDIT_UNAVAILABLE", "审计服务暂时不可用")
			return
		}
		response.WriteHeader(http.StatusOK)
		_ = json.NewEncoder(response).Encode(page)
	})
}

func parseQuery(request *http.Request, full bool, ownID uuid.UUID) (audit.Query, error) {
	values := request.URL.Query()
	allowed := map[string]struct{}{
		"cursor": {}, "limit": {}, "actor_admin_id": {}, "event_type": {}, "object_type": {},
		"object_id": {}, "outcome": {}, "reason_code": {}, "from": {}, "to": {},
	}
	for key, entries := range values {
		if _, ok := allowed[key]; !ok || len(entries) != 1 {
			return audit.Query{}, audit.ErrInvalidQuery
		}
	}
	query := audit.Query{
		Cursor: values.Get("cursor"), Limit: 20,
		EventType: values.Get("event_type"), ObjectType: values.Get("object_type"),
		Outcome: audit.Outcome(values.Get("outcome")), ReasonCode: values.Get("reason_code"),
	}
	if raw := values.Get("limit"); raw != "" {
		limit, err := strconv.Atoi(raw)
		if err != nil {
			return audit.Query{}, audit.ErrInvalidQuery
		}
		query.Limit = limit
	}
	if full {
		if raw := values.Get("actor_admin_id"); raw != "" {
			id, err := uuid.Parse(raw)
			if err != nil || id == uuid.Nil {
				return audit.Query{}, audit.ErrInvalidQuery
			}
			query.ActorAdminID = &id
		}
	} else {
		query.ActorAdminID = &ownID
	}
	if raw := values.Get("object_id"); raw != "" {
		id, err := uuid.Parse(raw)
		if err != nil || id == uuid.Nil {
			return audit.Query{}, audit.ErrInvalidQuery
		}
		query.ObjectID = &id
	}
	if raw := values.Get("from"); raw != "" {
		parsed, err := time.Parse(time.RFC3339, raw)
		if err != nil {
			return audit.Query{}, audit.ErrInvalidQuery
		}
		query.From = parsed.UTC()
	}
	if raw := values.Get("to"); raw != "" {
		parsed, err := time.Parse(time.RFC3339, raw)
		if err != nil {
			return audit.Query{}, audit.ErrInvalidQuery
		}
		query.To = parsed.UTC()
	}
	if err := query.Validate(); err != nil {
		return audit.Query{}, err
	}
	return query, nil
}

func queryAuditState(query audit.Query, resultCount int) map[string]string {
	state := map[string]string{"result_count": strconv.Itoa(resultCount)}
	if query.ActorAdminID != nil {
		state["filter_actor"] = "true"
	}
	if query.EventType != "" {
		state["filter_event"] = "true"
	}
	if query.ObjectType != "" || query.ObjectID != nil {
		state["filter_object"] = "true"
	}
	if query.Outcome != "" {
		state["filter_outcome"] = "true"
	}
	if query.ReasonCode != "" {
		state["filter_reason"] = "true"
	}
	if !query.From.IsZero() || !query.To.IsZero() {
		state["filter_time"] = "true"
	}
	return state
}

func writeError(response http.ResponseWriter, request *http.Request, status int, code, message string) {
	requestID := ""
	if meta, ok := auth.RequestMetaFromContext(request.Context()); ok {
		requestID = meta.RequestID
	}
	response.WriteHeader(status)
	_ = json.NewEncoder(response).Encode(struct {
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
