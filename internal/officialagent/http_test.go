package officialagent

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/bignormal/aera-admin/internal/admin"
	"github.com/bignormal/aera-admin/internal/auth"
	"github.com/bignormal/aera-admin/internal/cloudadmin"
	"github.com/bignormal/aera-admin/internal/operations"
	"github.com/bignormal/aera-admin/internal/rbac"
	"github.com/google/uuid"
)

const (
	httpDefinitionID = "019f0000-0000-7000-8000-000000000111"
	httpDraftID      = "019f0000-0000-7000-8000-000000000112"
	httpSubmissionID = "019f0000-0000-7000-8000-000000000113"
	httpReleaseID    = "019f0000-0000-7000-8000-000000000114"
	httpVersionID    = "019f0000-0000-7000-8000-000000000115"
	httpRevisionID   = "019f0000-0000-7000-8000-000000000116"
	httpApprovalID   = "019f0000-0000-7000-8000-000000000117"
	httpDigest       = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
)

func TestOfficialAgentRoutesHaveFixedSixRoleMatrix(t *testing.T) {
	allRoles := []rbac.Role{rbac.SuperAdmin, rbac.Developer, rbac.Operator, rbac.Support, rbac.Finance, rbac.Auditor}
	allowed := func(roles ...rbac.Role) map[rbac.Role]bool {
		result := make(map[rbac.Role]bool, len(roles))
		for _, role := range roles {
			result[role] = true
		}
		return result
	}
	readers := allowed(rbac.SuperAdmin, rbac.Developer, rbac.Operator, rbac.Auditor)
	mutate := mutationJSON(`{}`)
	cases := []struct {
		method  string
		path    string
		body    string
		success int
		allowed map[rbac.Role]bool
	}{
		{http.MethodGet, "/official-agents?limit=50", "", 200, readers},
		{http.MethodPost, "/official-agents", mutate, 202, allowed(rbac.Developer)},
		{http.MethodGet, "/official-agents/" + httpDefinitionID, "", 200, readers},
		{http.MethodGet, "/official-agent-drafts?limit=50", "", 200, readers},
		{http.MethodPost, "/official-agent-drafts", mutate, 202, allowed(rbac.Developer)},
		{http.MethodGet, "/official-agent-drafts/" + httpDraftID, "", 200, readers},
		{http.MethodPatch, "/official-agent-drafts/" + httpDraftID, mutate, 202, allowed(rbac.Developer)},
		{http.MethodPost, "/official-agent-drafts/" + httpDraftID + "/validate", "", 200, allowed(rbac.Developer)},
		{http.MethodPost, "/official-agent-drafts/" + httpDraftID + "/submit", mutate, 202, allowed(rbac.Developer)},
		{http.MethodGet, "/official-agent-submissions?status=pending&limit=50", "", 200, readers},
		{http.MethodGet, "/official-agent-submissions/" + httpSubmissionID, "", 200, readers},
		{http.MethodPost, "/official-agent-submissions/" + httpSubmissionID + "/withdraw", mutate, 202, allowed(rbac.Developer)},
		{http.MethodPost, "/official-agent-submissions/" + httpSubmissionID + "/review", mutate, 202, allowed(rbac.SuperAdmin)},
		{http.MethodGet, "/official-agent-versions?limit=50", "", 200, readers},
		{http.MethodGet, "/official-agent-releases?limit=50", "", 200, readers},
		{http.MethodGet, "/official-agent-releases/" + httpReleaseID, "", 200, readers},
		{http.MethodPost, "/official-agent-releases/" + httpReleaseID + "/activate", mutate, 202, allowed(rbac.Operator)},
		{http.MethodPost, "/official-agent-releases/" + httpReleaseID + "/rollout", mutate, 202, allowed(rbac.Operator)},
		{http.MethodPost, "/official-agent-releases/" + httpReleaseID + "/pause", mutate, 202, allowed(rbac.Operator)},
		{http.MethodPost, "/official-agent-releases/" + httpReleaseID + "/resume", mutate, 202, allowed(rbac.Operator)},
		{http.MethodPost, "/official-agent-releases/" + httpReleaseID + "/rollback-requests", rollbackJSON(), 201, allowed(rbac.Operator)},
		{http.MethodGet, "/official-agent-rollback-requests?view=all&limit=50", "", 200, allowed(rbac.SuperAdmin, rbac.Operator, rbac.Auditor)},
		{http.MethodPost, "/official-agent-rollback-requests/" + httpApprovalID + "/approve", `{}`, 202, allowed(rbac.SuperAdmin)},
		{http.MethodPost, "/official-agent-rollback-requests/" + httpApprovalID + "/reject", `{}`, 200, allowed(rbac.SuperAdmin)},
		{http.MethodPost, "/official-agent-rollback-requests/" + httpApprovalID + "/cancel", `{}`, 200, allowed(rbac.Operator)},
		{http.MethodGet, "/official-agent-audit-events?limit=50", "", 200, allowed(rbac.SuperAdmin, rbac.Auditor)},
	}
	handler := NewHandler(&officialHTTPStub{})
	for _, route := range cases {
		for _, role := range allRoles {
			t.Run(string(role)+" "+route.method+" "+route.path, func(t *testing.T) {
				request := httptest.NewRequest(route.method, route.path, strings.NewReader(route.body))
				if route.method != http.MethodGet && route.body != "" {
					request.Header.Set("Content-Type", "application/json")
					request.Header.Set("Idempotency-Key", uuid.NewString())
				}
				request = auth.WithPrincipal(request, officialHTTPPrincipal(role, true))
				response := httptest.NewRecorder()
				handler.ServeHTTP(response, request)
				want := http.StatusForbidden
				if route.allowed[role] {
					want = route.success
				}
				if response.Code != want {
					t.Fatalf("status/body = %d %q, want %d", response.Code, response.Body.String(), want)
				}
			})
		}
	}
}

func TestOfficialSensitiveMutationsRequireRecentTOTPAndIdempotency(t *testing.T) {
	handler := NewHandler(&officialHTTPStub{})
	for _, test := range []struct {
		name string
		role rbac.Role
		path string
	}{
		{"review", rbac.SuperAdmin, "/official-agent-submissions/" + httpSubmissionID + "/review"},
		{"release", rbac.Operator, "/official-agent-releases/" + httpReleaseID + "/pause"},
		{"rollback request", rbac.Operator, "/official-agent-releases/" + httpReleaseID + "/rollback-requests"},
		{"rollback approve", rbac.SuperAdmin, "/official-agent-rollback-requests/" + httpApprovalID + "/approve"},
	} {
		t.Run(test.name+" stale", func(t *testing.T) {
			body := mutationJSON(`{}`)
			if strings.HasSuffix(test.path, "/rollback-requests") {
				body = rollbackJSON()
			}
			request := httptest.NewRequest(http.MethodPost, test.path, strings.NewReader(body))
			request.Header.Set("Content-Type", "application/json")
			request.Header.Set("Idempotency-Key", uuid.NewString())
			request = auth.WithPrincipal(request, officialHTTPPrincipal(test.role, false))
			response := httptest.NewRecorder()
			handler.ServeHTTP(response, request)
			if response.Code != http.StatusForbidden || !strings.Contains(response.Body.String(), `"code":"STEP_UP_REQUIRED"`) {
				t.Fatalf("status/body = %d %q", response.Code, response.Body.String())
			}
		})
	}

	request := httptest.NewRequest(http.MethodPost, "/official-agents", strings.NewReader(mutationJSON(`{}`)))
	request.Header.Set("Content-Type", "application/json")
	request = auth.WithPrincipal(request, officialHTTPPrincipal(rbac.Developer, true))
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusBadRequest || !strings.Contains(response.Body.String(), `"code":"INVALID_REQUEST"`) {
		t.Fatalf("missing idempotency status/body = %d %q", response.Code, response.Body.String())
	}
}

func TestOfficialHTTPRejectsUnknownJSONAndQueryFields(t *testing.T) {
	handler := NewHandler(&officialHTTPStub{})
	request := httptest.NewRequest(http.MethodPost, "/official-agents", strings.NewReader(
		`{"expected_revision":1,"reason_code":"definition_create","payload":{},"cloud_token":"secret"}`,
	))
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Idempotency-Key", uuid.NewString())
	request = auth.WithPrincipal(request, officialHTTPPrincipal(rbac.Developer, true))
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusBadRequest || strings.Contains(response.Body.String(), "cloud_token") || strings.Contains(response.Body.String(), "secret") {
		t.Fatalf("unknown JSON status/body = %d %q", response.Code, response.Body.String())
	}

	request = httptest.NewRequest(http.MethodGet, "/official-agents?cloud_origin=https://secret.example", nil)
	request = auth.WithPrincipal(request, officialHTTPPrincipal(rbac.Auditor, true))
	response = httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusBadRequest || strings.Contains(response.Body.String(), "secret.example") {
		t.Fatalf("unknown query status/body = %d %q", response.Code, response.Body.String())
	}
}

func TestOfficialHTTPFailsClosedWithoutLeakingCloudError(t *testing.T) {
	canary := "mtls-private-key-and-cloud-token-canary"
	handler := NewHandler(&officialHTTPStub{err: errors.New(canary)})
	request := httptest.NewRequest(http.MethodGet, "/official-agents?limit=50", nil)
	request = auth.WithPrincipal(request, officialHTTPPrincipal(rbac.Auditor, true))
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusInternalServerError || strings.Contains(response.Body.String(), canary) {
		t.Fatalf("status/body = %d %q", response.Code, response.Body.String())
	}

	handler = NewHandler(&officialHTTPStub{err: cloudadmin.ErrUnavailable})
	response = httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusServiceUnavailable || !strings.Contains(response.Body.String(), `"code":"CLOUD_UNAVAILABLE"`) {
		t.Fatalf("unavailable status/body = %d %q", response.Code, response.Body.String())
	}
}

type officialHTTPStub struct {
	err      error
	mutation MutationRequest
}

func (stub *officialHTTPStub) ListDefinitions(context.Context, admin.Actor, cloudadmin.PageRequest) (cloudadmin.Page[cloudadmin.OfficialDefinition], error) {
	return cloudadmin.Page[cloudadmin.OfficialDefinition]{Items: []cloudadmin.OfficialDefinition{}}, stub.err
}
func (stub *officialHTTPStub) GetDefinition(context.Context, admin.Actor, uuid.UUID) (cloudadmin.OfficialDefinitionDetail, error) {
	return cloudadmin.OfficialDefinitionDetail{ID: uuid.MustParse(httpDefinitionID)}, stub.err
}
func (stub *officialHTTPStub) ListDrafts(context.Context, admin.Actor, cloudadmin.PageRequest) (cloudadmin.Page[cloudadmin.OfficialDraft], error) {
	return cloudadmin.Page[cloudadmin.OfficialDraft]{Items: []cloudadmin.OfficialDraft{}}, stub.err
}
func (stub *officialHTTPStub) GetDraft(context.Context, admin.Actor, uuid.UUID) (cloudadmin.OfficialDraft, error) {
	return cloudadmin.OfficialDraft{ID: uuid.MustParse(httpDraftID)}, stub.err
}
func (stub *officialHTTPStub) ValidateDraft(context.Context, admin.Actor, uuid.UUID) (cloudadmin.OfficialDraftValidation, error) {
	return cloudadmin.OfficialDraftValidation{DraftID: uuid.MustParse(httpDraftID), Findings: []cloudadmin.OfficialValidationFinding{}}, stub.err
}
func (stub *officialHTTPStub) ListSubmissions(context.Context, admin.Actor, cloudadmin.OfficialSubmissionFilter) (cloudadmin.Page[cloudadmin.OfficialSubmission], error) {
	return cloudadmin.Page[cloudadmin.OfficialSubmission]{Items: []cloudadmin.OfficialSubmission{}}, stub.err
}
func (stub *officialHTTPStub) GetSubmission(context.Context, admin.Actor, uuid.UUID) (cloudadmin.OfficialSubmission, error) {
	return cloudadmin.OfficialSubmission{ID: uuid.MustParse(httpSubmissionID)}, stub.err
}
func (stub *officialHTTPStub) ListVersions(context.Context, admin.Actor, cloudadmin.PageRequest) (cloudadmin.Page[cloudadmin.OfficialVersion], error) {
	return cloudadmin.Page[cloudadmin.OfficialVersion]{Items: []cloudadmin.OfficialVersion{}}, stub.err
}
func (stub *officialHTTPStub) ListReleases(context.Context, admin.Actor, cloudadmin.PageRequest) (cloudadmin.Page[cloudadmin.OfficialRelease], error) {
	return cloudadmin.Page[cloudadmin.OfficialRelease]{Items: []cloudadmin.OfficialRelease{}}, stub.err
}
func (stub *officialHTTPStub) GetRelease(context.Context, admin.Actor, uuid.UUID) (cloudadmin.OfficialReleaseDetail, error) {
	return cloudadmin.OfficialReleaseDetail{ID: uuid.MustParse(httpReleaseID)}, stub.err
}
func (stub *officialHTTPStub) ListRollbacks(context.Context, admin.Actor, ListFilter) (RollbackPage, error) {
	return RollbackPage{Items: []RollbackApproval{}}, stub.err
}
func (stub *officialHTTPStub) ListAudit(context.Context, admin.Actor, cloudadmin.PageRequest) (cloudadmin.Page[cloudadmin.OfficialAuditEvent], error) {
	return cloudadmin.Page[cloudadmin.OfficialAuditEvent]{Items: []cloudadmin.OfficialAuditEvent{}}, stub.err
}
func (stub *officialHTTPStub) Enqueue(_ context.Context, _ admin.Actor, request MutationRequest) (operations.Result, error) {
	stub.mutation = request
	return operations.Result{OperationID: uuid.New(), State: operations.StateQueued, UpdatedAt: time.Now().UTC()}, stub.err
}
func (stub *officialHTTPStub) RequestRollback(context.Context, admin.Actor, RollbackRequest) (RollbackApproval, error) {
	return officialHTTPApproval(PendingReview, NotStarted), stub.err
}
func (stub *officialHTTPStub) ApproveRollback(context.Context, admin.Actor, uuid.UUID, string) (RollbackApproval, error) {
	return officialHTTPApproval(Approved, Queued), stub.err
}
func (stub *officialHTTPStub) RejectRollback(context.Context, admin.Actor, uuid.UUID) (RollbackApproval, error) {
	return officialHTTPApproval(Rejected, NotStarted), stub.err
}
func (stub *officialHTTPStub) CancelRollback(context.Context, admin.Actor, uuid.UUID) (RollbackApproval, error) {
	return officialHTTPApproval(Cancelled, NotStarted), stub.err
}

func officialHTTPApproval(status ApprovalStatus, execution ExecutionStatus) RollbackApproval {
	now := time.Now().UTC()
	return RollbackApproval{
		ID: uuid.MustParse(httpApprovalID), ReleaseID: uuid.MustParse(httpReleaseID),
		TargetVersionID: uuid.MustParse(httpVersionID), TargetReleaseRevisionID: uuid.MustParse(httpRevisionID),
		ExpectedHeadRevision: 1, TargetDigest: httpDigest, RequestedByAdminID: uuid.New(),
		ReasonCode: "release_rollback", ApprovalStatus: status, ExecutionStatus: execution,
		ExpiresAt: now.Add(time.Hour), CreatedAt: now, UpdatedAt: now, Version: 1, Events: []RollbackEvent{},
	}
}

func officialHTTPPrincipal(role rbac.Role, recent bool) auth.Principal {
	now := time.Now().UTC()
	principal := auth.Principal{
		AdminID: uuid.NewString(), SessionID: uuid.NewString(), Role: role,
		SecurityVersion: 1, MFAAuthenticatedAt: now, MFAMethod: auth.MFAMethodTOTP,
	}
	if recent {
		principal.TOTPAuthenticatedAt = &now
	}
	return principal
}

func mutationJSON(payload string) string {
	return `{"expected_revision":1,"expected_target_digest":"","reason_code":"definition_create","ticket_reference":"","note":"","payload":` + payload + `}`
}

func rollbackJSON() string {
	return `{"target_version_id":"` + httpVersionID + `","target_release_revision_id":"` + httpRevisionID +
		`","expected_head_revision":1,"target_digest":"` + httpDigest +
		`","reason_code":"release_rollback","ticket_reference":"","note":""}`
}
