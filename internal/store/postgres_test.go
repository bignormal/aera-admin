package store

import (
	"context"
	"strings"
	"testing"
)

func TestOpenPostgreSQLRejectsMalformedURLWithoutEchoingIt(t *testing.T) {
	const raw = "not-a-postgres-url-with-secret-canary"
	pool, err := OpenPostgreSQL(context.Background(), raw)
	if pool != nil {
		pool.Close()
		t.Fatal("OpenPostgreSQL() returned a pool for malformed URL")
	}
	if err == nil {
		t.Fatal("OpenPostgreSQL() accepted malformed URL")
	}
	if strings.Contains(err.Error(), raw) || strings.Contains(err.Error(), "secret-canary") {
		t.Fatalf("OpenPostgreSQL() leaked configuration in error %q", err)
	}
}
