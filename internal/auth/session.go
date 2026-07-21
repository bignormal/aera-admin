package auth

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"strings"
	"time"

	"github.com/bignormal/aera-admin/internal/secure"
	"github.com/google/uuid"
	"github.com/redis/go-redis/v9"
)

const (
	loginChallengeLifetime  = 5 * time.Minute
	sessionIdleLifetime     = 30 * time.Minute
	sessionAbsoluteLifetime = 8 * time.Hour
)

type tokenCodec struct {
	sessionKey []byte
	csrfKey    []byte
}

type sessionMaterial struct {
	ID        uuid.UUID
	RawToken  string
	TokenHMAC []byte
	CSRFToken string
	CSRFHMAC  []byte
}

type challengeState struct {
	AdministratorID string    `json:"administrator_id"`
	AccountKey      []byte    `json:"account_key"`
	SourceIPHMAC    []byte    `json:"source_ip_hmac"`
	ExpiresAt       time.Time `json:"expires_at"`
}

func newTokenCodec(sessionKey, csrfKey []byte) (*tokenCodec, error) {
	if len(sessionKey) < 32 || len(csrfKey) < 32 {
		return nil, errors.New("authentication token keys are invalid")
	}
	return &tokenCodec{
		sessionKey: append([]byte(nil), sessionKey...),
		csrfKey:    append([]byte(nil), csrfKey...),
	}, nil
}

func (codec *tokenCodec) newSessionMaterial() (sessionMaterial, error) {
	raw, _, err := secure.NewOpaqueToken(32)
	if err != nil {
		return sessionMaterial{}, err
	}
	tokenHMAC, ok := codec.sessionTokenHMAC(raw)
	if !ok {
		return sessionMaterial{}, ErrUnavailable
	}
	csrf := codec.deriveCSRFToken(raw)
	return sessionMaterial{
		ID: uuid.New(), RawToken: raw, TokenHMAC: tokenHMAC,
		CSRFToken: csrf, CSRFHMAC: codec.csrfTokenHMAC(csrf),
	}, nil
}

func (codec *tokenCodec) sessionTokenHMAC(raw string) ([]byte, bool) {
	decoded, err := base64.RawURLEncoding.DecodeString(raw)
	if codec == nil || err != nil || len(decoded) != 32 || len(raw) > 128 {
		return nil, false
	}
	return keyedDigest(codec.sessionKey, "aera-admin.session-token.v1", raw), true
}

func (codec *tokenCodec) challengeTokenHMAC(raw string) ([]byte, bool) {
	decoded, err := base64.RawURLEncoding.DecodeString(raw)
	if codec == nil || err != nil || len(decoded) != 32 || len(raw) > 128 {
		return nil, false
	}
	return keyedDigest(codec.sessionKey, "aera-admin.login-challenge.v1", raw), true
}

func (codec *tokenCodec) deriveCSRFToken(rawSessionToken string) string {
	digest := keyedDigest(codec.csrfKey, "aera-admin.csrf-token.v1", rawSessionToken)
	return base64.RawURLEncoding.EncodeToString(digest)
}

func (codec *tokenCodec) csrfTokenHMAC(raw string) []byte {
	return keyedDigest(codec.csrfKey, "aera-admin.csrf-storage.v1", raw)
}

func (codec *tokenCodec) csrfMatches(raw string, expected []byte) bool {
	if codec == nil || len(expected) != sha256.Size || len(raw) > 128 {
		return false
	}
	actual := codec.csrfTokenHMAC(raw)
	return subtle.ConstantTimeCompare(actual, expected) == 1
}

func keyedDigest(key []byte, domain, value string) []byte {
	mac := hmac.New(sha256.New, key)
	_, _ = mac.Write([]byte(domain))
	_, _ = mac.Write([]byte{0})
	_, _ = mac.Write([]byte(value))
	return mac.Sum(nil)
}

func challengeKey(prefix string, digest []byte) string {
	return prefix + "login-challenge:" + hex.EncodeToString(digest)
}

func liveSessionKey(prefix string, digest []byte) string {
	return prefix + "session:" + hex.EncodeToString(digest)
}

func putChallenge(ctx context.Context, client *redis.Client, prefix, raw string, codec *tokenCodec, state challengeState, ttl time.Duration) error {
	digest, ok := codec.challengeTokenHMAC(raw)
	if client == nil || !ok || ttl <= 0 {
		return ErrUnavailable
	}
	encoded, err := json.Marshal(state)
	if err != nil {
		return ErrUnavailable
	}
	if err := client.Set(ctx, challengeKey(prefix, digest), encoded, ttl).Err(); err != nil {
		return ErrUnavailable
	}
	return nil
}

func getChallenge(ctx context.Context, client *redis.Client, prefix, raw string, codec *tokenCodec) (challengeState, []byte, error) {
	digest, ok := codec.challengeTokenHMAC(raw)
	if client == nil || !ok {
		return challengeState{}, nil, ErrInvalidCredentials
	}
	encoded, err := client.Get(ctx, challengeKey(prefix, digest)).Bytes()
	if errors.Is(err, redis.Nil) {
		return challengeState{}, digest, ErrInvalidCredentials
	}
	if err != nil {
		return challengeState{}, digest, ErrUnavailable
	}
	var state challengeState
	if err := json.Unmarshal(encoded, &state); err != nil || state.AdministratorID == "" || len(state.AccountKey) != sha256.Size || len(state.SourceIPHMAC) != sha256.Size || state.ExpiresAt.IsZero() {
		_ = client.Del(ctx, challengeKey(prefix, digest)).Err()
		return challengeState{}, digest, ErrInvalidCredentials
	}
	return state, digest, nil
}

func deleteChallenge(ctx context.Context, client *redis.Client, prefix string, digest []byte) {
	if client != nil && len(digest) == sha256.Size {
		_ = client.Del(ctx, challengeKey(prefix, digest)).Err()
	}
}

func putLiveSession(ctx context.Context, client *redis.Client, prefix string, tokenHMAC []byte, sessionID uuid.UUID, ttl time.Duration) error {
	if client == nil || len(tokenHMAC) != sha256.Size || sessionID == uuid.Nil || ttl <= 0 {
		return ErrUnavailable
	}
	if err := client.Set(ctx, liveSessionKey(prefix, tokenHMAC), sessionID.String(), ttl).Err(); err != nil {
		return ErrUnavailable
	}
	return nil
}

func deleteLiveSession(ctx context.Context, client *redis.Client, prefix string, tokenHMAC []byte) {
	if client != nil && len(tokenHMAC) == sha256.Size {
		_ = client.Del(ctx, liveSessionKey(prefix, tokenHMAC)).Err()
	}
}

func sourceMatches(left, right []byte) bool {
	return len(left) == sha256.Size && len(right) == sha256.Size && subtle.ConstantTimeCompare(left, right) == 1
}

func validRedisPrefix(prefix string) bool {
	return prefix != "" && len(prefix) <= 128 && strings.HasSuffix(prefix, ":") && !strings.ContainsAny(prefix, "\r\n\x00")
}
