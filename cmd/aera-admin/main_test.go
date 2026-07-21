package main

import (
	"context"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/bignormal/aera-admin/internal/config"
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

var _ config.LookupEnv = func(string) (string, bool) { return "", false }
