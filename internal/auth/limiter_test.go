package auth

import (
	"bytes"
	"context"
	"errors"
	"sync"
	"testing"
	"time"

	"github.com/bignormal/aera-admin/internal/testkit"
)

func TestAttemptLimiterAtomicAdmissionStopsConcurrentValidationAtThreshold(t *testing.T) {
	for _, scope := range []string{"login", "activation"} {
		t.Run(scope, func(t *testing.T) {
			redisClient, prefix := testkit.Redis(t)
			limiter := &attemptLimiter{client: redisClient, prefix: prefix}
			subject := bytes.Repeat([]byte{1}, 32)
			sourceIP := bytes.Repeat([]byte{2}, 32)

			const workers = 20
			start := make(chan struct{})
			results := make(chan error, workers)
			var wait sync.WaitGroup
			for worker := 0; worker < workers; worker++ {
				wait.Add(1)
				go func() {
					defer wait.Done()
					<-start
					_, err := limiter.admit(context.Background(), scope, subject, sourceIP)
					results <- err
				}()
			}
			close(start)
			wait.Wait()
			close(results)

			var admitted, limited int
			for err := range results {
				switch {
				case err == nil:
					admitted++
				case errors.Is(err, ErrRateLimited):
					limited++
				default:
					t.Fatalf("admit() error = %v", err)
				}
			}
			if admitted != int(accountAttemptPolicy.firstThreshold) || limited != workers-admitted {
				t.Fatalf("atomic admission = admitted:%d limited:%d, want %d/%d", admitted, limited, accountAttemptPolicy.firstThreshold, workers-int(accountAttemptPolicy.firstThreshold))
			}
		})
	}
}

func TestAttemptReservationReleaseRemovesOnlyThatAttempt(t *testing.T) {
	redisClient, prefix := testkit.Redis(t)
	limiter := &attemptLimiter{client: redisClient, prefix: prefix}
	subject := bytes.Repeat([]byte{3}, 32)
	sourceIP := bytes.Repeat([]byte{4}, 32)
	ctx := context.Background()

	if _, err := limiter.admit(ctx, "login", subject, sourceIP); err != nil {
		t.Fatalf("admit(first failure) error = %v", err)
	}
	correct, err := limiter.admit(ctx, "login", subject, sourceIP)
	if err != nil {
		t.Fatalf("admit(correct attempt) error = %v", err)
	}
	if err := limiter.release(ctx, correct); err != nil {
		t.Fatalf("release(correct attempt) error = %v", err)
	}

	accountCount, err := redisClient.Get(ctx, limiter.attemptKey("login", "account", subject)).Int64()
	if err != nil || accountCount != 1 {
		t.Fatalf("account failures after release = %d, %v, want 1", accountCount, err)
	}
	ipCount, err := redisClient.Get(ctx, limiter.attemptKey("login", "ip", sourceIP)).Int64()
	if err != nil || ipCount != 1 {
		t.Fatalf("IP failures after release = %d, %v, want 1", ipCount, err)
	}
}

func TestCompletedAttemptClearsSubjectFailuresButPreservesIPHistory(t *testing.T) {
	redisClient, prefix := testkit.Redis(t)
	limiter := &attemptLimiter{client: redisClient, prefix: prefix}
	subject := bytes.Repeat([]byte{5}, 32)
	sourceIP := bytes.Repeat([]byte{6}, 32)
	ctx := context.Background()

	if _, err := limiter.admit(ctx, "login", subject, sourceIP); err != nil {
		t.Fatalf("admit(historical failure) error = %v", err)
	}
	completed, err := limiter.admit(ctx, "login", subject, sourceIP)
	if err != nil {
		t.Fatalf("admit(completed attempt) error = %v", err)
	}
	if err := limiter.complete(ctx, completed); err != nil {
		t.Fatalf("complete() error = %v", err)
	}

	if exists, err := redisClient.Exists(ctx, limiter.attemptKey("login", "account", subject)).Result(); err != nil || exists != 0 {
		t.Fatalf("account failures after completion = exists:%d error:%v, want cleared", exists, err)
	}
	ipCount, err := redisClient.Get(ctx, limiter.attemptKey("login", "ip", sourceIP)).Int64()
	if err != nil || ipCount != 1 {
		t.Fatalf("IP history after completion = %d, %v, want 1", ipCount, err)
	}
}

func TestAttemptLimiterRejectsPreexistingLockWithoutNewReservation(t *testing.T) {
	redisClient, prefix := testkit.Redis(t)
	limiter := &attemptLimiter{client: redisClient, prefix: prefix}
	subject := bytes.Repeat([]byte{7}, 32)
	sourceIP := bytes.Repeat([]byte{8}, 32)
	ctx := context.Background()
	if err := redisClient.Set(ctx, limiter.lockKey("login", "account", subject), "existing", time.Minute).Err(); err != nil {
		t.Fatalf("seed account lock: %v", err)
	}

	if _, err := limiter.admit(ctx, "login", subject, sourceIP); !errors.Is(err, ErrRateLimited) {
		t.Fatalf("admit() error = %v, want ErrRateLimited", err)
	}
	for _, key := range []string{
		limiter.attemptKey("login", "account", subject),
		limiter.attemptKey("login", "ip", sourceIP),
	} {
		if exists, err := redisClient.Exists(ctx, key).Result(); err != nil || exists != 0 {
			t.Fatalf("denied admission changed %q: exists=%d error=%v", key, exists, err)
		}
	}
}
