package testkit

import (
	"context"
	"os"
	"testing"
	"time"

	"github.com/bignormal/aera-admin/internal/store"
	"github.com/google/uuid"
	"github.com/redis/go-redis/v9"
)

func Redis(t testing.TB) (*redis.Client, string) {
	t.Helper()
	address := os.Getenv("AERA_ADMIN_TEST_REDIS_ADDR")
	if address == "" {
		t.Skip("AERA_ADMIN_TEST_REDIS_ADDR is not configured")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	redisStore, err := store.OpenRedis(ctx, store.RedisConfig{Address: address})
	if err != nil {
		t.Fatalf("open integration Redis: %v", err)
	}
	client := redisStore.Client()
	prefix := "aera-admin-test:" + uuid.NewString() + ":"
	t.Cleanup(func() {
		cleanupCtx, cleanupCancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cleanupCancel()
		var cursor uint64
		for {
			keys, next, scanErr := client.Scan(cleanupCtx, cursor, prefix+"*", 100).Result()
			if scanErr != nil {
				t.Errorf("scan isolated Redis keys: %v", scanErr)
				break
			}
			if len(keys) > 0 {
				if deleteErr := client.Del(cleanupCtx, keys...).Err(); deleteErr != nil {
					t.Errorf("delete isolated Redis keys: %v", deleteErr)
					break
				}
			}
			cursor = next
			if cursor == 0 {
				break
			}
		}
		if closeErr := redisStore.Close(); closeErr != nil {
			t.Errorf("close integration Redis: %v", closeErr)
		}
	})
	return client, prefix
}
