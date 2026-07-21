package auth

import (
	"errors"
	"time"
)

var (
	ErrInvalidRequest     = errors.New("authentication request is invalid")
	ErrInvalidCredentials = errors.New("administrator credentials are invalid")
	ErrInvalidSession     = errors.New("administrator session is invalid")
	ErrUnavailable        = errors.New("authentication service is unavailable")
	ErrRateLimited        = errors.New("authentication attempt is rate limited")
	ErrOrigin             = errors.New("request origin is invalid")
	ErrCSRF               = errors.New("CSRF token is invalid")
	ErrStepUpRequired     = errors.New("recent TOTP authentication is required")
)

type RateLimitError struct {
	RetryAfter time.Duration
}

func (err *RateLimitError) Error() string {
	return ErrRateLimited.Error()
}

func (err *RateLimitError) Is(target error) bool {
	return target == ErrRateLimited
}

type MFAMethod string

const (
	MFAMethodTOTP     MFAMethod = "totp"
	MFAMethodRecovery MFAMethod = "recovery"
)

func (method MFAMethod) Valid() bool {
	return method == MFAMethodTOTP || method == MFAMethodRecovery
}

type RequestMeta struct {
	RequestID    string
	SourceIPHMAC []byte
	UserAgent    string
}

type LoginChallenge struct {
	ID        string    `json:"challenge_id"`
	ExpiresAt time.Time `json:"expires_at"`
}

type CompleteLoginRequest struct {
	ChallengeID  string
	TOTPCode     string
	RecoveryCode string
	Meta         RequestMeta
}

type LoginResult struct {
	RawSessionToken   string
	CSRFToken         string
	Principal         Principal
	DisplayName       string
	AbsoluteExpiresAt time.Time
}

type AuthenticatedSession struct {
	Principal         Principal
	CSRFToken         string
	DisplayName       string
	AbsoluteExpiresAt time.Time
}
