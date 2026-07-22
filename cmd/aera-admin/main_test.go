package main

import (
	"bytes"
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/bignormal/aera-admin/internal/config"
	"github.com/bignormal/aera-admin/internal/testkit"
	"github.com/google/uuid"
)

func TestRunRejectsInvalidConfigBeforeOpeningDependencies(t *testing.T) {
	err := run(context.Background(), func(string) (string, bool) { return "", false })
	if err == nil || !strings.Contains(err.Error(), "AERA_ADMIN_ENVIRONMENT") {
		t.Fatalf("run() error = %v", err)
	}
}

func TestNewHTTPServerUsesBoundedTimeouts(t *testing.T) {
	server := newHTTPServer("127.0.0.1:8080", http.NotFoundHandler())
	if server.Addr != "127.0.0.1:8080" || server.ReadHeaderTimeout != 5*time.Second ||
		server.ReadTimeout != 15*time.Second || server.WriteTimeout != 30*time.Second ||
		server.IdleTimeout != 60*time.Second {
		t.Fatalf("server timeouts = header:%s read:%s write:%s idle:%s", server.ReadHeaderTimeout, server.ReadTimeout, server.WriteTimeout, server.IdleTimeout)
	}
}

func TestNewAdminRouterRegistersAuditRoute(t *testing.T) {
	auditHandler := http.HandlerFunc(func(response http.ResponseWriter, _ *http.Request) {
		response.WriteHeader(http.StatusNoContent)
	})
	router := newAdminRouter(http.NotFoundHandler(), http.NotFoundHandler(), http.NotFoundHandler(), auditHandler)
	response := httptest.NewRecorder()
	router.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/audit-events", nil))
	if response.Code != http.StatusNoContent {
		t.Fatalf("audit route response = %d, want %d", response.Code, http.StatusNoContent)
	}
}

func TestBuildAdminRuntimeWiresPublicAuthProtectedRoutesAndWorker(t *testing.T) {
	postgres := testkit.Postgres(t)
	redisClient, _ := testkit.Redis(t)
	keyRing := config.KeyRing{ActiveKeyID: "v1", Keys: map[string][]byte{"v1": bytes.Repeat([]byte{7}, 32)}}
	settings := config.Config{
		Environment: "test-" + uuid.NewString(), PublicURL: "https://admin.example.test",
		IdentityEncryptionKeys: keyRing, IdentityLookupKeys: keyRing, TOTPEncryptionKeys: keyRing,
		SessionHMACKey: bytes.Repeat([]byte{8}, 32), CSRFHMACKey: bytes.Repeat([]byte{9}, 32),
		OperationHMACKey: bytes.Repeat([]byte{10}, 32),
	}
	runtimePrefix := "aera-admin:" + settings.Environment + ":"
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		var cursor uint64
		for {
			keys, next, scanErr := redisClient.Scan(ctx, cursor, runtimePrefix+"*", 100).Result()
			if scanErr != nil {
				t.Errorf("scan runtime test Redis keys: %v", scanErr)
				return
			}
			if len(keys) > 0 {
				if deleteErr := redisClient.Del(ctx, keys...).Err(); deleteErr != nil {
					t.Errorf("delete runtime test Redis keys: %v", deleteErr)
					return
				}
			}
			cursor = next
			if cursor == 0 {
				return
			}
		}
	})
	runtime, err := buildAdminRuntime(settings, postgres, redisClient)
	if err != nil {
		t.Fatalf("buildAdminRuntime() error = %v", err)
	}
	if runtime.Worker == nil {
		t.Fatal("buildAdminRuntime() did not compose the Outbox Worker")
	}
	loginRequest := httptest.NewRequest(http.MethodPost, "/auth/login", strings.NewReader(`{"email":"unknown@example.com","password":"correct horse battery staple"}`))
	loginRequest.RemoteAddr = "192.0.2.20:4242"
	loginRequest.Header.Set("Content-Type", "application/json")
	loginRequest.Header.Set("Origin", settings.PublicURL)
	loginResponse := httptest.NewRecorder()
	runtime.API.ServeHTTP(loginResponse, loginRequest)
	if loginResponse.Code != http.StatusUnauthorized || !strings.Contains(loginResponse.Body.String(), `"code":"AUTH_INVALID_CREDENTIALS"`) {
		t.Fatalf("login route response = %d %q", loginResponse.Code, loginResponse.Body.String())
	}
	var sourceHMACLength int
	if err := postgres.QueryRow(context.Background(), `
		SELECT octet_length(source_ip_hmac)
		FROM admin_audit_events
		WHERE event_type = 'admin_login_failed'
		ORDER BY created_at DESC
		LIMIT 1
	`).Scan(&sourceHMACLength); err != nil || sourceHMACLength != 32 {
		t.Fatalf("login failure source IP audit length/error = %d/%v", sourceHMACLength, err)
	}
	for _, path := range []string{"/admin-users", "/audit-events"} {
		protectedRequest := httptest.NewRequest(http.MethodGet, path, nil)
		protectedRequest.RemoteAddr = "192.0.2.20:4242"
		protectedResponse := httptest.NewRecorder()
		runtime.API.ServeHTTP(protectedResponse, protectedRequest)
		if protectedResponse.Code != http.StatusUnauthorized || !strings.Contains(protectedResponse.Body.String(), `"code":"AUTH_REQUIRED"`) {
			t.Fatalf("protected route %s response = %d %q", path, protectedResponse.Code, protectedResponse.Body.String())
		}
	}
	auditRouteProbe := httptest.NewRequest(http.MethodOptions, "/audit-events", nil)
	auditRouteProbe.RemoteAddr = "192.0.2.20:4242"
	auditRouteResponse := httptest.NewRecorder()
	runtime.API.ServeHTTP(auditRouteResponse, auditRouteProbe)
	if auditRouteResponse.Code != http.StatusMethodNotAllowed || !strings.Contains(auditRouteResponse.Body.String(), `"code":"METHOD_NOT_ALLOWED"`) {
		t.Fatalf("audit route probe response = %d %q", auditRouteResponse.Code, auditRouteResponse.Body.String())
	}
}

var _ config.LookupEnv = func(string) (string, bool) { return "", false }
