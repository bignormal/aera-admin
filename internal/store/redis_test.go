package store

import (
	"context"
	"strings"
	"testing"
)

func TestOpenRedisRejectsMalformedAddressWithoutEchoingIt(t *testing.T) {
	const raw = "redis-secret-canary"
	client, err := OpenRedis(context.Background(), RedisConfig{Address: raw})
	if client != nil {
		_ = client.Close()
		t.Fatal("OpenRedis() returned a client for malformed address")
	}
	if err == nil {
		t.Fatal("OpenRedis() accepted malformed address")
	}
	if strings.Contains(err.Error(), raw) || strings.Contains(err.Error(), "secret-canary") {
		t.Fatalf("OpenRedis() leaked configuration in error %q", err)
	}
}
