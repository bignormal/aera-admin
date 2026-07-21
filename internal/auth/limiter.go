package auth

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"time"

	"github.com/google/uuid"
	"github.com/redis/go-redis/v9"
)

const attemptWindow = 15 * time.Minute

var admitAttemptScript = redis.NewScript(`
local has_subject = ARGV[1] == '1'
local function active_lock(key)
  local ttl = redis.call('PTTL', key)
  if ttl == -1 then
    return -1
  end
  if ttl > 0 then
    return ttl
  end
  return 0
end
local retry = active_lock(KEYS[5])
if retry < 0 then
  return {-1, 0}
end
if has_subject then
  local subject_retry = active_lock(KEYS[2])
  if subject_retry < 0 then
    return {-1, 0}
  end
  if subject_retry > retry then
    retry = subject_retry
  end
end
if retry > 0 then
  return {0, retry}
end

local function reserve(attempt_key, lock_key, reservation_key, window, first_threshold, second_threshold, block_threshold, first_delay, second_delay, block_duration, reservation_id)
  window = tonumber(window)
  first_threshold = tonumber(first_threshold)
  second_threshold = tonumber(second_threshold)
  block_threshold = tonumber(block_threshold)
  first_delay = tonumber(first_delay)
  second_delay = tonumber(second_delay)
  block_duration = tonumber(block_duration)
  if not redis.call('SET', reservation_key, '1', 'PX', window, 'NX') then
    return -1
  end
  local count = redis.call('INCR', attempt_key)
  if count == 1 then
    redis.call('PEXPIRE', attempt_key, window)
  end
  local delay = 0
  if count >= block_threshold then
    delay = block_duration
  elseif count >= second_threshold then
    delay = second_delay
  elseif count >= first_threshold then
    delay = first_delay
  end
  if delay > 0 then
    redis.call('SET', lock_key, reservation_id, 'PX', delay)
  end
  return delay
end

local subject_delay = 0
if has_subject then
  subject_delay = reserve(KEYS[1], KEYS[2], KEYS[3], ARGV[2], ARGV[3], ARGV[4], ARGV[5], ARGV[6], ARGV[7], ARGV[8], ARGV[15])
  if subject_delay < 0 then
    return {-1, 0}
  end
end
local ip_delay = reserve(KEYS[4], KEYS[5], KEYS[6], ARGV[2], ARGV[9], ARGV[10], ARGV[11], ARGV[12], ARGV[13], ARGV[14], ARGV[15])
if ip_delay < 0 then
  return {-1, 0}
end
if ip_delay > subject_delay then
  subject_delay = ip_delay
end
return {1, subject_delay}
`)

var finishAttemptScript = redis.NewScript(`
local has_subject = ARGV[1] == '1'
local clear_subject = ARGV[2] == '1'

local function expected_delay(count, first_threshold, second_threshold, block_threshold, first_delay, second_delay, block_duration)
  first_threshold = tonumber(first_threshold)
  second_threshold = tonumber(second_threshold)
  block_threshold = tonumber(block_threshold)
  first_delay = tonumber(first_delay)
  second_delay = tonumber(second_delay)
  block_duration = tonumber(block_duration)
  if count >= block_threshold then
    return block_duration
  elseif count >= second_threshold then
    return second_delay
  elseif count >= first_threshold then
    return first_delay
  end
  return 0
end

local function release(attempt_key, lock_key, reservation_key, first_threshold, second_threshold, block_threshold, first_delay, second_delay, block_duration)
  if redis.call('DEL', reservation_key) == 0 then
    return
  end
  local count = tonumber(redis.call('GET', attempt_key) or '0')
  if count <= 1 then
    redis.call('DEL', attempt_key, lock_key)
    return
  end
  count = redis.call('DECR', attempt_key)
  local delay = expected_delay(count, first_threshold, second_threshold, block_threshold, first_delay, second_delay, block_duration)
  if delay == 0 then
    redis.call('DEL', lock_key)
    return
  end
  local ttl = redis.call('PTTL', lock_key)
  if ttl <= 0 or ttl > delay then
    redis.call('SET', lock_key, 'reconciled', 'PX', delay)
  end
end

if has_subject then
  if clear_subject then
    redis.call('DEL', KEYS[1], KEYS[2], KEYS[3])
  else
    release(KEYS[1], KEYS[2], KEYS[3], ARGV[3], ARGV[4], ARGV[5], ARGV[6], ARGV[7], ARGV[8])
  end
end
release(KEYS[4], KEYS[5], KEYS[6], ARGV[9], ARGV[10], ARGV[11], ARGV[12], ARGV[13], ARGV[14])
return 1
`)

type attemptLimiter struct {
	client *redis.Client
	prefix string
}

type attemptReservation struct {
	ID         string
	Scope      string
	Subject    []byte
	SourceIP   []byte
	RetryAfter time.Duration
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

func (limiter *attemptLimiter) admit(ctx context.Context, scope string, subject, sourceIP []byte) (attemptReservation, error) {
	if limiter == nil || limiter.client == nil || !validAttemptScope(scope) || len(sourceIP) != sha256.Size ||
		(len(subject) != 0 && len(subject) != sha256.Size) {
		return attemptReservation{}, ErrUnavailable
	}
	reservationID, err := uuid.NewRandom()
	if err != nil {
		return attemptReservation{}, ErrUnavailable
	}
	hasSubject := len(subject) == sha256.Size
	subjectDigest := subject
	if !hasSubject {
		subjectDigest = sourceIP
	}
	result, err := admitAttemptScript.Run(
		ctx,
		limiter.client,
		[]string{
			limiter.attemptKey(scope, "account", subjectDigest),
			limiter.lockKey(scope, "account", subjectDigest),
			limiter.reservationKey(scope, "account", reservationID.String()),
			limiter.attemptKey(scope, "ip", sourceIP),
			limiter.lockKey(scope, "ip", sourceIP),
			limiter.reservationKey(scope, "ip", reservationID.String()),
		},
		boolArgument(hasSubject),
		attemptWindow.Milliseconds(),
		accountAttemptPolicy.firstThreshold,
		accountAttemptPolicy.secondThreshold,
		accountAttemptPolicy.blockThreshold,
		accountAttemptPolicy.firstDelay.Milliseconds(),
		accountAttemptPolicy.secondDelay.Milliseconds(),
		accountAttemptPolicy.blockDuration.Milliseconds(),
		ipAttemptPolicy.firstThreshold,
		ipAttemptPolicy.secondThreshold,
		ipAttemptPolicy.blockThreshold,
		ipAttemptPolicy.firstDelay.Milliseconds(),
		ipAttemptPolicy.secondDelay.Milliseconds(),
		ipAttemptPolicy.blockDuration.Milliseconds(),
		reservationID.String(),
	).Slice()
	if err != nil {
		return attemptReservation{}, ErrUnavailable
	}
	if len(result) != 2 {
		return attemptReservation{}, ErrUnavailable
	}
	admitted, admittedOK := result[0].(int64)
	retryMilliseconds, retryOK := result[1].(int64)
	if !admittedOK || !retryOK || retryMilliseconds < 0 || admitted < 0 {
		return attemptReservation{}, ErrUnavailable
	}
	retryAfter := boundedRetryAfter(time.Duration(retryMilliseconds) * time.Millisecond)
	if admitted == 0 {
		return attemptReservation{}, &RateLimitError{RetryAfter: retryAfter}
	}
	if admitted != 1 {
		return attemptReservation{}, ErrUnavailable
	}
	return attemptReservation{
		ID: reservationID.String(), Scope: scope,
		Subject: append([]byte(nil), subject...), SourceIP: append([]byte(nil), sourceIP...),
		RetryAfter: retryAfter,
	}, nil
}

func (limiter *attemptLimiter) release(ctx context.Context, reservation attemptReservation) error {
	return limiter.finish(ctx, reservation, false)
}

func (limiter *attemptLimiter) complete(ctx context.Context, reservation attemptReservation) error {
	if len(reservation.Subject) != sha256.Size {
		return ErrUnavailable
	}
	return limiter.finish(ctx, reservation, true)
}

func (limiter *attemptLimiter) finish(ctx context.Context, reservation attemptReservation, clearSubject bool) error {
	if limiter == nil || limiter.client == nil || !validAttemptReservation(reservation) {
		return ErrUnavailable
	}
	hasSubject := len(reservation.Subject) == sha256.Size
	subjectDigest := reservation.Subject
	if !hasSubject {
		subjectDigest = reservation.SourceIP
	}
	result, err := finishAttemptScript.Run(
		ctx,
		limiter.client,
		[]string{
			limiter.attemptKey(reservation.Scope, "account", subjectDigest),
			limiter.lockKey(reservation.Scope, "account", subjectDigest),
			limiter.reservationKey(reservation.Scope, "account", reservation.ID),
			limiter.attemptKey(reservation.Scope, "ip", reservation.SourceIP),
			limiter.lockKey(reservation.Scope, "ip", reservation.SourceIP),
			limiter.reservationKey(reservation.Scope, "ip", reservation.ID),
		},
		boolArgument(hasSubject),
		boolArgument(clearSubject),
		accountAttemptPolicy.firstThreshold,
		accountAttemptPolicy.secondThreshold,
		accountAttemptPolicy.blockThreshold,
		accountAttemptPolicy.firstDelay.Milliseconds(),
		accountAttemptPolicy.secondDelay.Milliseconds(),
		accountAttemptPolicy.blockDuration.Milliseconds(),
		ipAttemptPolicy.firstThreshold,
		ipAttemptPolicy.secondThreshold,
		ipAttemptPolicy.blockThreshold,
		ipAttemptPolicy.firstDelay.Milliseconds(),
		ipAttemptPolicy.secondDelay.Milliseconds(),
		ipAttemptPolicy.blockDuration.Milliseconds(),
	).Int64()
	if err != nil || result != 1 {
		return ErrUnavailable
	}
	return nil
}

func (limiter *attemptLimiter) attemptKey(scope, dimension string, digest []byte) string {
	return limiter.prefix + "attempt:" + scope + ":" + dimension + ":" + hex.EncodeToString(digest)
}

func (limiter *attemptLimiter) lockKey(scope, dimension string, digest []byte) string {
	return limiter.prefix + "attempt-lock:" + scope + ":" + dimension + ":" + hex.EncodeToString(digest)
}

func (limiter *attemptLimiter) reservationKey(scope, dimension, reservationID string) string {
	return limiter.prefix + "attempt-reservation:" + scope + ":" + dimension + ":" + reservationID
}

func boolArgument(value bool) string {
	if value {
		return "1"
	}
	return "0"
}

func validAttemptReservation(reservation attemptReservation) bool {
	if !validAttemptScope(reservation.Scope) || len(reservation.SourceIP) != sha256.Size ||
		(len(reservation.Subject) != 0 && len(reservation.Subject) != sha256.Size) {
		return false
	}
	parsed, err := uuid.Parse(reservation.ID)
	return err == nil && parsed != uuid.Nil
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
