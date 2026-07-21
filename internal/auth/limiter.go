package auth

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"time"

	"github.com/redis/go-redis/v9"
)

const attemptWindow = 15 * time.Minute

var recordAttemptScript = redis.NewScript(`
local count = redis.call('INCR', KEYS[1])
if count == 1 then
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
end
local delay = 0
if count >= tonumber(ARGV[4]) then
  delay = tonumber(ARGV[7])
elseif count >= tonumber(ARGV[3]) then
  delay = tonumber(ARGV[6])
elseif count >= tonumber(ARGV[2]) then
  delay = tonumber(ARGV[5])
end
if delay > 0 then
  redis.call('SET', KEYS[2], '1', 'PX', delay)
end
return {count, delay}
`)

type attemptLimiter struct {
	client *redis.Client
	prefix string
}

type attemptPolicy struct {
	firstThreshold  int64
	secondThreshold int64
	blockThreshold  int64
	firstDelay      time.Duration
	secondDelay     time.Duration
	blockDuration   time.Duration
}

var (
	accountAttemptPolicy = attemptPolicy{
		firstThreshold: 3, secondThreshold: 4, blockThreshold: 5,
		firstDelay: 2 * time.Second, secondDelay: 5 * time.Second, blockDuration: attemptWindow,
	}
	ipAttemptPolicy = attemptPolicy{
		firstThreshold: 10, secondThreshold: 15, blockThreshold: 20,
		firstDelay: time.Second, secondDelay: 5 * time.Second, blockDuration: attemptWindow,
	}
)

func (limiter *attemptLimiter) check(ctx context.Context, scope string, subject, sourceIP []byte) (time.Duration, error) {
	if limiter == nil || limiter.client == nil || !validAttemptScope(scope) || len(sourceIP) != sha256.Size ||
		(len(subject) != 0 && len(subject) != sha256.Size) {
		return 0, ErrUnavailable
	}
	keys := make([]string, 0, 2)
	if len(subject) == sha256.Size {
		keys = append(keys, limiter.lockKey(scope, "account", subject))
	}
	keys = append(keys, limiter.lockKey(scope, "ip", sourceIP))
	commands := make([]*redis.DurationCmd, 0, len(keys))
	pipeline := limiter.client.Pipeline()
	for _, key := range keys {
		commands = append(commands, pipeline.PTTL(ctx, key))
	}
	if _, err := pipeline.Exec(ctx); err != nil && !errors.Is(err, redis.Nil) {
		return 0, ErrUnavailable
	}
	var retryAfter time.Duration
	for _, command := range commands {
		remaining, err := command.Result()
		if err != nil && !errors.Is(err, redis.Nil) {
			return 0, ErrUnavailable
		}
		if remaining > retryAfter {
			retryAfter = remaining
		}
	}
	return boundedRetryAfter(retryAfter), nil
}

func (limiter *attemptLimiter) failure(ctx context.Context, scope string, subject, sourceIP []byte) (time.Duration, error) {
	if limiter == nil || limiter.client == nil || !validAttemptScope(scope) || len(sourceIP) != sha256.Size ||
		(len(subject) != 0 && len(subject) != sha256.Size) {
		return 0, ErrUnavailable
	}
	var retryAfter time.Duration
	if len(subject) == sha256.Size {
		delay, err := limiter.record(ctx, scope, "account", subject, accountAttemptPolicy)
		if err != nil {
			return 0, err
		}
		retryAfter = delay
	}
	delay, err := limiter.record(ctx, scope, "ip", sourceIP, ipAttemptPolicy)
	if err != nil {
		return 0, err
	}
	if delay > retryAfter {
		retryAfter = delay
	}
	return boundedRetryAfter(retryAfter), nil
}

func (limiter *attemptLimiter) success(ctx context.Context, scope string, subject []byte) error {
	if limiter == nil || limiter.client == nil || !validAttemptScope(scope) || len(subject) != sha256.Size {
		return ErrUnavailable
	}
	if err := limiter.client.Del(
		ctx,
		limiter.attemptKey(scope, "account", subject),
		limiter.lockKey(scope, "account", subject),
	).Err(); err != nil {
		return ErrUnavailable
	}
	return nil
}

func (limiter *attemptLimiter) record(
	ctx context.Context,
	scope, dimension string,
	digest []byte,
	policy attemptPolicy,
) (time.Duration, error) {
	result, err := recordAttemptScript.Run(
		ctx,
		limiter.client,
		[]string{limiter.attemptKey(scope, dimension, digest), limiter.lockKey(scope, dimension, digest)},
		attemptWindow.Milliseconds(),
		policy.firstThreshold,
		policy.secondThreshold,
		policy.blockThreshold,
		policy.firstDelay.Milliseconds(),
		policy.secondDelay.Milliseconds(),
		policy.blockDuration.Milliseconds(),
	).Slice()
	if err != nil || len(result) != 2 {
		return 0, ErrUnavailable
	}
	delayMilliseconds, ok := result[1].(int64)
	if !ok || delayMilliseconds < 0 {
		return 0, ErrUnavailable
	}
	return time.Duration(delayMilliseconds) * time.Millisecond, nil
}

func (limiter *attemptLimiter) attemptKey(scope, dimension string, digest []byte) string {
	return limiter.prefix + "attempt:" + scope + ":" + dimension + ":" + hex.EncodeToString(digest)
}

func (limiter *attemptLimiter) lockKey(scope, dimension string, digest []byte) string {
	return limiter.prefix + "attempt-lock:" + scope + ":" + dimension + ":" + hex.EncodeToString(digest)
}

func validAttemptScope(scope string) bool {
	return scope == "login" || scope == "activation"
}

func boundedRetryAfter(value time.Duration) time.Duration {
	if value <= 0 {
		return 0
	}
	if value > attemptWindow {
		return attemptWindow
	}
	return value
}
