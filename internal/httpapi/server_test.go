package httpapi

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestLivenessDoesNotDependOnExternalServices(t *testing.T) {
	handler := New(Dependencies{})
	response := serve(handler, http.MethodGet, "/health/live")
	assertJSONStatus(t, response, http.StatusOK, "{\"status\":\"ok\"}\n")
}

func TestReadinessFailsClosedWithoutDependencies(t *testing.T) {
	handler := New(Dependencies{})
	response := serve(handler, http.MethodGet, "/health/ready")
	assertJSONStatus(t, response, http.StatusServiceUnavailable, "{\"status\":\"unavailable\"}\n")
}

func TestReadinessFailsClosedWhenDependencyFails(t *testing.T) {
	for name, dependencies := range map[string]Dependencies{
		"postgres": {PostgreSQL: stubChecker{err: errors.New("database password leaked")}, Redis: stubChecker{}},
		"redis":    {PostgreSQL: stubChecker{}, Redis: stubChecker{err: errors.New("redis password leaked")}},
	} {
		t.Run(name, func(t *testing.T) {
			response := serve(New(dependencies), http.MethodGet, "/health/ready")
			assertJSONStatus(t, response, http.StatusServiceUnavailable, "{\"status\":\"unavailable\"}\n")
			if response.Body.String() == "database password leaked" || response.Body.String() == "redis password leaked" {
				t.Fatal("readiness response leaked a dependency error")
			}
		})
	}
}

func TestReadinessSucceedsWhenDependenciesRespond(t *testing.T) {
	handler := New(Dependencies{PostgreSQL: stubChecker{}, Redis: stubChecker{}})
	response := serve(handler, http.MethodGet, "/health/ready")
	assertJSONStatus(t, response, http.StatusOK, "{\"status\":\"ok\"}\n")
}

func TestServiceRoutesDoNotFallThroughToWeb(t *testing.T) {
	web := http.HandlerFunc(func(response http.ResponseWriter, _ *http.Request) {
		response.WriteHeader(http.StatusTeapot)
	})
	handler := New(Dependencies{Web: web})
	for _, path := range []string{"/api/v1/missing", "/health/missing"} {
		response := serve(handler, http.MethodGet, path)
		if response.Code != http.StatusNotFound {
			t.Fatalf("GET %s status = %d, want 404", path, response.Code)
		}
	}
	if response := serve(handler, http.MethodGet, "/dashboard"); response.Code != http.StatusTeapot {
		t.Fatalf("SPA fallback status = %d, want 418", response.Code)
	}
}

type stubChecker struct {
	err error
}

func (checker stubChecker) Ping(context.Context) error {
	return checker.err
}

func serve(handler http.Handler, method, path string) *httptest.ResponseRecorder {
	request := httptest.NewRequest(method, path, nil)
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	return response
}

func assertJSONStatus(t *testing.T, response *httptest.ResponseRecorder, wantStatus int, wantBody string) {
	t.Helper()
	if response.Code != wantStatus || response.Body.String() != wantBody {
		t.Fatalf("response = %d %q, want %d %q", response.Code, response.Body.String(), wantStatus, wantBody)
	}
	if contentType := response.Header().Get("Content-Type"); contentType != "application/json" {
		t.Fatalf("Content-Type = %q", contentType)
	}
	if cacheControl := response.Header().Get("Cache-Control"); cacheControl != "no-store" {
		t.Fatalf("Cache-Control = %q", cacheControl)
	}
}
