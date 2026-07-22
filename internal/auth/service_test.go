package auth

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"reflect"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/bignormal/aera-admin/internal/audit"
	"github.com/bignormal/aera-admin/internal/rbac"
	"github.com/bignormal/aera-admin/internal/secure"
	"github.com/bignormal/aera-admin/internal/testkit"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/redis/go-redis/v9"
)

func TestLoginRequiresTOTPBeforeSessionAndRejectsReplay(t *testing.T) {
	fixture := newAuthFixture(t)
	ctx := context.Background()
	challenge, err := fixture.service.BeginLogin(ctx, fixture.email, fixture.password, fixture.meta("req-login-password"))
	if err != nil || challenge.ID == "" || !challenge.ExpiresAt.After(fixture.now) {
		t.Fatalf("BeginLogin() = %+v, %v", challenge, err)
	}
	var sessionCount int
	if err := fixture.postgres.QueryRow(ctx, `SELECT count(*) FROM admin_sessions`).Scan(&sessionCount); err != nil {
		t.Fatalf("count sessions before TOTP: %v", err)
	}
	if sessionCount != 0 {
		t.Fatalf("sessions before TOTP = %d, want 0", sessionCount)
	}

	result, err := fixture.service.CompleteLogin(ctx, CompleteLoginRequest{
		ChallengeID: challenge.ID,
		TOTPCode:    fixture.totp.Code(fixture.totpSecret, fixture.now),
		Meta:        fixture.meta("req-login-totp"),
	})
	if err != nil {
		t.Fatalf("CompleteLogin() error = %v", err)
	}
	if result.RawSessionToken == "" || result.CSRFToken == "" || result.Principal.AdminID != fixture.adminID.String() ||
		result.Principal.MFAMethod != MFAMethodTOTP || result.Principal.TOTPAuthenticatedAt == nil || !result.Principal.TOTPAuthenticatedAt.Equal(fixture.now) {
		t.Fatalf("CompleteLogin() = %+v", result)
	}
	if err := fixture.postgres.QueryRow(ctx, `SELECT count(*) FROM admin_sessions WHERE revoked_at IS NULL`).Scan(&sessionCount); err != nil {
		t.Fatalf("count sessions after TOTP: %v", err)
	}
	if sessionCount != 1 {
		t.Fatalf("live sessions after TOTP = %d, want 1", sessionCount)
	}
	if _, err := fixture.service.CompleteLogin(ctx, CompleteLoginRequest{
		ChallengeID: challenge.ID,
		TOTPCode:    fixture.totp.Code(fixture.totpSecret, fixture.now),
		Meta:        fixture.meta("req-login-replay"),
	}); !errors.Is(err, ErrInvalidCredentials) {
		t.Fatalf("replayed CompleteLogin() error = %v, want ErrInvalidCredentials", err)
	}
}

func TestSessionPolicyControlsCreationAndRefreshLifetimes(t *testing.T) {
	fixture := newAuthFixture(t)
	fixture.service.sessionPolicy = policyReaderStub{idle: 12 * time.Minute, absolute: 3 * time.Hour}
	login := fixture.login(t)

	var idleExpiresAt, absoluteExpiresAt time.Time
	if err := fixture.postgres.QueryRow(context.Background(), `
		SELECT idle_expires_at, absolute_expires_at FROM admin_sessions WHERE id = $1
	`, login.Principal.SessionID).Scan(&idleExpiresAt, &absoluteExpiresAt); err != nil {
		t.Fatal(err)
	}
	if !idleExpiresAt.Equal(fixture.now.Add(12*time.Minute)) || !absoluteExpiresAt.Equal(fixture.now.Add(3*time.Hour)) {
		t.Fatalf("policy expiries = %s/%s", idleExpiresAt, absoluteExpiresAt)
	}

	fixture.advance(6 * time.Minute)
	if _, err := fixture.service.Authenticate(context.Background(), login.RawSessionToken); err != nil {
		t.Fatalf("Authenticate() error = %v", err)
	}
	if err := fixture.postgres.QueryRow(context.Background(), `
		SELECT idle_expires_at FROM admin_sessions WHERE id = $1
	`, login.Principal.SessionID).Scan(&idleExpiresAt); err != nil {
		t.Fatal(err)
	}
	if !idleExpiresAt.Equal(fixture.now.Add(12 * time.Minute)) {
		t.Fatalf("refreshed idle expiry = %s, want %s", idleExpiresAt, fixture.now.Add(12*time.Minute))
	}
}

func TestSessionPolicyFailurePreventsCreationAndRefresh(t *testing.T) {
	t.Run("creation", func(t *testing.T) {
		fixture := newAuthFixture(t)
		challenge, err := fixture.service.BeginLogin(
			context.Background(), fixture.email, fixture.password, fixture.meta("req-policy-login"),
		)
		if err != nil {
			t.Fatal(err)
		}
		fixture.service.sessionPolicy = policyReaderStub{err: errors.New("policy unavailable")}
		_, err = fixture.service.CompleteLogin(context.Background(), CompleteLoginRequest{
			ChallengeID: challenge.ID, TOTPCode: fixture.totp.Code(fixture.totpSecret, fixture.now),
			Meta: fixture.meta("req-policy-totp"),
		})
		if !errors.Is(err, ErrUnavailable) {
			t.Fatalf("CompleteLogin() error = %v, want ErrUnavailable", err)
		}
		var count int
		if err := fixture.postgres.QueryRow(context.Background(), `SELECT count(*) FROM admin_sessions`).Scan(&count); err != nil || count != 0 {
			t.Fatalf("session count/error = %d/%v", count, err)
		}
	})

	t.Run("refresh", func(t *testing.T) {
		fixture := newAuthFixture(t)
		login := fixture.login(t)
		fixture.service.sessionPolicy = policyReaderStub{err: errors.New("policy unavailable")}
		if _, err := fixture.service.Authenticate(context.Background(), login.RawSessionToken); !errors.Is(err, ErrUnavailable) {
			t.Fatalf("Authenticate() error = %v, want ErrUnavailable", err)
		}
	})
}

func TestInvalidateLiveSessionsDeletesAuthOwnedRedisKeys(t *testing.T) {
	fixture := newAuthFixture(t)
	login := fixture.login(t)
	tokenHMAC, ok := fixture.service.tokens.sessionTokenHMAC(login.RawSessionToken)
	if !ok {
		t.Fatal("session token did not produce an HMAC")
	}
	key := liveSessionKey(fixture.prefix, tokenHMAC)
	if exists, err := fixture.redis.Exists(context.Background(), key).Result(); err != nil || exists != 1 {
		t.Fatalf("live-session key exists/error = %d/%v", exists, err)
	}
	if err := fixture.service.InvalidateLiveSessions(context.Background(), [][]byte{tokenHMAC}); err != nil {
		t.Fatalf("InvalidateLiveSessions() error = %v", err)
	}
	if exists, err := fixture.redis.Exists(context.Background(), key).Result(); err != nil || exists != 0 {
		t.Fatalf("live-session key after invalidation/error = %d/%v", exists, err)
	}
}

type policyReaderStub struct {
	idle     time.Duration
	absolute time.Duration
	err      error
}

func (reader policyReaderStub) SessionLifetimes(context.Context) (time.Duration, time.Duration, error) {
	if reader.err != nil {
		return 0, 0, reader.err
	}
	if reader.idle == 0 {
		return 30 * time.Minute, 8 * time.Hour, nil
	}
	return reader.idle, reader.absolute, nil
}

func TestBeginLoginUsesGenericErrorsWithoutAccountEnumeration(t *testing.T) {
	for name, test := range map[string]struct {
		mutate   func(*authFixture)
		email    string
		password string
	}{
		"unknown account": {email: "unknown@example.com", password: "correct horse battery staple"},
		"wrong password":  {email: "admin@example.com", password: "incorrect horse battery staple"},
		"suspended account": {
			mutate: func(fixture *authFixture) {
				if _, err := fixture.postgres.Exec(context.Background(), `UPDATE admin_users SET status = 'suspended' WHERE id = $1`, fixture.adminID); err != nil {
					t.Fatalf("suspend fixture administrator: %v", err)
				}
			},
			email: "admin@example.com", password: "correct horse battery staple",
		},
	} {
		t.Run(name, func(t *testing.T) {
			fixture := newAuthFixture(t)
			if test.mutate != nil {
				test.mutate(fixture)
			}
			if _, err := fixture.service.BeginLogin(context.Background(), test.email, test.password, fixture.meta("req-generic-error")); !errors.Is(err, ErrInvalidCredentials) {
				t.Fatalf("BeginLogin() error = %v, want ErrInvalidCredentials", err)
			}
		})
	}
}

func TestLoginRateLimitBlocksCorrectPasswordAfterProgressiveFailures(t *testing.T) {
	fixture := newAuthFixture(t)
	ctx := context.Background()
	var validations atomic.Int64
	fixture.service.beforePasswordValidation = func() { validations.Add(1) }
	for attempt := 1; attempt <= 2; attempt++ {
		if _, err := fixture.service.BeginLogin(ctx, fixture.email, "incorrect horse battery staple", fixture.meta("req-rate-fail")); !errors.Is(err, ErrInvalidCredentials) {
			t.Fatalf("BeginLogin() attempt %d error = %v, want ErrInvalidCredentials", attempt, err)
		}
	}
	_, err := fixture.service.BeginLogin(ctx, fixture.email, "incorrect horse battery staple", fixture.meta("req-rate-lock"))
	var limited *RateLimitError
	if !errors.As(err, &limited) || limited.RetryAfter <= 0 || limited.RetryAfter > 15*time.Minute {
		t.Fatalf("third BeginLogin() error = %#v, want bounded RateLimitError", err)
	}
	validations.Store(0)
	if _, err := fixture.service.BeginLogin(ctx, fixture.email, fixture.password, fixture.meta("req-rate-correct")); !errors.Is(err, ErrRateLimited) {
		t.Fatalf("rate-limited correct BeginLogin() error = %v, want ErrRateLimited", err)
	}
	if got := validations.Load(); got != 0 {
		t.Fatalf("password validations behind pre-existing lock = %d, want 0", got)
	}
}

func TestConcurrentPasswordAttemptsCannotPassAdmissionBeyondPolicy(t *testing.T) {
	fixture := newAuthFixture(t)
	const workers = 20
	entered := make(chan struct{}, workers)
	release := make(chan struct{})
	fixture.service.beforePasswordValidation = func() {
		entered <- struct{}{}
		<-release
	}

	start := make(chan struct{})
	results := make(chan error, workers)
	var wait sync.WaitGroup
	for worker := 0; worker < workers; worker++ {
		wait.Add(1)
		go func(worker int) {
			defer wait.Done()
			<-start
			_, err := fixture.service.BeginLogin(
				context.Background(),
				fixture.email,
				"incorrect horse battery staple",
				fixture.meta(fmt.Sprintf("req-concurrent-password-%02d", worker)),
			)
			results <- err
		}(worker)
	}
	close(start)
	for enteredCount := 0; enteredCount < int(accountAttemptPolicy.firstThreshold); enteredCount++ {
		select {
		case <-entered:
		case <-time.After(3 * time.Second):
			close(release)
			t.Fatal("password attempts did not reach the admission threshold")
		}
	}
	select {
	case <-entered:
		close(release)
		t.Fatal("password validation exceeded the atomic admission threshold")
	case <-time.After(100 * time.Millisecond):
	}
	close(release)
	wait.Wait()
	close(results)
	for err := range results {
		if !errors.Is(err, ErrInvalidCredentials) && !errors.Is(err, ErrRateLimited) {
			t.Fatalf("BeginLogin() error = %v", err)
		}
	}
}

func TestConcurrentTOTPAttemptsCannotPassAdmissionBeyondPolicy(t *testing.T) {
	fixture := newAuthFixture(t)
	challenge, err := fixture.service.BeginLogin(context.Background(), fixture.email, fixture.password, fixture.meta("req-concurrent-totp-password"))
	if err != nil {
		t.Fatalf("BeginLogin() error = %v", err)
	}
	const workers = 20
	entered := make(chan struct{}, workers)
	release := make(chan struct{})
	var validationCount atomic.Int64
	fixture.service.beforeTOTPValidation = func() {
		validationCount.Add(1)
		entered <- struct{}{}
		<-release
	}
	wrongCode := "000000"
	if wrongCode == fixture.totp.Code(fixture.totpSecret, fixture.now) {
		wrongCode = "111111"
	}

	start := make(chan struct{})
	results := make(chan error, workers)
	var wait sync.WaitGroup
	for worker := 0; worker < workers; worker++ {
		wait.Add(1)
		go func(worker int) {
			defer wait.Done()
			<-start
			_, completeErr := fixture.service.CompleteLogin(context.Background(), CompleteLoginRequest{
				ChallengeID: challenge.ID, TOTPCode: wrongCode,
				Meta: fixture.meta(fmt.Sprintf("req-concurrent-totp-%02d", worker)),
			})
			results <- completeErr
		}(worker)
	}
	close(start)
	for enteredCount := 0; enteredCount < int(accountAttemptPolicy.firstThreshold); enteredCount++ {
		select {
		case <-entered:
		case <-time.After(3 * time.Second):
			close(release)
			t.Fatal("TOTP attempts did not reach the admission threshold")
		}
	}
	select {
	case <-entered:
		close(release)
		t.Fatal("TOTP validation exceeded the atomic admission threshold")
	case <-time.After(100 * time.Millisecond):
	}
	close(release)
	wait.Wait()
	close(results)
	for err := range results {
		if !errors.Is(err, ErrInvalidCredentials) && !errors.Is(err, ErrRateLimited) {
			t.Fatalf("CompleteLogin() error = %v", err)
		}
	}
	if got := validationCount.Load(); got != accountAttemptPolicy.firstThreshold {
		t.Fatalf("TOTP validations = %d, want %d", got, accountAttemptPolicy.firstThreshold)
	}
}

func TestPasswordSuccessDoesNotResetMFAFailureCounter(t *testing.T) {
	fixture := newAuthFixture(t)
	ctx := context.Background()
	wrongCode := "000000"
	if wrongCode == fixture.totp.Code(fixture.totpSecret, fixture.now) {
		wrongCode = "111111"
	}

	for attempt := 1; attempt <= 3; attempt++ {
		challenge, err := fixture.service.BeginLogin(ctx, fixture.email, fixture.password, fixture.meta("req-mfa-rate-password"))
		if err != nil {
			t.Fatalf("BeginLogin() attempt %d error = %v", attempt, err)
		}
		_, err = fixture.service.CompleteLogin(ctx, CompleteLoginRequest{
			ChallengeID: challenge.ID,
			TOTPCode:    wrongCode,
			Meta:        fixture.meta("req-mfa-rate-totp"),
		})
		if attempt < 3 && !errors.Is(err, ErrInvalidCredentials) {
			t.Fatalf("CompleteLogin() attempt %d error = %v, want ErrInvalidCredentials", attempt, err)
		}
		if attempt == 3 {
			var limited *RateLimitError
			if !errors.As(err, &limited) || limited.RetryAfter <= 0 {
				t.Fatalf("CompleteLogin() attempt %d error = %#v, want RateLimitError", attempt, err)
			}
		}
	}
}

func TestSessionAuthenticationRequiresRedisAndPostgreSQLState(t *testing.T) {
	fixture := newAuthFixture(t)
	login := fixture.login(t)
	ctx := context.Background()
	authenticated, err := fixture.service.Authenticate(ctx, login.RawSessionToken)
	if err != nil {
		t.Fatalf("Authenticate() error = %v", err)
	}
	if !reflect.DeepEqual(authenticated.Principal, login.Principal) || authenticated.CSRFToken != login.CSRFToken {
		t.Fatalf("Authenticate() = %+v, login = %+v", authenticated, login)
	}
	tokenHMAC, ok := fixture.service.tokens.sessionTokenHMAC(login.RawSessionToken)
	if !ok {
		t.Fatal("sessionTokenHMAC() rejected issued token")
	}
	var storedTokenHMAC, storedCSRFHMAC []byte
	if err := fixture.postgres.QueryRow(ctx, `
		SELECT token_hmac, csrf_hmac FROM admin_sessions WHERE id = $1
	`, login.Principal.SessionID).Scan(&storedTokenHMAC, &storedCSRFHMAC); err != nil {
		t.Fatalf("read stored session digests: %v", err)
	}
	if !bytes.Equal(storedTokenHMAC, tokenHMAC) || bytes.Contains(storedTokenHMAC, []byte(login.RawSessionToken)) || bytes.Contains(storedCSRFHMAC, []byte(login.CSRFToken)) {
		t.Fatal("session storage retained raw session or CSRF material")
	}
	if err := fixture.redis.Del(ctx, liveSessionKey(fixture.prefix, tokenHMAC)).Err(); err != nil {
		t.Fatalf("delete Redis live session: %v", err)
	}
	if _, err := fixture.service.Authenticate(ctx, login.RawSessionToken); !errors.Is(err, ErrInvalidSession) {
		t.Fatalf("Authenticate() without Redis live state error = %v, want ErrInvalidSession", err)
	}
}

func TestSessionAuthenticationRevokesStaleSecurityVersionAndBoundsLastSeenWrites(t *testing.T) {
	fixture := newAuthFixture(t)
	login := fixture.login(t)
	ctx := context.Background()
	fixture.advance(time.Minute)
	if _, err := fixture.service.Authenticate(ctx, login.RawSessionToken); err != nil {
		t.Fatalf("Authenticate() at one minute error = %v", err)
	}
	var lastSeen time.Time
	if err := fixture.postgres.QueryRow(ctx, `SELECT last_seen_at FROM admin_sessions WHERE id = $1`, login.Principal.SessionID).Scan(&lastSeen); err != nil {
		t.Fatalf("read bounded last_seen_at: %v", err)
	}
	if !lastSeen.Equal(login.Principal.MFAAuthenticatedAt) {
		t.Fatalf("last_seen_at changed too early: %s", lastSeen)
	}
	fixture.advance(5 * time.Minute)
	if _, err := fixture.service.Authenticate(ctx, login.RawSessionToken); err != nil {
		t.Fatalf("Authenticate() at six minutes error = %v", err)
	}
	if err := fixture.postgres.QueryRow(ctx, `SELECT last_seen_at FROM admin_sessions WHERE id = $1`, login.Principal.SessionID).Scan(&lastSeen); err != nil {
		t.Fatalf("read refreshed last_seen_at: %v", err)
	}
	if !lastSeen.Equal(fixture.now) {
		t.Fatalf("refreshed last_seen_at = %s, want %s", lastSeen, fixture.now)
	}
	if _, err := fixture.postgres.Exec(ctx, `UPDATE admin_users SET security_version = security_version + 1 WHERE id = $1`, fixture.adminID); err != nil {
		t.Fatalf("advance administrator security version: %v", err)
	}
	if _, err := fixture.service.Authenticate(ctx, login.RawSessionToken); !errors.Is(err, ErrInvalidSession) {
		t.Fatalf("Authenticate() with stale security version error = %v, want ErrInvalidSession", err)
	}
	var revokedAt *time.Time
	if err := fixture.postgres.QueryRow(ctx, `SELECT revoked_at FROM admin_sessions WHERE id = $1`, login.Principal.SessionID).Scan(&revokedAt); err != nil {
		t.Fatalf("read stale session revocation: %v", err)
	}
	if revokedAt == nil {
		t.Fatal("stale security-version session was not revoked")
	}
}

func TestSessionAuthenticationRefreshesRedisIdleTTLOnEveryRequest(t *testing.T) {
	fixture := newAuthFixture(t)
	login := fixture.login(t)
	ctx := context.Background()
	tokenHMAC, ok := fixture.service.tokens.sessionTokenHMAC(login.RawSessionToken)
	if !ok {
		t.Fatal("sessionTokenHMAC() rejected issued token")
	}
	liveKey := liveSessionKey(fixture.prefix, tokenHMAC)
	if err := fixture.redis.Expire(ctx, liveKey, 2*time.Second).Err(); err != nil {
		t.Fatalf("shorten Redis live-session TTL: %v", err)
	}

	fixture.advance(time.Minute)
	if _, err := fixture.service.Authenticate(ctx, login.RawSessionToken); err != nil {
		t.Fatalf("Authenticate() inside database write interval error = %v", err)
	}
	remaining, err := fixture.redis.PTTL(ctx, liveKey).Result()
	if err != nil {
		t.Fatalf("read refreshed Redis TTL: %v", err)
	}
	if remaining < 29*time.Minute || remaining > sessionIdleLifetime {
		t.Fatalf("refreshed Redis TTL = %s, want approximately %s", remaining, sessionIdleLifetime)
	}
	var lastSeen time.Time
	if err := fixture.postgres.QueryRow(ctx, `SELECT last_seen_at FROM admin_sessions WHERE id = $1`, login.Principal.SessionID).Scan(&lastSeen); err != nil {
		t.Fatalf("read bounded last_seen_at: %v", err)
	}
	if !lastSeen.Equal(login.Principal.MFAAuthenticatedAt) {
		t.Fatalf("last_seen_at changed inside write interval: %s", lastSeen)
	}
}

func TestBoundedLastSeenWritesDoNotShortenActiveSessionIdleLifetime(t *testing.T) {
	fixture := newAuthFixture(t)
	login := fixture.login(t)
	ctx := context.Background()

	fixture.advance(4 * time.Minute)
	if _, err := fixture.service.Authenticate(ctx, login.RawSessionToken); err != nil {
		t.Fatalf("Authenticate() at four minutes error = %v", err)
	}
	fixture.advance(27 * time.Minute)
	if _, err := fixture.service.Authenticate(ctx, login.RawSessionToken); err != nil {
		t.Fatalf("Authenticate() after 27 idle minutes error = %v", err)
	}
}

func TestRecoveryCodeLoginIsOneTimeAndRevokesOlderSessions(t *testing.T) {
	fixture := newAuthFixture(t)
	older := fixture.login(t)
	fixture.advance(30 * time.Second)
	challenge, err := fixture.service.BeginLogin(context.Background(), fixture.email, fixture.password, fixture.meta("req-recovery-password"))
	if err != nil {
		t.Fatalf("BeginLogin(recovery) error = %v", err)
	}
	recovered, err := fixture.service.CompleteLogin(context.Background(), CompleteLoginRequest{
		ChallengeID: challenge.ID, RecoveryCode: fixture.recoveryCode, Meta: fixture.meta("req-recovery-code"),
	})
	if err != nil {
		t.Fatalf("CompleteLogin(recovery) error = %v", err)
	}
	if recovered.Principal.MFAMethod != MFAMethodRecovery || recovered.Principal.TOTPAuthenticatedAt != nil || recovered.RawSessionToken == "" {
		t.Fatalf("recovery login = %+v", recovered)
	}
	var olderRevokedAt *time.Time
	if err := fixture.postgres.QueryRow(context.Background(), `SELECT revoked_at FROM admin_sessions WHERE id = $1`, older.Principal.SessionID).Scan(&olderRevokedAt); err != nil {
		t.Fatalf("read older session revocation: %v", err)
	}
	if olderRevokedAt == nil {
		t.Fatal("recovery login did not revoke the older session")
	}
	if _, err := fixture.service.Authenticate(context.Background(), older.RawSessionToken); !errors.Is(err, ErrInvalidSession) {
		t.Fatalf("Authenticate(older) error = %v, want ErrInvalidSession", err)
	}
	replayChallenge, err := fixture.service.BeginLogin(context.Background(), fixture.email, fixture.password, fixture.meta("req-recovery-replay-password"))
	if err != nil {
		t.Fatalf("BeginLogin(replay) error = %v", err)
	}
	if _, err := fixture.service.CompleteLogin(context.Background(), CompleteLoginRequest{
		ChallengeID: replayChallenge.ID, RecoveryCode: fixture.recoveryCode, Meta: fixture.meta("req-recovery-replay"),
	}); !errors.Is(err, ErrInvalidCredentials) {
		t.Fatalf("replayed recovery CompleteLogin() error = %v, want ErrInvalidCredentials", err)
	}
}

func TestStepUpRequiresFreshNonReplayedTOTPWithoutExtendingSession(t *testing.T) {
	fixture := newAuthFixture(t)
	fixture.login(t)
	fixture.advance(30 * time.Second)
	challenge, err := fixture.service.BeginLogin(context.Background(), fixture.email, fixture.password, fixture.meta("req-stepup-recovery-password"))
	if err != nil {
		t.Fatalf("BeginLogin(recovery) error = %v", err)
	}
	recovered, err := fixture.service.CompleteLogin(context.Background(), CompleteLoginRequest{
		ChallengeID: challenge.ID, RecoveryCode: fixture.recoveryCode, Meta: fixture.meta("req-stepup-recovery"),
	})
	if err != nil {
		t.Fatalf("CompleteLogin(recovery) error = %v", err)
	}
	establishedAt := recovered.Principal.MFAAuthenticatedAt
	fixture.advance(30 * time.Second)
	if _, err := fixture.service.Authenticate(context.Background(), recovered.RawSessionToken); err != nil {
		t.Fatalf("Authenticate() before step-up error = %v", err)
	}
	var idleBefore, absoluteBefore time.Time
	if err := fixture.postgres.QueryRow(context.Background(), `
		SELECT idle_expires_at, absolute_expires_at FROM admin_sessions WHERE id = $1
	`, recovered.Principal.SessionID).Scan(&idleBefore, &absoluteBefore); err != nil {
		t.Fatalf("read session expiry before step-up: %v", err)
	}
	code := fixture.totp.Code(fixture.totpSecret, fixture.now)
	steppedUp, err := fixture.service.StepUp(context.Background(), recovered.RawSessionToken, code, fixture.meta("req-stepup"))
	if err != nil {
		t.Fatalf("StepUp() error = %v", err)
	}
	if steppedUp.Principal.MFAMethod != MFAMethodRecovery || !steppedUp.Principal.MFAAuthenticatedAt.Equal(establishedAt) ||
		steppedUp.Principal.TOTPAuthenticatedAt == nil || !steppedUp.Principal.TOTPAuthenticatedAt.Equal(fixture.now) {
		t.Fatalf("StepUp() = %+v", steppedUp)
	}
	var storedMethod MFAMethod
	var storedMFAAt time.Time
	var storedTOTPAt *time.Time
	if err := fixture.postgres.QueryRow(context.Background(), `
		SELECT mfa_method, mfa_authenticated_at, totp_authenticated_at
		FROM admin_sessions
		WHERE id = $1
	`, recovered.Principal.SessionID).Scan(&storedMethod, &storedMFAAt, &storedTOTPAt); err != nil {
		t.Fatalf("read session MFA provenance after step-up: %v", err)
	}
	if storedMethod != MFAMethodRecovery || !storedMFAAt.Equal(establishedAt) || storedTOTPAt == nil || !storedTOTPAt.Equal(fixture.now) {
		t.Fatalf("stored MFA provenance = method:%q mfa:%s totp:%v", storedMethod, storedMFAAt, storedTOTPAt)
	}
	var idleAfter, absoluteAfter time.Time
	if err := fixture.postgres.QueryRow(context.Background(), `
		SELECT idle_expires_at, absolute_expires_at FROM admin_sessions WHERE id = $1
	`, recovered.Principal.SessionID).Scan(&idleAfter, &absoluteAfter); err != nil {
		t.Fatalf("read session expiry after step-up: %v", err)
	}
	if !idleAfter.Equal(idleBefore) || !absoluteAfter.Equal(absoluteBefore) {
		t.Fatalf("step-up extended session: idle %s -> %s, absolute %s -> %s", idleBefore, idleAfter, absoluteBefore, absoluteAfter)
	}
	if _, err := fixture.service.StepUp(context.Background(), recovered.RawSessionToken, code, fixture.meta("req-stepup-replay")); !errors.Is(err, ErrInvalidCredentials) {
		t.Fatalf("replayed StepUp() error = %v, want ErrInvalidCredentials", err)
	}
}

func TestStepUpLockRejectsCorrectTOTPBeforeValidation(t *testing.T) {
	fixture := newAuthFixture(t)
	fixture.login(t)
	fixture.advance(30 * time.Second)
	challenge, err := fixture.service.BeginLogin(context.Background(), fixture.email, fixture.password, fixture.meta("req-stepup-lock-recovery-password"))
	if err != nil {
		t.Fatalf("BeginLogin(recovery) error = %v", err)
	}
	recovered, err := fixture.service.CompleteLogin(context.Background(), CompleteLoginRequest{
		ChallengeID: challenge.ID, RecoveryCode: fixture.recoveryCode, Meta: fixture.meta("req-stepup-lock-recovery"),
	})
	if err != nil {
		t.Fatalf("CompleteLogin(recovery) error = %v", err)
	}
	wrongCode := "000000"
	if wrongCode == fixture.totp.Code(fixture.totpSecret, fixture.now) {
		wrongCode = "111111"
	}
	for attempt := 1; attempt <= int(accountAttemptPolicy.firstThreshold); attempt++ {
		_, err := fixture.service.StepUp(context.Background(), recovered.RawSessionToken, wrongCode, fixture.meta("req-stepup-lock-wrong"))
		if attempt < int(accountAttemptPolicy.firstThreshold) && !errors.Is(err, ErrInvalidCredentials) {
			t.Fatalf("StepUp(wrong) attempt %d error = %v, want ErrInvalidCredentials", attempt, err)
		}
		if attempt == int(accountAttemptPolicy.firstThreshold) && !errors.Is(err, ErrRateLimited) {
			t.Fatalf("StepUp(wrong) attempt %d error = %v, want ErrRateLimited", attempt, err)
		}
	}

	var validations atomic.Int64
	fixture.service.beforeTOTPValidation = func() { validations.Add(1) }
	correctCode := fixture.totp.Code(fixture.totpSecret, fixture.now)
	if _, err := fixture.service.StepUp(context.Background(), recovered.RawSessionToken, correctCode, fixture.meta("req-stepup-lock-correct")); !errors.Is(err, ErrRateLimited) {
		t.Fatalf("StepUp(correct while locked) error = %v, want ErrRateLimited", err)
	}
	if got := validations.Load(); got != 0 {
		t.Fatalf("TOTP validations behind pre-existing step-up lock = %d, want 0", got)
	}
	var method MFAMethod
	var totpAuthenticatedAt *time.Time
	if err := fixture.postgres.QueryRow(context.Background(), `
		SELECT mfa_method, totp_authenticated_at
		FROM admin_sessions
		WHERE id = $1
	`, recovered.Principal.SessionID).Scan(&method, &totpAuthenticatedAt); err != nil {
		t.Fatalf("read blocked step-up session: %v", err)
	}
	if method != MFAMethodRecovery || totpAuthenticatedAt != nil {
		t.Fatalf("blocked correct TOTP changed MFA state to method:%q totp:%v", method, totpAuthenticatedAt)
	}
}

func TestRedisLiveSessionWriteFailureRevokesCommittedPostgreSQLSession(t *testing.T) {
	fixture := newAuthFixture(t)
	challenge, err := fixture.service.BeginLogin(context.Background(), fixture.email, fixture.password, fixture.meta("req-redis-failure-password"))
	if err != nil {
		t.Fatalf("BeginLogin() error = %v", err)
	}
	fixture.service.liveSessionWriter = func(context.Context, []byte, uuid.UUID, time.Duration) error {
		return ErrUnavailable
	}
	if _, err := fixture.service.CompleteLogin(context.Background(), CompleteLoginRequest{
		ChallengeID: challenge.ID,
		TOTPCode:    fixture.totp.Code(fixture.totpSecret, fixture.now),
		Meta:        fixture.meta("req-redis-failure-totp"),
	}); !errors.Is(err, ErrUnavailable) {
		t.Fatalf("CompleteLogin() error = %v, want ErrUnavailable", err)
	}
	var sessions, revoked int
	if err := fixture.postgres.QueryRow(context.Background(), `
		SELECT count(*), count(*) FILTER (WHERE revoked_at IS NOT NULL)
		FROM admin_sessions
	`).Scan(&sessions, &revoked); err != nil {
		t.Fatalf("read failed session creation state: %v", err)
	}
	if sessions != 1 || revoked != 1 {
		t.Fatalf("failed session creation state = sessions:%d revoked:%d", sessions, revoked)
	}
}

func TestSessionIdleAndAbsoluteExpiryFailClosed(t *testing.T) {
	t.Run("idle", func(t *testing.T) {
		fixture := newAuthFixture(t)
		login := fixture.login(t)
		fixture.advance(30 * time.Minute)
		if _, err := fixture.service.Authenticate(context.Background(), login.RawSessionToken); !errors.Is(err, ErrInvalidSession) {
			t.Fatalf("Authenticate() at idle expiry error = %v, want ErrInvalidSession", err)
		}
	})
	t.Run("absolute", func(t *testing.T) {
		fixture := newAuthFixture(t)
		login := fixture.login(t)
		for interval := 0; interval < 19; interval++ {
			fixture.advance(25 * time.Minute)
			if _, err := fixture.service.Authenticate(context.Background(), login.RawSessionToken); err != nil {
				t.Fatalf("Authenticate() before absolute expiry interval %d error = %v", interval, err)
			}
		}
		fixture.advance(5 * time.Minute)
		if _, err := fixture.service.Authenticate(context.Background(), login.RawSessionToken); !errors.Is(err, ErrInvalidSession) {
			t.Fatalf("Authenticate() at absolute expiry error = %v, want ErrInvalidSession", err)
		}
	})
}

func TestConcurrentSessionRefreshDoesNotClearAValidSession(t *testing.T) {
	fixture := newAuthFixture(t)
	login := fixture.login(t)
	fixture.advance(6 * time.Minute)
	const workers = 8
	results := make(chan error, workers)
	for worker := 0; worker < workers; worker++ {
		go func() {
			_, err := fixture.service.Authenticate(context.Background(), login.RawSessionToken)
			results <- err
		}()
	}
	for worker := 0; worker < workers; worker++ {
		if err := <-results; err != nil {
			t.Errorf("concurrent Authenticate() error = %v", err)
		}
	}
	if _, err := fixture.service.Authenticate(context.Background(), login.RawSessionToken); err != nil {
		t.Fatalf("Authenticate() after concurrent refresh error = %v", err)
	}
}

type authFixture struct {
	postgres     *pgxpool.Pool
	redis        *redis.Client
	prefix       string
	service      *Service
	adminID      uuid.UUID
	email        string
	password     string
	totpSecret   []byte
	recoveryCode string
	totp         secure.TOTP
	now          time.Time
	clockNow     *time.Time
}

func newAuthFixture(t *testing.T) *authFixture {
	t.Helper()
	postgres := testkit.Postgres(t)
	redisClient, prefix := testkit.Redis(t)
	passwords, err := secure.NewPasswordHasher(secure.PasswordHasherConfig{
		CurrentVersion: 1,
		Versions: map[int]secure.Argon2Params{
			1: {MemoryKiB: 64, Iterations: 1, Parallelism: 1, SaltLength: 16, KeyLength: 32},
		},
	})
	if err != nil {
		t.Fatalf("NewPasswordHasher() error = %v", err)
	}
	identities, err := secure.NewIdentityCodec(secure.IdentityCodecConfig{
		ActiveEncryptionKeyID: "identity-v1",
		EncryptionKeys:        map[string][]byte{"identity-v1": bytes.Repeat([]byte{1}, 32)},
		ActiveLookupKeyID:     "lookup-v1",
		LookupKeys:            map[string][]byte{"lookup-v1": bytes.Repeat([]byte{2}, 32)},
	})
	if err != nil {
		t.Fatalf("NewIdentityCodec() error = %v", err)
	}
	secrets, err := secure.NewSecretCodec(secure.SecretCodecConfig{
		ActiveKeyID: "totp-v1", Keys: map[string][]byte{"totp-v1": bytes.Repeat([]byte{3}, 32)},
	})
	if err != nil {
		t.Fatalf("NewSecretCodec() error = %v", err)
	}
	auditService, err := audit.NewService(postgres)
	if err != nil {
		t.Fatalf("audit.NewService() error = %v", err)
	}
	now := time.Date(2026, 7, 21, 16, 0, 0, 0, time.UTC)
	clockNow := now
	totp := secure.DefaultTOTP()
	service, err := NewService(ServiceConfig{
		PostgreSQL: postgres, Redis: redisClient, RedisPrefix: prefix,
		Passwords: passwords, Identities: identities, TOTPSecrets: secrets, TOTP: totp, Audit: auditService,
		SessionHMACKey: bytes.Repeat([]byte{4}, 32), CSRFHMACKey: bytes.Repeat([]byte{5}, 32),
		SessionPolicy: policyReaderStub{}, Clock: func() time.Time { return clockNow },
	})
	if err != nil {
		t.Fatalf("NewService() error = %v", err)
	}
	recoveryCode, _, err := secure.NewOpaqueToken(32)
	if err != nil {
		t.Fatalf("NewOpaqueToken(recovery) error = %v", err)
	}
	fixture := &authFixture{
		postgres: postgres, redis: redisClient, prefix: prefix, service: service,
		adminID: uuid.New(), email: "admin@example.com", password: "correct horse battery staple",
		totpSecret: bytes.Repeat([]byte{7}, 20), recoveryCode: recoveryCode,
		totp: totp, now: now, clockNow: &clockNow,
	}
	fixture.seedAdministrator(t, passwords, identities, secrets)
	return fixture
}

func (fixture *authFixture) seedAdministrator(
	t *testing.T,
	passwords *secure.PasswordHasher,
	identities *secure.IdentityCodec,
	secrets *secure.SecretCodec,
) {
	t.Helper()
	identity, err := identities.SealEmail(fixture.email)
	if err != nil {
		t.Fatalf("SealEmail() error = %v", err)
	}
	passwordHash, passwordVersion, err := passwords.Hash(fixture.password)
	if err != nil {
		t.Fatalf("Hash() error = %v", err)
	}
	sealedTOTP, err := secrets.Seal(fixture.totpSecret)
	if err != nil {
		t.Fatalf("Seal(TOTP) error = %v", err)
	}
	ctx := context.Background()
	tx, err := fixture.postgres.Begin(ctx)
	if err != nil {
		t.Fatalf("begin administrator seed: %v", err)
	}
	defer func() { _ = tx.Rollback(context.Background()) }()
	if _, err := tx.Exec(ctx, `
		INSERT INTO admin_users (id, display_name, role, status, security_version, created_at, updated_at)
		VALUES ($1, '内部管理员', $2, 'active', 1, $3, $3)
	`, fixture.adminID, rbac.SuperAdmin, fixture.now.Add(-time.Hour)); err != nil {
		t.Fatalf("seed administrator user: %v", err)
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO admin_identities (admin_user_id, encryption_key_id, nonce, ciphertext, lookup_key_id, lookup_hmac)
		VALUES ($1, $2, $3, $4, $5, $6)
	`, fixture.adminID, identity.EncryptionKeyID, identity.Nonce, identity.Ciphertext, identity.LookupKeyID, identity.LookupHMAC); err != nil {
		t.Fatalf("seed administrator identity: %v", err)
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO admin_password_credentials (admin_user_id, password_hash, params_version, changed_at)
		VALUES ($1, $2, $3, $4)
	`, fixture.adminID, passwordHash, passwordVersion, fixture.now.Add(-time.Hour)); err != nil {
		t.Fatalf("seed administrator password: %v", err)
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO admin_totp_credentials (admin_user_id, encryption_key_id, nonce, ciphertext, last_accepted_step, bound_at, updated_at)
		VALUES ($1, $2, $3, $4, -1, $5, $5)
	`, fixture.adminID, sealedTOTP.KeyID, sealedTOTP.Nonce, sealedTOTP.Ciphertext, fixture.now.Add(-time.Hour)); err != nil {
		t.Fatalf("seed administrator TOTP: %v", err)
	}
	recoveryDigest := secure.DigestOpaqueToken(fixture.recoveryCode)
	if _, err := tx.Exec(ctx, `
		INSERT INTO admin_recovery_codes (admin_user_id, code_hmac, created_at)
		VALUES ($1, $2, $3)
	`, fixture.adminID, recoveryDigest[:], fixture.now.Add(-time.Hour)); err != nil {
		t.Fatalf("seed administrator recovery code: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit administrator seed: %v", err)
	}
}

func (fixture *authFixture) meta(requestID string) RequestMeta {
	return RequestMeta{
		RequestID: requestID, SourceIPHMAC: bytes.Repeat([]byte{9}, 32), UserAgent: "AdminBrowser/1.0",
	}
}

func (fixture *authFixture) advance(duration time.Duration) {
	fixture.now = fixture.now.Add(duration)
	*fixture.clockNow = fixture.now
}

func (fixture *authFixture) login(t *testing.T) LoginResult {
	t.Helper()
	challenge, err := fixture.service.BeginLogin(context.Background(), fixture.email, fixture.password, fixture.meta("req-fixture-password"))
	if err != nil {
		t.Fatalf("fixture BeginLogin() error = %v", err)
	}
	result, err := fixture.service.CompleteLogin(context.Background(), CompleteLoginRequest{
		ChallengeID: challenge.ID,
		TOTPCode:    fixture.totp.Code(fixture.totpSecret, fixture.now),
		Meta:        fixture.meta("req-fixture-totp"),
	})
	if err != nil {
		t.Fatalf("fixture CompleteLogin() error = %v", err)
	}
	return result
}
