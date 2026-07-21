package auth

import (
	"context"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"errors"
	"net/http"
	"regexp"
	"strings"
	"time"

	"github.com/bignormal/aera-admin/internal/audit"
	"github.com/bignormal/aera-admin/internal/secure"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/redis/go-redis/v9"
)

const sessionLastSeenWriteInterval = 5 * time.Minute

var authenticationRequestIDPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$`)

type ServiceConfig struct {
	PostgreSQL     *pgxpool.Pool
	Redis          *redis.Client
	RedisPrefix    string
	Passwords      *secure.PasswordHasher
	Identities     *secure.IdentityCodec
	TOTPSecrets    *secure.SecretCodec
	TOTP           secure.TOTP
	Audit          *audit.Service
	SessionHMACKey []byte
	CSRFHMACKey    []byte
	Clock          func() time.Time
}

type Service struct {
	repository        *repository
	redis             *redis.Client
	redisPrefix       string
	passwords         *secure.PasswordHasher
	identities        *secure.IdentityCodec
	totpSecrets       *secure.SecretCodec
	totp              secure.TOTP
	audit             *audit.Service
	tokens            *tokenCodec
	limiter           *attemptLimiter
	liveSessionWriter func(context.Context, []byte, uuid.UUID, time.Duration) error
	dummyPasswordHash string
	clock             func() time.Time
}

func NewService(config ServiceConfig) (*Service, error) {
	if config.PostgreSQL == nil || config.Redis == nil || config.Passwords == nil || config.Identities == nil ||
		config.TOTPSecrets == nil || config.Audit == nil || !validRedisPrefix(config.RedisPrefix) {
		return nil, errors.New("authentication service dependencies are required")
	}
	tokens, err := newTokenCodec(config.SessionHMACKey, config.CSRFHMACKey)
	if err != nil {
		return nil, err
	}
	probe, err := config.TOTP.Generate()
	if err != nil {
		return nil, errors.New("authentication TOTP configuration is invalid")
	}
	clear(probe)
	dummyPasswordHash, _, err := config.Passwords.Hash("invalid-login-password")
	if err != nil {
		return nil, errors.New("authentication password hashing is unavailable")
	}
	clock := config.Clock
	if clock == nil {
		clock = time.Now
	}
	service := &Service{
		repository: &repository{postgres: config.PostgreSQL}, redis: config.Redis, redisPrefix: config.RedisPrefix,
		passwords: config.Passwords, identities: config.Identities, totpSecrets: config.TOTPSecrets,
		totp: config.TOTP, audit: config.Audit, tokens: tokens,
		limiter:           &attemptLimiter{client: config.Redis, prefix: config.RedisPrefix},
		dummyPasswordHash: dummyPasswordHash, clock: clock,
	}
	service.liveSessionWriter = func(ctx context.Context, tokenHMAC []byte, sessionID uuid.UUID, ttl time.Duration) error {
		return putLiveSession(ctx, service.redis, service.redisPrefix, tokenHMAC, sessionID, ttl)
	}
	return service, nil
}

func (service *Service) BeginLogin(ctx context.Context, email, password string, meta RequestMeta) (LoginChallenge, error) {
	if service == nil || !validRequestMeta(meta) {
		return LoginChallenge{}, ErrInvalidRequest
	}
	candidates := service.identities.LookupCandidates(email)
	var accountKey []byte
	if len(candidates) > 0 {
		accountKey = append([]byte(nil), candidates[0].HMAC...)
	}
	retryAfter, err := service.limiter.check(ctx, "login", accountKey, meta.SourceIPHMAC)
	if err != nil {
		return LoginChallenge{}, err
	}
	if retryAfter > 0 {
		return LoginChallenge{}, &RateLimitError{RetryAfter: retryAfter}
	}
	administrator, found, err := findLoginAdministratorByLookup(ctx, service.repository.postgres, candidates)
	if err != nil {
		return LoginChallenge{}, err
	}
	hash := service.dummyPasswordHash
	if found {
		hash = administrator.PasswordHash
	}
	passwordOK, _, verifyErr := service.passwords.Verify(password, hash)
	if verifyErr != nil {
		return LoginChallenge{}, ErrUnavailable
	}
	if len(candidates) == 0 || !found || !passwordOK || administrator.Status != "active" ||
		!administrator.Role.Valid() || administrator.SecurityVersion <= 0 || administrator.TOTPSecret.KeyID == "" {
		return LoginChallenge{}, service.loginFailure(ctx, cloneUUIDIfSet(administrator.ID), accountKey, meta)
	}
	rawChallenge, _, err := secure.NewOpaqueToken(32)
	if err != nil {
		return LoginChallenge{}, ErrUnavailable
	}
	now := service.now()
	expiresAt := now.Add(loginChallengeLifetime)
	if err := putChallenge(ctx, service.redis, service.redisPrefix, rawChallenge, service.tokens, challengeState{
		AdministratorID: administrator.ID.String(), AccountKey: accountKey,
		SourceIPHMAC: append([]byte(nil), meta.SourceIPHMAC...), ExpiresAt: expiresAt,
	}, loginChallengeLifetime); err != nil {
		return LoginChallenge{}, err
	}
	return LoginChallenge{ID: rawChallenge, ExpiresAt: expiresAt}, nil
}

func (service *Service) CompleteLogin(ctx context.Context, request CompleteLoginRequest) (LoginResult, error) {
	if service == nil || !validRequestMeta(request.Meta) ||
		(request.TOTPCode == "") == (request.RecoveryCode == "") {
		return LoginResult{}, ErrInvalidRequest
	}
	retryAfter, err := service.limiter.check(ctx, "login", nil, request.Meta.SourceIPHMAC)
	if err != nil {
		return LoginResult{}, err
	}
	if retryAfter > 0 {
		return LoginResult{}, &RateLimitError{RetryAfter: retryAfter}
	}
	state, challengeDigest, err := getChallenge(ctx, service.redis, service.redisPrefix, request.ChallengeID, service.tokens)
	if err != nil {
		if errors.Is(err, ErrInvalidCredentials) {
			return LoginResult{}, service.loginFailure(ctx, nil, nil, request.Meta)
		}
		return LoginResult{}, err
	}
	retryAfter, err = service.limiter.check(ctx, "login", state.AccountKey, request.Meta.SourceIPHMAC)
	if err != nil {
		return LoginResult{}, err
	}
	if retryAfter > 0 {
		return LoginResult{}, &RateLimitError{RetryAfter: retryAfter}
	}
	now := service.now()
	administratorID, parseErr := uuid.Parse(state.AdministratorID)
	if parseErr != nil || administratorID == uuid.Nil || !state.ExpiresAt.After(now) || !sourceMatches(state.SourceIPHMAC, request.Meta.SourceIPHMAC) {
		deleteChallenge(ctx, service.redis, service.redisPrefix, challengeDigest)
		return LoginResult{}, service.loginFailure(ctx, cloneUUIDIfSet(administratorID), state.AccountKey, request.Meta)
	}
	material, err := service.tokens.newSessionMaterial()
	if err != nil {
		return LoginResult{}, ErrUnavailable
	}
	tx, err := service.repository.begin(ctx)
	if err != nil {
		return LoginResult{}, err
	}
	defer func() { _ = tx.Rollback(context.Background()) }()
	administrator, err := lockLoginAdministrator(ctx, tx, administratorID)
	if err != nil || administrator.Status != "active" || !administrator.Role.Valid() || administrator.SecurityVersion <= 0 {
		return LoginResult{}, service.loginFailureTx(ctx, tx, cloneUUIDIfSet(administrator.ID), state.AccountKey, request.Meta)
	}
	mfaMethod := MFAMethodTOTP
	eventType := "admin_login_succeeded"
	reasonCode := ""
	var revokedTokenHMACs [][]byte
	if request.RecoveryCode != "" {
		recoveryDigest, valid := opaqueTokenDigest(request.RecoveryCode)
		if !valid {
			return LoginResult{}, service.loginFailureTx(ctx, tx, &administratorID, state.AccountKey, request.Meta)
		}
		consumed, err := consumeRecoveryCode(ctx, tx, administrator.ID, recoveryDigest, now)
		if err != nil {
			return LoginResult{}, err
		}
		if !consumed {
			return LoginResult{}, service.loginFailureTx(ctx, tx, &administratorID, state.AccountKey, request.Meta)
		}
		revokedTokenHMACs, err = revokeAdministratorSessionsTx(ctx, tx, administrator.ID, now)
		if err != nil {
			return LoginResult{}, err
		}
		mfaMethod = MFAMethodRecovery
		eventType = "admin_recovery_code_used"
		reasonCode = "account_recovery"
	} else {
		secret, err := service.totpSecrets.Open(administrator.TOTPSecret)
		if err != nil {
			return LoginResult{}, ErrUnavailable
		}
		acceptedStep, valid := service.totp.Validate(secret, request.TOTPCode, now, administrator.LastAcceptedStep)
		clear(secret)
		if !valid {
			return LoginResult{}, service.loginFailureTx(ctx, tx, &administratorID, state.AccountKey, request.Meta)
		}
		if err := acceptTOTPStep(ctx, tx, administrator.ID, administrator.LastAcceptedStep, acceptedStep, now); err != nil {
			return LoginResult{}, service.loginFailureTx(ctx, tx, &administratorID, state.AccountKey, request.Meta)
		}
	}
	session := sessionRecord{
		ID: material.ID, AdminID: administrator.ID, TokenHMAC: material.TokenHMAC, CSRFHMAC: material.CSRFHMAC,
		SecurityVersion: administrator.SecurityVersion, Role: administrator.Role, MFAMethod: mfaMethod,
		MFAAuthenticatedAt: now, CreatedAt: now, LastSeenAt: now,
		IdleExpiresAt: now.Add(sessionIdleLifetime), AbsoluteExpiresAt: now.Add(sessionAbsoluteLifetime),
	}
	if err := insertSession(ctx, tx, session); err != nil {
		return LoginResult{}, err
	}
	if _, err := service.audit.AppendTx(ctx, tx, audit.Record{
		ActorAdminID: &administrator.ID, ActorRole: administrator.Role,
		EventType: eventType, ObjectType: "admin_user", ObjectID: &administrator.ID,
		Outcome: audit.OutcomeSuccess, ReasonCode: reasonCode, RequestID: request.Meta.RequestID,
		SourceIPHMAC: request.Meta.SourceIPHMAC, UserAgent: request.Meta.UserAgent,
		AfterState: map[string]string{"session_status": "active", "mfa_status": string(mfaMethod)},
	}); err != nil {
		return LoginResult{}, ErrInvalidRequest
	}
	if err := tx.Commit(ctx); err != nil {
		return LoginResult{}, ErrUnavailable
	}
	for _, digest := range revokedTokenHMACs {
		deleteLiveSession(context.Background(), service.redis, service.redisPrefix, digest)
	}
	if err := service.liveSessionWriter(ctx, material.TokenHMAC, material.ID, sessionIdleLifetime); err != nil {
		_ = revokeSession(context.Background(), service.repository.postgres, material.ID, now)
		deleteChallenge(context.Background(), service.redis, service.redisPrefix, challengeDigest)
		return LoginResult{}, ErrUnavailable
	}
	deleteChallenge(ctx, service.redis, service.redisPrefix, challengeDigest)
	if err := service.limiter.success(ctx, "login", state.AccountKey); err != nil {
		_ = revokeSession(context.Background(), service.repository.postgres, material.ID, now)
		return LoginResult{}, err
	}
	principal := Principal{
		AdminID: administrator.ID.String(), SessionID: material.ID.String(), Role: administrator.Role,
		SecurityVersion: administrator.SecurityVersion, MFAAuthenticatedAt: now, MFAMethod: mfaMethod,
	}
	return LoginResult{
		RawSessionToken: material.RawToken, CSRFToken: material.CSRFToken, Principal: principal, DisplayName: administrator.DisplayName,
		AbsoluteExpiresAt: session.AbsoluteExpiresAt,
	}, nil
}

func (service *Service) Authenticate(ctx context.Context, rawSessionToken string) (AuthenticatedSession, error) {
	if service == nil {
		return AuthenticatedSession{}, ErrUnavailable
	}
	tokenHMAC, ok := service.tokens.sessionTokenHMAC(rawSessionToken)
	if !ok {
		return AuthenticatedSession{}, ErrInvalidSession
	}
	liveKey := liveSessionKey(service.redisPrefix, tokenHMAC)
	liveSessionID, err := service.redis.Get(ctx, liveKey).Result()
	if errors.Is(err, redis.Nil) {
		return AuthenticatedSession{}, ErrInvalidSession
	}
	if err != nil {
		return AuthenticatedSession{}, ErrUnavailable
	}
	session, err := findSessionByTokenHMAC(ctx, service.repository.postgres, tokenHMAC)
	if err != nil {
		if errors.Is(err, ErrInvalidSession) {
			deleteLiveSession(ctx, service.redis, service.redisPrefix, tokenHMAC)
		}
		return AuthenticatedSession{}, err
	}
	now := service.now()
	valid := liveSessionID == session.ID.String() &&
		subtle.ConstantTimeCompare(session.TokenHMAC, tokenHMAC) == 1 &&
		session.RevokedAt == nil && session.AdministratorStatus == "active" &&
		session.Role.Valid() && session.AdministratorRole == session.Role &&
		session.SecurityVersion > 0 && session.AdministratorSecurityVersion == session.SecurityVersion &&
		session.MFAMethod.Valid() && now.Before(session.IdleExpiresAt) && now.Before(session.AbsoluteExpiresAt)
	csrfToken := service.tokens.deriveCSRFToken(rawSessionToken)
	valid = valid && service.tokens.csrfMatches(csrfToken, session.CSRFHMAC)
	if !valid {
		_ = revokeSession(context.Background(), service.repository.postgres, session.ID, now)
		deleteLiveSession(context.Background(), service.redis, service.redisPrefix, tokenHMAC)
		return AuthenticatedSession{}, ErrInvalidSession
	}
	idleExpiresAt := now.Add(sessionIdleLifetime)
	if !idleExpiresAt.Before(session.AbsoluteExpiresAt) {
		idleExpiresAt = session.AbsoluteExpiresAt.Add(-time.Microsecond)
	}
	if !idleExpiresAt.After(now) {
		_ = revokeSession(context.Background(), service.repository.postgres, session.ID, now)
		deleteLiveSession(context.Background(), service.redis, service.redisPrefix, tokenHMAC)
		return AuthenticatedSession{}, ErrInvalidSession
	}
	updateLastSeen := !session.LastSeenAt.Add(sessionLastSeenWriteInterval).After(now)
	if err := touchSession(ctx, service.repository.postgres, session.ID, now, idleExpiresAt, updateLastSeen); err != nil {
		return AuthenticatedSession{}, err
	}
	refreshed, err := service.redis.Expire(ctx, liveKey, idleExpiresAt.Sub(now)).Result()
	if err != nil {
		return AuthenticatedSession{}, ErrUnavailable
	}
	if !refreshed {
		_ = revokeSession(context.Background(), service.repository.postgres, session.ID, now)
		return AuthenticatedSession{}, ErrInvalidSession
	}
	if updateLastSeen {
		session.LastSeenAt = now
	}
	session.IdleExpiresAt = idleExpiresAt
	principal := Principal{
		AdminID: session.AdminID.String(), SessionID: session.ID.String(), Role: session.Role,
		SecurityVersion: session.SecurityVersion, MFAAuthenticatedAt: session.MFAAuthenticatedAt,
		MFAMethod: session.MFAMethod,
	}
	return AuthenticatedSession{Principal: principal, CSRFToken: csrfToken, DisplayName: session.DisplayName, AbsoluteExpiresAt: session.AbsoluteExpiresAt}, nil
}

func (service *Service) StepUp(ctx context.Context, rawSessionToken, totpCode string, meta RequestMeta) (AuthenticatedSession, error) {
	if service == nil || !validRequestMeta(meta) {
		return AuthenticatedSession{}, ErrInvalidRequest
	}
	authenticated, err := service.Authenticate(ctx, rawSessionToken)
	if err != nil {
		return AuthenticatedSession{}, err
	}
	tokenHMAC, ok := service.tokens.sessionTokenHMAC(rawSessionToken)
	if !ok {
		return AuthenticatedSession{}, ErrInvalidSession
	}
	tx, err := service.repository.begin(ctx)
	if err != nil {
		return AuthenticatedSession{}, err
	}
	defer func() { _ = tx.Rollback(context.Background()) }()
	record, err := lockSessionForStepUp(ctx, tx, tokenHMAC)
	if err != nil {
		return AuthenticatedSession{}, err
	}
	now := service.now()
	if !validSessionRecord(record.Session, tokenHMAC, now) || record.Session.ID.String() != authenticated.Principal.SessionID {
		return AuthenticatedSession{}, ErrInvalidSession
	}
	secret, err := service.totpSecrets.Open(record.TOTPSecret)
	if err != nil {
		return AuthenticatedSession{}, ErrUnavailable
	}
	acceptedStep, valid := service.totp.Validate(secret, totpCode, now, record.LastAcceptedStep)
	clear(secret)
	if !valid {
		return AuthenticatedSession{}, service.stepUpFailureTx(ctx, tx, &record.Session.AdminID, meta)
	}
	if err := acceptTOTPStep(ctx, tx, record.Session.AdminID, record.LastAcceptedStep, acceptedStep, now); err != nil {
		return AuthenticatedSession{}, service.stepUpFailureTx(ctx, tx, &record.Session.AdminID, meta)
	}
	if err := persistStepUp(ctx, tx, record.Session.ID, now); err != nil {
		return AuthenticatedSession{}, err
	}
	if _, err := service.audit.AppendTx(ctx, tx, audit.Record{
		ActorAdminID: &record.Session.AdminID, ActorRole: record.Session.Role,
		EventType: "admin_step_up_succeeded", ObjectType: "admin_session", ObjectID: &record.Session.ID,
		Outcome: audit.OutcomeSuccess, RequestID: meta.RequestID,
		SourceIPHMAC: meta.SourceIPHMAC, UserAgent: meta.UserAgent,
		BeforeState: map[string]string{"mfa_status": string(record.Session.MFAMethod)},
		AfterState:  map[string]string{"mfa_status": string(MFAMethodTOTP)},
	}); err != nil {
		return AuthenticatedSession{}, ErrUnavailable
	}
	if err := tx.Commit(ctx); err != nil {
		return AuthenticatedSession{}, ErrUnavailable
	}
	authenticated.Principal.MFAMethod = MFAMethodTOTP
	authenticated.Principal.MFAAuthenticatedAt = now
	return authenticated, nil
}

func (service *Service) Logout(ctx context.Context, rawSessionToken string, meta RequestMeta) error {
	if service == nil || !validRequestMeta(meta) {
		return ErrInvalidRequest
	}
	tokenHMAC, ok := service.tokens.sessionTokenHMAC(rawSessionToken)
	if !ok {
		return ErrInvalidSession
	}
	tx, err := service.repository.begin(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(context.Background()) }()
	session, err := lockSessionByTokenHMAC(ctx, tx, tokenHMAC)
	if err != nil || !validSessionRecord(session, tokenHMAC, service.now()) {
		return ErrInvalidSession
	}
	now := service.now()
	if err := revokeSessionTx(ctx, tx, session.ID, now); err != nil {
		return err
	}
	if _, err := service.audit.AppendTx(ctx, tx, audit.Record{
		ActorAdminID: &session.AdminID, ActorRole: session.Role,
		EventType: "admin_logout", ObjectType: "admin_session", ObjectID: &session.ID,
		Outcome: audit.OutcomeSuccess, RequestID: meta.RequestID,
		SourceIPHMAC: meta.SourceIPHMAC, UserAgent: meta.UserAgent,
		BeforeState: map[string]string{"session_status": "active"},
		AfterState:  map[string]string{"session_status": "revoked"},
	}); err != nil {
		return ErrUnavailable
	}
	if err := tx.Commit(ctx); err != nil {
		return ErrUnavailable
	}
	deleteLiveSession(ctx, service.redis, service.redisPrefix, tokenHMAC)
	return nil
}

func (service *Service) CheckActivationAttempts(ctx context.Context, subjectDigest, sourceIPHMAC []byte) (time.Duration, error) {
	if service == nil {
		return 0, ErrUnavailable
	}
	return service.limiter.check(ctx, "activation", subjectDigest, sourceIPHMAC)
}

func (service *Service) RecordActivationFailure(ctx context.Context, subjectDigest, sourceIPHMAC []byte) (time.Duration, error) {
	if service == nil {
		return 0, ErrUnavailable
	}
	return service.limiter.failure(ctx, "activation", subjectDigest, sourceIPHMAC)
}

func (service *Service) ClearActivationFailures(ctx context.Context, subjectDigest []byte) error {
	if service == nil {
		return ErrUnavailable
	}
	return service.limiter.success(ctx, "activation", subjectDigest)
}

func (service *Service) auditHTTPDenial(ctx context.Context, path string, status int, principal Principal, meta RequestMeta) {
	if service == nil || !validRequestMeta(meta) {
		return
	}
	if (path == "/auth/login" || path == "/auth/totp/verify") &&
		(status == http.StatusUnauthorized || status == http.StatusTooManyRequests) {
		return
	}
	record := audit.Record{
		EventType: "admin_authorization_denied", ObjectType: "admin_api_request",
		Outcome: audit.OutcomeDenied, ErrorCode: "AUTHORIZATION_DENIED",
		RequestID: meta.RequestID, SourceIPHMAC: meta.SourceIPHMAC, UserAgent: meta.UserAgent,
	}
	if strings.HasPrefix(path, "/auth/activat") {
		record.EventType = "admin_activation_failed"
		record.ObjectType = "admin_authentication"
		record.Outcome = audit.OutcomeFailure
		record.ErrorCode = "ACTIVATION_INVALID"
	}
	if path == "/admin-users/invitations" {
		record.ObjectType = "admin_user_collection"
	} else if strings.HasPrefix(path, "/admin-users/") {
		remainder := strings.TrimPrefix(path, "/admin-users/")
		rawID, _, _ := strings.Cut(remainder, "/")
		if objectID, err := uuid.Parse(rawID); err == nil && objectID != uuid.Nil {
			record.ObjectType = "admin_user"
			record.ObjectID = &objectID
		}
	}
	if principal.Role.Valid() {
		if actorID, err := uuid.Parse(principal.AdminID); err == nil && actorID != uuid.Nil {
			record.ActorAdminID = &actorID
			record.ActorRole = principal.Role
		}
	}
	_, _ = service.audit.Append(ctx, record)
}

func validSessionRecord(session sessionRecord, tokenHMAC []byte, now time.Time) bool {
	return session.ID != uuid.Nil && session.AdminID != uuid.Nil && len(session.TokenHMAC) == sha256.Size &&
		subtle.ConstantTimeCompare(session.TokenHMAC, tokenHMAC) == 1 && session.RevokedAt == nil &&
		session.AdministratorStatus == "active" && session.Role.Valid() && session.AdministratorRole == session.Role &&
		session.SecurityVersion > 0 && session.AdministratorSecurityVersion == session.SecurityVersion &&
		session.MFAMethod.Valid() && now.Before(session.IdleExpiresAt) && now.Before(session.AbsoluteExpiresAt)
}

func (service *Service) loginFailure(ctx context.Context, administratorID *uuid.UUID, accountKey []byte, meta RequestMeta) error {
	retryAfter, limitErr := service.limiter.failure(ctx, "login", accountKey, meta.SourceIPHMAC)
	if limitErr != nil {
		return limitErr
	}
	record := audit.Record{
		EventType: "admin_login_failed", ObjectType: "admin_authentication", ObjectID: administratorID,
		Outcome: audit.OutcomeFailure, ErrorCode: "AUTH_INVALID_CREDENTIALS",
		RequestID: meta.RequestID, SourceIPHMAC: meta.SourceIPHMAC, UserAgent: meta.UserAgent,
	}
	if _, err := service.audit.Append(ctx, record); err != nil {
		return ErrUnavailable
	}
	if retryAfter > 0 {
		return &RateLimitError{RetryAfter: retryAfter}
	}
	return ErrInvalidCredentials
}

func (service *Service) loginFailureTx(
	ctx context.Context,
	tx pgx.Tx,
	administratorID *uuid.UUID,
	accountKey []byte,
	meta RequestMeta,
) error {
	retryAfter, limitErr := service.limiter.failure(ctx, "login", accountKey, meta.SourceIPHMAC)
	if limitErr != nil {
		return limitErr
	}
	if _, err := service.audit.AppendTx(ctx, tx, audit.Record{
		EventType: "admin_login_failed", ObjectType: "admin_authentication", ObjectID: administratorID,
		Outcome: audit.OutcomeFailure, ErrorCode: "AUTH_INVALID_CREDENTIALS",
		RequestID: meta.RequestID, SourceIPHMAC: meta.SourceIPHMAC, UserAgent: meta.UserAgent,
	}); err != nil {
		return ErrUnavailable
	}
	if err := tx.Commit(ctx); err != nil {
		return ErrUnavailable
	}
	if retryAfter > 0 {
		return &RateLimitError{RetryAfter: retryAfter}
	}
	return ErrInvalidCredentials
}

func (service *Service) stepUpFailureTx(ctx context.Context, tx pgx.Tx, administratorID *uuid.UUID, meta RequestMeta) error {
	retryAfter, limitErr := service.limiter.failure(ctx, "login", nil, meta.SourceIPHMAC)
	if limitErr != nil {
		return limitErr
	}
	if _, err := service.audit.AppendTx(ctx, tx, audit.Record{
		EventType: "admin_step_up_failed", ObjectType: "admin_authentication", ObjectID: administratorID,
		Outcome: audit.OutcomeFailure, ErrorCode: "AUTH_INVALID_CREDENTIALS",
		RequestID: meta.RequestID, SourceIPHMAC: meta.SourceIPHMAC, UserAgent: meta.UserAgent,
	}); err != nil {
		return ErrUnavailable
	}
	if err := tx.Commit(ctx); err != nil {
		return ErrUnavailable
	}
	if retryAfter > 0 {
		return &RateLimitError{RetryAfter: retryAfter}
	}
	return ErrInvalidCredentials
}

func (service *Service) now() time.Time {
	return service.clock().UTC().Truncate(time.Microsecond)
}

func validRequestMeta(meta RequestMeta) bool {
	return authenticationRequestIDPattern.MatchString(meta.RequestID) && len(meta.SourceIPHMAC) == sha256.Size
}

func cloneUUIDIfSet(value uuid.UUID) *uuid.UUID {
	if value == uuid.Nil {
		return nil
	}
	cloned := value
	return &cloned
}

func opaqueTokenDigest(raw string) ([]byte, bool) {
	decoded, err := base64.RawURLEncoding.DecodeString(raw)
	if err != nil || len(decoded) != 32 || len(raw) > 128 {
		return nil, false
	}
	digest := secure.DigestOpaqueToken(raw)
	return append([]byte(nil), digest[:]...), true
}
