package httpapi

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
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

func TestAPIMountStripsThePublicPrefixForStandardLibraryHandlers(t *testing.T) {
	api := http.NewServeMux()
	api.HandleFunc("/auth/probe", func(response http.ResponseWriter, request *http.Request) {
		if request.URL.Path != "/auth/probe" {
			t.Fatalf("mounted API path = %q, want /auth/probe", request.URL.Path)
		}
		response.WriteHeader(http.StatusNoContent)
	})
	response := serve(New(Dependencies{API: api}), http.MethodGet, "/api/v1/auth/probe")
	if response.Code != http.StatusNoContent {
		t.Fatalf("mounted API response = %d, want 204", response.Code)
	}
}

func TestSecurityHeadersCoverHealthAPIWebAndNotFoundResponses(t *testing.T) {
	api := http.HandlerFunc(func(response http.ResponseWriter, _ *http.Request) {
		response.Header().Set("Content-Type", "application/json")
		response.WriteHeader(http.StatusOK)
	})
	web := http.HandlerFunc(func(response http.ResponseWriter, _ *http.Request) {
		response.Header().Set("Content-Type", "text/html; charset=utf-8")
		response.WriteHeader(http.StatusOK)
	})
	handler := New(Dependencies{PostgreSQL: stubChecker{}, Redis: stubChecker{}, API: api, Web: web, Production: true})

	for _, path := range []string{"/health/live", "/api/v1/probe", "/dashboard", "/health/missing"} {
		t.Run(path, func(t *testing.T) {
			response := serve(handler, http.MethodGet, path)
			assertSecurityHeaders(t, response, true)
		})
	}
}

func TestHSTSIsOnlyEmittedForProduction(t *testing.T) {
	response := serve(New(Dependencies{Web: http.HandlerFunc(func(response http.ResponseWriter, _ *http.Request) {
		response.WriteHeader(http.StatusOK)
	})}), http.MethodGet, "/login")
	assertSecurityHeaders(t, response, false)
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

func assertSecurityHeaders(t *testing.T, response *httptest.ResponseRecorder, production bool) {
	t.Helper()
	want := map[string]string{
		"Content-Security-Policy":      "default-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; object-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; font-src 'self' data:",
		"Cross-Origin-Opener-Policy":   "same-origin",
		"Cross-Origin-Resource-Policy": "same-origin",
		"Permissions-Policy":           "camera=(), geolocation=(), microphone=(), payment=(), usb=()",
		"Referrer-Policy":              "no-referrer",
		"X-Content-Type-Options":       "nosniff",
		"X-Frame-Options":              "DENY",
	}
	for name, value := range want {
		if got := response.Header().Get(name); got != value {
			t.Errorf("%s = %q, want %q", name, got, value)
		}
	}
	if hsts := response.Header().Get("Strict-Transport-Security"); production != strings.Contains(hsts, "max-age=") {
		t.Errorf("Strict-Transport-Security = %q, production = %v", hsts, production)
	}
}
