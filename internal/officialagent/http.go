package officialagent

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"mime"
	"net/http"
	"regexp"
	"strconv"
	"time"

	"github.com/bignormal/aera-admin/internal/admin"
	"github.com/bignormal/aera-admin/internal/auth"
	"github.com/bignormal/aera-admin/internal/cloudadmin"
	"github.com/bignormal/aera-admin/internal/operations"
	"github.com/bignormal/aera-admin/internal/rbac"
	"github.com/bignormal/aera-admin/internal/settings"
	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
)

const maximumOfficialJSONBody = 160 << 10

var officialCursorPattern = regexp.MustCompile(`^[A-Za-z0-9_-]{1,512}$`)

type HandlerService interface {
	ListDefinitions(context.Context, admin.Actor, cloudadmin.PageRequest) (cloudadmin.Page[cloudadmin.OfficialDefinition], error)
	GetDefinition(context.Context, admin.Actor, uuid.UUID) (cloudadmin.OfficialDefinitionDetail, error)
	ListDrafts(context.Context, admin.Actor, cloudadmin.PageRequest) (cloudadmin.Page[cloudadmin.OfficialDraft], error)
	GetDraft(context.Context, admin.Actor, uuid.UUID) (cloudadmin.OfficialDraft, error)
	ValidateDraft(context.Context, admin.Actor, uuid.UUID) (cloudadmin.OfficialDraftValidation, error)
	ListSubmissions(context.Context, admin.Actor, cloudadmin.OfficialSubmissionFilter) (cloudadmin.Page[cloudadmin.OfficialSubmission], error)
	GetSubmission(context.Context, admin.Actor, uuid.UUID) (cloudadmin.OfficialSubmission, error)
	ListVersions(context.Context, admin.Actor, cloudadmin.PageRequest) (cloudadmin.Page[cloudadmin.OfficialVersion], error)
	ListReleases(context.Context, admin.Actor, cloudadmin.PageRequest) (cloudadmin.Page[cloudadmin.OfficialRelease], error)
	GetRelease(context.Context, admin.Actor, uuid.UUID) (cloudadmin.OfficialReleaseDetail, error)
	ListRollbacks(context.Context, admin.Actor, ListFilter) (RollbackPage, error)
	ListAudit(context.Context, admin.Actor, cloudadmin.PageRequest) (cloudadmin.Page[cloudadmin.OfficialAuditEvent], error)
	Enqueue(context.Context, admin.Actor, MutationRequest) (operations.Result, error)
	RequestRollback(context.Context, admin.Actor, RollbackRequest) (RollbackApproval, error)
	ApproveRollback(context.Context, admin.Actor, uuid.UUID, string) (RollbackApproval, error)
	RejectRollback(context.Context, admin.Actor, uuid.UUID) (RollbackApproval, error)
	CancelRollback(context.Context, admin.Actor, uuid.UUID) (RollbackApproval, error)
}

type mutationEnvelope struct {
	ExpectedRevision     int64           `json:"expected_revision"`
	ExpectedTargetDigest string          `json:"expected_target_digest,omitempty"`
	ReasonCode           string          `json:"reason_code"`
	TicketReference      string          `json:"ticket_reference,omitempty"`
	Note                 string          `json:"note,omitempty"`
	Payload              json.RawMessage `json:"payload"`
}

type rollbackRequestPayload struct {
	TargetVersionID         string `json:"target_version_id"`
	TargetReleaseRevisionID string `json:"target_release_revision_id"`
	ExpectedHeadRevision    int64  `json:"expected_head_revision"`
	TargetDigest            string `json:"target_digest"`
	ReasonCode              string `json:"reason_code"`
	TicketReference         string `json:"ticket_reference,omitempty"`
	Note                    string `json:"note,omitempty"`
}

func NewHandler(service HandlerService) http.Handler {
	return NewHandlerWithClock(service, time.Now)
}

func NewHandlerWithClock(service HandlerService, clock func() time.Time) http.Handler {
	if service == nil {
		panic("official Agent HTTP service is required")
	}
	if clock == nil {
		clock = time.Now
	}
	read := officialPermission(rbac.ReadOfficialAgents)
	drafts := officialPermission(rbac.ManageOfficialDrafts)
	review := officialPermission(rbac.ReviewOfficialAgents)
	releases := officialPermission(rbac.ManageOfficialReleases)
	requestRollback := officialPermission(rbac.RequestOfficialRollback)
	approveRollback := officialPermission(rbac.ApproveOfficialRollback)
	recent := officialRecentTOTP(clock)

	router := chi.NewRouter()
	router.With(read).Get("/official-agents", listDefinitionsHTTP(service))
	router.With(drafts).Post("/official-agents", enqueueMutationHTTP(service, operations.OfficialDefinitionReserve, ""))
	router.With(read).Get("/official-agents/{definitionID}", getDefinitionHTTP(service))
	router.With(read).Get("/official-agent-drafts", listDraftsHTTP(service))
	router.With(drafts).Post("/official-agent-drafts", enqueueMutationHTTP(service, operations.OfficialDraftCreate, ""))
	router.With(read).Get("/official-agent-drafts/{draftID}", getDraftHTTP(service))
	router.With(drafts).Patch("/official-agent-drafts/{draftID}", enqueueMutationHTTP(service, operations.OfficialDraftUpdate, "draftID"))
	router.With(drafts).Post("/official-agent-drafts/{draftID}/validate", validateDraftHTTP(service))
	router.With(drafts).Post("/official-agent-drafts/{draftID}/submit", enqueueMutationHTTP(service, operations.OfficialDraftSubmit, "draftID"))
	router.With(read).Get("/official-agent-submissions", listSubmissionsHTTP(service))
	router.With(read).Get("/official-agent-submissions/{submissionID}", getSubmissionHTTP(service))
	router.With(drafts).Post("/official-agent-submissions/{submissionID}/withdraw", enqueueMutationHTTP(service, operations.OfficialSubmissionWithdraw, "submissionID"))
	router.With(review, recent).Post("/official-agent-submissions/{submissionID}/review", enqueueMutationHTTP(service, operations.OfficialSubmissionReview, "submissionID"))
	router.With(read).Get("/official-agent-versions", listVersionsHTTP(service))
	router.With(read).Get("/official-agent-releases", listReleasesHTTP(service))
	router.With(read).Get("/official-agent-releases/{releaseID}", getReleaseHTTP(service))
	router.With(releases, recent).Post("/official-agent-releases/{releaseID}/activate", enqueueMutationHTTP(service, operations.OfficialReleaseActivate, "releaseID"))
	router.With(releases, recent).Post("/official-agent-releases/{releaseID}/rollout", enqueueMutationHTTP(service, operations.OfficialReleaseRollout, "releaseID"))
	router.With(releases, recent).Post("/official-agent-releases/{releaseID}/pause", enqueueMutationHTTP(service, operations.OfficialReleasePause, "releaseID"))
	router.With(releases, recent).Post("/official-agent-releases/{releaseID}/resume", enqueueMutationHTTP(service, operations.OfficialReleaseResume, "releaseID"))
	router.With(requestRollback, recent).Post("/official-agent-releases/{releaseID}/rollback-requests", requestRollbackHTTP(service))
	router.With(officialAnyPermission(rbac.RequestOfficialRollback, rbac.ApproveOfficialRollback, rbac.ReadOfficialAgentAudit)).Get("/official-agent-rollback-requests", listRollbacksHTTP(service))
	router.With(approveRollback, recent).Post("/official-agent-rollback-requests/{approvalID}/approve", approveRollbackHTTP(service))
	router.With(approveRollback, recent).Post("/official-agent-rollback-requests/{approvalID}/reject", rejectRollbackHTTP(service))
	router.With(requestRollback, recent).Post("/official-agent-rollback-requests/{approvalID}/cancel", cancelRollbackHTTP(service))
	router.With(officialPermission(rbac.ReadOfficialAgentAudit)).Get("/official-agent-audit-events", listAuditHTTP(service))
	router.NotFound(func(response http.ResponseWriter, request *http.Request) {
		writeOfficialError(response, request, http.StatusNotFound, "NOT_FOUND", "请求的资源不存在")
	})
	router.MethodNotAllowed(func(response http.ResponseWriter, request *http.Request) {
		writeOfficialError(response, request, http.StatusMethodNotAllowed, "METHOD_NOT_ALLOWED", "请求方法不受支持")
	})
	return http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		response.Header().Set("Cache-Control", "no-store")
		response.Header().Set("X-Content-Type-Options", "nosniff")
		router.ServeHTTP(response, request)
	})
}

func officialPermission(permission rbac.Permission) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler { return auth.Require(permission, next) }
}

func officialAnyPermission(permissions ...rbac.Permission) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
			principal, ok := auth.PrincipalFromContext(request.Context())
			if !ok || principal.AdminID == "" || !principal.Role.Valid() {
				writeOfficialError(response, request, http.StatusUnauthorized, "AUTH_REQUIRED", "需要有效的管理员会话")
				return
			}
			for _, permission := range permissions {
				if rbac.Allowed(principal.Role, permission) {
					next.ServeHTTP(response, request)
					return
				}
			}
			writeOfficialError(response, request, http.StatusForbidden, "PERMISSION_DENIED", "没有执行此操作的权限")
		})
	}
}

func officialRecentTOTP(clock func() time.Time) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler { return auth.RequireRecentTOTP(clock, next) }
}

func officialActorFromRequest(response http.ResponseWriter, request *http.Request) (admin.Actor, bool) {
	principal, ok := auth.PrincipalFromContext(request.Context())
	if !ok || !principal.Role.Valid() {
		writeOfficialError(response, request, http.StatusUnauthorized, "AUTH_REQUIRED", "需要有效的管理员会话")
		return admin.Actor{}, false
	}
	id, err := uuid.Parse(principal.AdminID)
	if err != nil || id == uuid.Nil {
		writeOfficialError(response, request, http.StatusUnauthorized, "AUTH_REQUIRED", "需要有效的管理员会话")
		return admin.Actor{}, false
	}
	meta := admin.RequestMeta{RequestID: "req-" + uuid.NewString(), UserAgent: request.UserAgent()}
	if authenticated, present := auth.RequestMetaFromContext(request.Context()); present {
		meta = admin.RequestMeta{
			RequestID: authenticated.RequestID, SourceIPHMAC: append([]byte(nil), authenticated.SourceIPHMAC...),
			UserAgent: authenticated.UserAgent,
		}
	}
	return admin.Actor{AdminID: id, Role: principal.Role, Meta: meta}, true
}

func listDefinitionsHTTP(service HandlerService) http.HandlerFunc {
	return func(response http.ResponseWriter, request *http.Request) {
		actor, page, ok := officialActorAndPage(response, request, false)
		if !ok {
			return
		}
		result, err := service.ListDefinitions(request.Context(), actor, page)
		if err != nil {
			writeOfficialDomainError(response, request, err)
			return
		}
		if result.Items == nil {
			result.Items = make([]cloudadmin.OfficialDefinition, 0)
		}
		writeOfficialJSON(response, http.StatusOK, result)
	}
}

func getDefinitionHTTP(service HandlerService) http.HandlerFunc {
	return func(response http.ResponseWriter, request *http.Request) {
		actor, id, ok := officialActorAndID(response, request, "definitionID")
		if !ok {
			return
		}
		result, err := service.GetDefinition(request.Context(), actor, id)
		if err != nil {
			writeOfficialDomainError(response, request, err)
			return
		}
		writeOfficialJSON(response, http.StatusOK, result)
	}
}

func listDraftsHTTP(service HandlerService) http.HandlerFunc {
	return func(response http.ResponseWriter, request *http.Request) {
		actor, page, ok := officialActorAndPage(response, request, false)
		if !ok {
			return
		}
		result, err := service.ListDrafts(request.Context(), actor, page)
		if err != nil {
			writeOfficialDomainError(response, request, err)
			return
		}
		if result.Items == nil {
			result.Items = make([]cloudadmin.OfficialDraft, 0)
		}
		writeOfficialJSON(response, http.StatusOK, result)
	}
}

func getDraftHTTP(service HandlerService) http.HandlerFunc {
	return func(response http.ResponseWriter, request *http.Request) {
		actor, id, ok := officialActorAndID(response, request, "draftID")
		if !ok {
			return
		}
		result, err := service.GetDraft(request.Context(), actor, id)
		if err != nil {
			writeOfficialDomainError(response, request, err)
			return
		}
		writeOfficialJSON(response, http.StatusOK, result)
	}
}

func validateDraftHTTP(service HandlerService) http.HandlerFunc {
	return func(response http.ResponseWriter, request *http.Request) {
		actor, id, ok := officialActorAndID(response, request, "draftID")
		if !ok || request.ContentLength > 0 {
			if ok {
				writeOfficialError(response, request, http.StatusBadRequest, "INVALID_REQUEST", "请求内容无效")
			}
			return
		}
		result, err := service.ValidateDraft(request.Context(), actor, id)
		if err != nil {
			writeOfficialDomainError(response, request, err)
			return
		}
		if result.Findings == nil {
			result.Findings = make([]cloudadmin.OfficialValidationFinding, 0)
		}
		writeOfficialJSON(response, http.StatusOK, result)
	}
}

func listSubmissionsHTTP(service HandlerService) http.HandlerFunc {
	return func(response http.ResponseWriter, request *http.Request) {
		actor, ok := officialActorFromRequest(response, request)
		if !ok {
			return
		}
		filter, err := officialSubmissionFilter(request)
		if err != nil {
			writeOfficialDomainError(response, request, err)
			return
		}
		result, err := service.ListSubmissions(request.Context(), actor, filter)
		if err != nil {
			writeOfficialDomainError(response, request, err)
			return
		}
		if result.Items == nil {
			result.Items = make([]cloudadmin.OfficialSubmission, 0)
		}
		writeOfficialJSON(response, http.StatusOK, result)
	}
}

func getSubmissionHTTP(service HandlerService) http.HandlerFunc {
	return func(response http.ResponseWriter, request *http.Request) {
		actor, id, ok := officialActorAndID(response, request, "submissionID")
		if !ok {
			return
		}
		result, err := service.GetSubmission(request.Context(), actor, id)
		if err != nil {
			writeOfficialDomainError(response, request, err)
			return
		}
		writeOfficialJSON(response, http.StatusOK, result)
	}
}

func listVersionsHTTP(service HandlerService) http.HandlerFunc {
	return func(response http.ResponseWriter, request *http.Request) {
		actor, page, ok := officialActorAndPage(response, request, false)
		if !ok {
			return
		}
		result, err := service.ListVersions(request.Context(), actor, page)
		if err != nil {
			writeOfficialDomainError(response, request, err)
			return
		}
		if result.Items == nil {
			result.Items = make([]cloudadmin.OfficialVersion, 0)
		}
		writeOfficialJSON(response, http.StatusOK, result)
	}
}

func listReleasesHTTP(service HandlerService) http.HandlerFunc {
	return func(response http.ResponseWriter, request *http.Request) {
		actor, page, ok := officialActorAndPage(response, request, false)
		if !ok {
			return
		}
		result, err := service.ListReleases(request.Context(), actor, page)
		if err != nil {
			writeOfficialDomainError(response, request, err)
			return
		}
		if result.Items == nil {
			result.Items = make([]cloudadmin.OfficialRelease, 0)
		}
		writeOfficialJSON(response, http.StatusOK, result)
	}
}

func getReleaseHTTP(service HandlerService) http.HandlerFunc {
	return func(response http.ResponseWriter, request *http.Request) {
		actor, id, ok := officialActorAndID(response, request, "releaseID")
		if !ok {
			return
		}
		result, err := service.GetRelease(request.Context(), actor, id)
		if err != nil {
			writeOfficialDomainError(response, request, err)
			return
		}
		writeOfficialJSON(response, http.StatusOK, result)
	}
}

func listAuditHTTP(service HandlerService) http.HandlerFunc {
	return func(response http.ResponseWriter, request *http.Request) {
		actor, page, ok := officialActorAndPage(response, request, true)
		if !ok {
			return
		}
		result, err := service.ListAudit(request.Context(), actor, page)
		if err != nil {
			writeOfficialDomainError(response, request, err)
			return
		}
		if result.Items == nil {
			result.Items = make([]cloudadmin.OfficialAuditEvent, 0)
		}
		writeOfficialJSON(response, http.StatusOK, result)
	}
}

func enqueueMutationHTTP(service HandlerService, action operations.Action, pathID string) http.HandlerFunc {
	return func(response http.ResponseWriter, request *http.Request) {
		actor, ok := officialActorFromRequest(response, request)
		if !ok {
			return
		}
		if !hasNoOfficialQuery(request) {
			writeOfficialDomainError(response, request, ErrInvalidRequest)
			return
		}
		idempotencyKey, ok := officialIdempotencyKey(response, request)
		if !ok {
			return
		}
		var input mutationEnvelope
		if decodeOfficialJSON(response, request, &input) != nil || input.ExpectedRevision <= 0 || len(input.Payload) < 2 {
			writeOfficialDomainError(response, request, ErrInvalidRequest)
			return
		}
		targetID := deterministicCreateTarget(actor, action, idempotencyKey)
		if pathID != "" {
			var parsed bool
			targetID, parsed = officialPathID(response, request, pathID)
			if !parsed {
				return
			}
		}
		result, err := service.Enqueue(request.Context(), actor, MutationRequest{
			Action: action, TargetID: targetID, ExpectedRevision: input.ExpectedRevision,
			ExpectedTargetDigest: input.ExpectedTargetDigest, Payload: append(json.RawMessage(nil), input.Payload...),
			Reason: admin.ActionReason{
				Code: input.ReasonCode, TicketReference: input.TicketReference, Note: input.Note, Meta: actor.Meta,
			},
			BrowserIdempotencyKey: idempotencyKey,
		})
		input.Payload = nil
		if err != nil {
			writeOfficialDomainError(response, request, err)
			return
		}
		writeOfficialJSON(response, http.StatusAccepted, result)
	}
}

func deterministicCreateTarget(actor admin.Actor, action operations.Action, idempotencyKey string) uuid.UUID {
	return uuid.NewSHA1(uuid.NameSpaceOID, []byte(actor.AdminID.String()+"\x00"+string(action)+"\x00"+idempotencyKey))
}

func requestRollbackHTTP(service HandlerService) http.HandlerFunc {
	return func(response http.ResponseWriter, request *http.Request) {
		actor, releaseID, ok := officialActorAndID(response, request, "releaseID")
		if !ok {
			return
		}
		if _, ok := officialIdempotencyKey(response, request); !ok {
			return
		}
		var input rollbackRequestPayload
		if decodeOfficialJSON(response, request, &input) != nil {
			writeOfficialDomainError(response, request, ErrInvalidRequest)
			return
		}
		targetVersionID, versionOK := canonicalOfficialUUID(input.TargetVersionID)
		targetRevisionID, revisionOK := canonicalOfficialUUID(input.TargetReleaseRevisionID)
		if !versionOK || !revisionOK {
			writeOfficialDomainError(response, request, ErrInvalidRequest)
			return
		}
		result, err := service.RequestRollback(request.Context(), actor, RollbackRequest{
			ReleaseID: releaseID, TargetVersionID: targetVersionID, TargetReleaseRevisionID: targetRevisionID,
			ExpectedHeadRevision: input.ExpectedHeadRevision, TargetDigest: input.TargetDigest,
			Reason: admin.ActionReason{
				Code: input.ReasonCode, TicketReference: input.TicketReference, Note: input.Note, Meta: actor.Meta,
			},
		})
		if err != nil {
			writeOfficialDomainError(response, request, err)
			return
		}
		writeOfficialJSON(response, http.StatusCreated, result)
	}
}

func listRollbacksHTTP(service HandlerService) http.HandlerFunc {
	return func(response http.ResponseWriter, request *http.Request) {
		actor, ok := officialActorFromRequest(response, request)
		if !ok {
			return
		}
		filter, err := officialRollbackFilter(request)
		if err != nil {
			writeOfficialDomainError(response, request, err)
			return
		}
		result, err := service.ListRollbacks(request.Context(), actor, filter)
		if err != nil {
			writeOfficialDomainError(response, request, err)
			return
		}
		if result.Items == nil {
			result.Items = make([]RollbackApproval, 0)
		}
		writeOfficialJSON(response, http.StatusOK, result)
	}
}

func approveRollbackHTTP(service HandlerService) http.HandlerFunc {
	return rollbackDecisionHTTP(http.StatusAccepted, func(ctx context.Context, actor admin.Actor, service HandlerService, id uuid.UUID, key string) (RollbackApproval, error) {
		return service.ApproveRollback(ctx, actor, id, key)
	})(service)
}

func rejectRollbackHTTP(service HandlerService) http.HandlerFunc {
	return rollbackDecisionHTTP(http.StatusOK, func(ctx context.Context, actor admin.Actor, service HandlerService, id uuid.UUID, _ string) (RollbackApproval, error) {
		return service.RejectRollback(ctx, actor, id)
	})(service)
}

func cancelRollbackHTTP(service HandlerService) http.HandlerFunc {
	return rollbackDecisionHTTP(http.StatusOK, func(ctx context.Context, actor admin.Actor, service HandlerService, id uuid.UUID, _ string) (RollbackApproval, error) {
		return service.CancelRollback(ctx, actor, id)
	})(service)
}

type rollbackDecision func(context.Context, admin.Actor, HandlerService, uuid.UUID, string) (RollbackApproval, error)

func rollbackDecisionHTTP(status int, decide rollbackDecision) func(HandlerService) http.HandlerFunc {
	return func(service HandlerService) http.HandlerFunc {
		return func(response http.ResponseWriter, request *http.Request) {
			actor, id, ok := officialActorAndID(response, request, "approvalID")
			if !ok {
				return
			}
			key, ok := officialIdempotencyKey(response, request)
			if !ok {
				return
			}
			var empty struct{}
			if decodeOfficialJSON(response, request, &empty) != nil {
				writeOfficialDomainError(response, request, ErrInvalidRequest)
				return
			}
			result, err := decide(request.Context(), actor, service, id, key)
			if err != nil {
				writeOfficialDomainError(response, request, err)
				return
			}
			writeOfficialJSON(response, status, result)
		}
	}
}

func officialActorAndID(response http.ResponseWriter, request *http.Request, name string) (admin.Actor, uuid.UUID, bool) {
	actor, ok := officialActorFromRequest(response, request)
	if !ok {
		return admin.Actor{}, uuid.Nil, false
	}
	if !hasNoOfficialQuery(request) {
		writeOfficialDomainError(response, request, ErrInvalidRequest)
		return admin.Actor{}, uuid.Nil, false
	}
	id, ok := officialPathID(response, request, name)
	return actor, id, ok
}

func officialPathID(response http.ResponseWriter, request *http.Request, name string) (uuid.UUID, bool) {
	id, ok := canonicalOfficialUUID(chi.URLParam(request, name))
	if !ok {
		writeOfficialDomainError(response, request, ErrInvalidRequest)
	}
	return id, ok
}

func canonicalOfficialUUID(raw string) (uuid.UUID, bool) {
	id, err := uuid.Parse(raw)
	return id, err == nil && id != uuid.Nil && id.String() == raw
}

func officialActorAndPage(response http.ResponseWriter, request *http.Request, opaqueCursor bool) (admin.Actor, cloudadmin.PageRequest, bool) {
	actor, ok := officialActorFromRequest(response, request)
	if !ok {
		return admin.Actor{}, cloudadmin.PageRequest{}, false
	}
	page, err := officialPage(request, opaqueCursor, nil)
	if err != nil {
		writeOfficialDomainError(response, request, err)
		return admin.Actor{}, cloudadmin.PageRequest{}, false
	}
	return actor, page, true
}

func officialPage(request *http.Request, opaqueCursor bool, extra map[string]struct{}) (cloudadmin.PageRequest, error) {
	allowed := map[string]struct{}{"cursor": {}, "limit": {}}
	for key := range extra {
		allowed[key] = struct{}{}
	}
	for key, values := range request.URL.Query() {
		if _, ok := allowed[key]; !ok || len(values) != 1 {
			return cloudadmin.PageRequest{}, ErrInvalidRequest
		}
	}
	limit := 50
	if raw := request.URL.Query().Get("limit"); raw != "" {
		parsed, err := strconv.Atoi(raw)
		if err != nil {
			return cloudadmin.PageRequest{}, ErrInvalidRequest
		}
		limit = parsed
	}
	cursor := request.URL.Query().Get("cursor")
	if limit < 1 || limit > 100 || len(cursor) > 512 {
		return cloudadmin.PageRequest{}, ErrInvalidRequest
	}
	if cursor != "" {
		if opaqueCursor {
			if !officialCursorPattern.MatchString(cursor) {
				return cloudadmin.PageRequest{}, ErrInvalidRequest
			}
		} else if _, ok := canonicalOfficialUUID(cursor); !ok {
			return cloudadmin.PageRequest{}, ErrInvalidRequest
		}
	}
	return cloudadmin.PageRequest{Cursor: cursor, Limit: limit}, nil
}

func officialSubmissionFilter(request *http.Request) (cloudadmin.OfficialSubmissionFilter, error) {
	page, err := officialPage(request, false, map[string]struct{}{"status": {}})
	if err != nil {
		return cloudadmin.OfficialSubmissionFilter{}, err
	}
	status := request.URL.Query().Get("status")
	if status != "" && status != "pending" && status != "approved" && status != "rejected" && status != "withdrawn" && status != "superseded" {
		return cloudadmin.OfficialSubmissionFilter{}, ErrInvalidRequest
	}
	return cloudadmin.OfficialSubmissionFilter{PageRequest: page, Status: status}, nil
}

func officialRollbackFilter(request *http.Request) (ListFilter, error) {
	page, err := officialPage(request, true, map[string]struct{}{"view": {}})
	if err != nil {
		return ListFilter{}, err
	}
	view := request.URL.Query().Get("view")
	if view == "" {
		principal, _ := auth.PrincipalFromContext(request.Context())
		switch principal.Role {
		case rbac.Operator:
			view = "mine"
		case rbac.SuperAdmin:
			view = "pending_for_me"
		default:
			view = "all"
		}
	}
	if view != "mine" && view != "pending_for_me" && view != "all" {
		return ListFilter{}, ErrInvalidRequest
	}
	return ListFilter{View: view, Cursor: page.Cursor, Limit: page.Limit}, nil
}

func officialIdempotencyKey(response http.ResponseWriter, request *http.Request) (string, bool) {
	key := request.Header.Get("Idempotency-Key")
	if !idempotencyKeyPattern.MatchString(key) {
		writeOfficialDomainError(response, request, ErrInvalidRequest)
		return "", false
	}
	return key, true
}

func hasNoOfficialQuery(request *http.Request) bool {
	return len(request.URL.Query()) == 0
}

func decodeOfficialJSON(response http.ResponseWriter, request *http.Request, target any) error {
	mediaType, _, err := mime.ParseMediaType(request.Header.Get("Content-Type"))
	if err != nil || mediaType != "application/json" {
		return ErrInvalidRequest
	}
	request.Body = http.MaxBytesReader(response, request.Body, maximumOfficialJSONBody)
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

func writeOfficialDomainError(response http.ResponseWriter, request *http.Request, err error) {
	switch {
	case errors.Is(err, ErrInvalidRequest), errors.Is(err, operations.ErrInvalidRequest):
		writeOfficialError(response, request, http.StatusBadRequest, "INVALID_REQUEST", "请求内容无效")
	case errors.Is(err, ErrPermissionDenied), errors.Is(err, operations.ErrPermissionDenied), errors.Is(err, cloudadmin.ErrPermissionDenied):
		writeOfficialError(response, request, http.StatusForbidden, "PERMISSION_DENIED", "没有执行此操作的权限")
	case errors.Is(err, ErrSelfReview):
		writeOfficialError(response, request, http.StatusForbidden, "SELF_REVIEW_FORBIDDEN", "发起人不能审批自己的申请")
	case errors.Is(err, ErrNotFound), errors.Is(err, operations.ErrOperationNotFound), errors.Is(err, cloudadmin.ErrNotFound):
		writeOfficialError(response, request, http.StatusNotFound, "NOT_FOUND", "请求的资源不存在")
	case errors.Is(err, ErrExpired):
		writeOfficialError(response, request, http.StatusConflict, "APPROVAL_EXPIRED", "审批申请已过期")
	case errors.Is(err, ErrStateConflict), errors.Is(err, ErrTargetState), errors.Is(err, operations.ErrStateConflict), errors.Is(err, cloudadmin.ErrConflict):
		writeOfficialError(response, request, http.StatusConflict, "STATE_CONFLICT", "目标状态已变化，请刷新后重试")
	case errors.Is(err, ErrTargetDigestMismatch):
		writeOfficialError(response, request, http.StatusConflict, "TARGET_DIGEST_MISMATCH", "目标内容已变化，请刷新后重试")
	case errors.Is(err, operations.ErrIdempotencyKeyReused):
		writeOfficialError(response, request, http.StatusConflict, "IDEMPOTENCY_KEY_REUSED", "幂等键已用于其他操作")
	case errors.Is(err, settings.ErrReasonNotFound):
		writeOfficialError(response, request, http.StatusConflict, "REASON_CODE_NOT_FOUND", "标准原因不存在，请刷新后重试")
	case errors.Is(err, settings.ErrReasonInactive):
		writeOfficialError(response, request, http.StatusConflict, "REASON_CODE_INACTIVE", "标准原因已停用，请刷新后重试")
	case errors.Is(err, settings.ErrReasonIncompatible):
		writeOfficialError(response, request, http.StatusConflict, "REASON_CODE_CATEGORY_MISMATCH", "标准原因不适用于此操作")
	case errors.Is(err, cloudadmin.ErrPublicationDLPBlocked):
		writeOfficialError(response, request, http.StatusUnprocessableEntity, "PUBLICATION_DLP_BLOCKED", "发布内容未通过敏感信息检查")
	case errors.Is(err, cloudadmin.ErrNotConfigured):
		writeOfficialError(response, request, http.StatusServiceUnavailable, "CLOUD_NOT_CONFIGURED", "Cloud 管理服务尚未配置")
	case errors.Is(err, cloudadmin.ErrUnavailable), errors.Is(err, operations.ErrCloudUnavailable), errors.Is(err, settings.ErrUnavailable):
		writeOfficialError(response, request, http.StatusServiceUnavailable, "CLOUD_UNAVAILABLE", "Cloud 管理服务暂时不可用")
	case errors.Is(err, cloudadmin.ErrContractViolation):
		writeOfficialError(response, request, http.StatusBadGateway, "CLOUD_CONTRACT_VIOLATION", "Cloud 管理服务响应不符合安全契约")
	default:
		writeOfficialError(response, request, http.StatusInternalServerError, "INTERNAL_ERROR", "服务暂时不可用")
	}
}

func writeOfficialError(response http.ResponseWriter, request *http.Request, status int, code, message string) {
	requestID := ""
	if meta, ok := auth.RequestMetaFromContext(request.Context()); ok {
		requestID = meta.RequestID
	}
	writeOfficialJSON(response, status, struct {
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

func writeOfficialJSON(response http.ResponseWriter, status int, value any) {
	var encoded bytes.Buffer
	if err := json.NewEncoder(&encoded).Encode(value); err != nil {
		response.Header().Set("Content-Type", "application/json")
		response.WriteHeader(http.StatusInternalServerError)
		_, _ = response.Write([]byte(`{"error":{"code":"INTERNAL_ERROR","message":"服务暂时不可用"}}`))
		return
	}
	response.Header().Set("Cache-Control", "no-store")
	response.Header().Set("Content-Type", "application/json")
	response.Header().Set("X-Content-Type-Options", "nosniff")
	response.WriteHeader(status)
	_, _ = response.Write(encoded.Bytes())
}
