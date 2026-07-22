package audithttp

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/bignormal/aera-admin/internal/audit"
	"github.com/bignormal/aera-admin/internal/auth"
	"github.com/bignormal/aera-admin/internal/rbac"
	"github.com/google/uuid"
)

func TestHTTPEnforcesFullAndOwnAuditScopes(t *testing.T) {
	ownID := uuid.MustParse("019f0000-0000-7000-8000-000000000001")
	otherID := uuid.MustParse("019f0000-0000-7000-8000-000000000002")

	tests := []struct {
		name      string
		role      rbac.Role
		wantActor *uuid.UUID
	}{
		{"super administrator full", rbac.SuperAdmin, &otherID},
		{"auditor full", rbac.Auditor, &otherID},
		{"operator own", rbac.Operator, &ownID},
		{"support own", rbac.Support, &ownID},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			service := &fakeService{page: audit.Page{Items: []audit.PublicEvent{}}}
			handler := NewHandler(service)
			request := authenticatedRequest(http.MethodGet, "/audit-events?actor_admin_id="+otherID.String(), ownID, test.role)
			response := httptest.NewRecorder()

			handler.ServeHTTP(response, request)

			if response.Code != http.StatusOK {
				t.Fatalf("status = %d, body = %s", response.Code, response.Body.String())
			}
			if service.query.ActorAdminID == nil || *service.query.ActorAdminID != *test.wantActor {
				t.Fatalf("effective actor filter = %v, want %s", service.query.ActorAdminID, test.wantActor)
			}
			if response.Header().Get("Cache-Control") != "no-store" {
				t.Fatalf("Cache-Control = %q", response.Header().Get("Cache-Control"))
			}
		})
	}
}

func TestHTTPRejectsRolesWithoutAuditPermissionBeforeQuery(t *testing.T) {
	for _, role := range []rbac.Role{rbac.Developer, rbac.Finance} {
		t.Run(string(role), func(t *testing.T) {
			service := &fakeService{}
			response := httptest.NewRecorder()
			request := authenticatedRequest(http.MethodGet, "/audit-events", uuid.New(), role)
			NewHandler(service).ServeHTTP(response, request)
			if response.Code != http.StatusForbidden || errorCode(t, response.Body.Bytes()) != "PERMISSION_DENIED" {
				t.Fatalf("status/body = %d/%s", response.Code, response.Body.String())
			}
			if service.listCalls != 0 || service.appendCalls != 0 {
				t.Fatalf("unauthorized request reached service: list=%d append=%d", service.listCalls, service.appendCalls)
			}
		})
	}
}

func TestHTTPParsesFiltersAndAuditsOnlyFilterClasses(t *testing.T) {
	actorID := uuid.MustParse("019f0000-0000-7000-8000-000000000001")
	objectID := uuid.MustParse("019f0000-0000-7000-8000-000000000003")
	createdAt := time.Date(2026, time.July, 22, 9, 0, 0, 0, time.UTC)
	service := &fakeService{page: audit.Page{Items: []audit.PublicEvent{{
		ID: uuid.New(), EventType: "admin_login_succeeded", ObjectType: "admin_user",
		Outcome: audit.OutcomeSuccess, RequestID: "req-source", CreatedAt: createdAt,
	}}}}
	path := "/audit-events?limit=25&event_type=admin_login_succeeded&object_type=admin_user&object_id=" + objectID.String() +
		"&outcome=success&reason_code=access_review&from=2026-07-22T08%3A00%3A00Z&to=2026-07-22T10%3A00%3A00Z"
	request := authenticatedRequest(http.MethodGet, path, actorID, rbac.SuperAdmin)
	response := httptest.NewRecorder()

	NewHandler(service).ServeHTTP(response, request)

	if response.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", response.Code, response.Body.String())
	}
	if service.query.Limit != 25 || service.query.EventType != "admin_login_succeeded" ||
		service.query.ObjectType != "admin_user" || service.query.ObjectID == nil || *service.query.ObjectID != objectID ||
		service.query.Outcome != audit.OutcomeSuccess || service.query.ReasonCode != "access_review" {
		t.Fatalf("parsed query = %#v", service.query)
	}
	if service.appendCalls != 1 || service.record.EventType != "audit_events_viewed" ||
		service.record.ActorAdminID == nil || *service.record.ActorAdminID != actorID ||
		service.record.AfterState["result_count"] != "1" || service.record.AfterState["filter_event"] != "true" ||
		service.record.AfterState["filter_object"] != "true" || service.record.AfterState["filter_outcome"] != "true" ||
		service.record.AfterState["filter_reason"] != "true" || service.record.AfterState["filter_time"] != "true" {
		t.Fatalf("query audit record = %#v", service.record)
	}
	encoded, _ := json.Marshal(service.record.AfterState)
	for _, rawValue := range []string{objectID.String(), "admin_login_succeeded", "access_review"} {
		if bytes.Contains(encoded, []byte(rawValue)) {
			t.Fatalf("query audit leaked filter value %q: %s", rawValue, encoded)
		}
	}
}

func TestHTTPRejectsInvalidQueryAndFailsClosedWhenQueryAuditFails(t *testing.T) {
	actorID := uuid.New()
	t.Run("invalid cursor", func(t *testing.T) {
		service := &fakeService{}
		response := httptest.NewRecorder()
		NewHandler(service).ServeHTTP(response, authenticatedRequest(http.MethodGet, "/audit-events?cursor=not-base64!", actorID, rbac.Auditor))
		if response.Code != http.StatusBadRequest || errorCode(t, response.Body.Bytes()) != "AUDIT_CURSOR_INVALID" {
			t.Fatalf("status/body = %d/%s", response.Code, response.Body.String())
		}
	})

	t.Run("audit append failure", func(t *testing.T) {
		service := &fakeService{page: audit.Page{Items: []audit.PublicEvent{}}, appendErr: errors.New("unavailable")}
		response := httptest.NewRecorder()
		NewHandler(service).ServeHTTP(response, authenticatedRequest(http.MethodGet, "/audit-events", actorID, rbac.Auditor))
		if response.Code != http.StatusServiceUnavailable || errorCode(t, response.Body.Bytes()) != "AUDIT_UNAVAILABLE" {
			t.Fatalf("status/body = %d/%s", response.Code, response.Body.String())
		}
	})
}

func TestHTTPResponseProjectionHasNoSensitiveAuditColumns(t *testing.T) {
	service := &fakeService{page: audit.Page{Items: []audit.PublicEvent{{
		ID: uuid.New(), EventType: "admin_login_succeeded", ObjectType: "admin_user",
		Outcome: audit.OutcomeSuccess, RequestID: "req-safe", CreatedAt: time.Now().UTC(),
	}}}}
	response := httptest.NewRecorder()
	NewHandler(service).ServeHTTP(response, authenticatedRequest(http.MethodGet, "/audit-events", uuid.New(), rbac.Auditor))
	if response.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", response.Code, response.Body.String())
	}
	for _, forbidden := range []string{"source_ip_hmac", "user_agent", "previous_hash", "event_hash"} {
		if strings.Contains(response.Body.String(), forbidden) {
			t.Fatalf("response contains %q: %s", forbidden, response.Body.String())
		}
	}
}

type fakeService struct {
	page        audit.Page
	listErr     error
	appendErr   error
	query       audit.Query
	record      audit.Record
	listCalls   int
	appendCalls int
}

func (service *fakeService) List(_ context.Context, query audit.Query) (audit.Page, error) {
	service.listCalls++
	service.query = query
	return service.page, service.listErr
}

func (service *fakeService) Append(_ context.Context, record audit.Record) (uuid.UUID, error) {
	service.appendCalls++
	service.record = record
	return uuid.New(), service.appendErr
}

func authenticatedRequest(method, target string, adminID uuid.UUID, role rbac.Role) *http.Request {
	request := httptest.NewRequest(method, target, nil)
	request = auth.WithPrincipal(request, auth.Principal{AdminID: adminID.String(), Role: role})
	return auth.WithRequestMeta(request, auth.RequestMeta{
		RequestID: "req-audit-http", SourceIPHMAC: bytes.Repeat([]byte{7}, 32), UserAgent: "Audit Test",
	})
}

func errorCode(t *testing.T, body []byte) string {
	t.Helper()
	var document struct {
		Error struct {
			Code string `json:"code"`
		} `json:"error"`
	}
	if err := json.Unmarshal(body, &document); err != nil {
		t.Fatalf("decode error response: %v; body=%s", err, body)
	}
	return document.Error.Code
}
