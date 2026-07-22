package cloudadmin

import (
	"errors"
	"regexp"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/google/uuid"
)

var (
	ErrNotConfigured         = errors.New("Cloud administration is not configured")
	ErrUnavailable           = errors.New("Cloud administration is unavailable")
	ErrContractViolation     = errors.New("Cloud administration contract violation")
	ErrPermissionDenied      = errors.New("Cloud administration permission denied")
	ErrPublicationDLPBlocked = errors.New("Cloud administration publication blocked by DLP")
	ErrNotFound              = errors.New("Cloud administration target not found")
	ErrConflict              = errors.New("Cloud administration state conflict")

	maskedEmailPattern = regexp.MustCompile(`^[^@*[:space:]]\*{3}@[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$`)
	maskedPhonePattern = regexp.MustCompile(`^[0-9]{3}\*{4}[0-9]{4}$`)
	cursorPattern      = regexp.MustCompile(`^[A-Za-z0-9_-]{1,512}$`)
	errorCodePattern   = regexp.MustCompile(`^[A-Z][A-Z0-9_]{2,99}$`)
	phonePattern       = regexp.MustCompile(`(?:\+?86)?1[3-9][0-9]{9}`)
)

type Availability string

const (
	NotConfigured Availability = "not_configured"
	Available     Availability = "available"
	Unavailable   Availability = "unavailable"
	ContractError Availability = "contract_error"
)

type CheckStatus string

const (
	CheckNotChecked    CheckStatus = "not_checked"
	CheckOK            CheckStatus = "ok"
	CheckUnavailable   CheckStatus = "unavailable"
	CheckContractError CheckStatus = "contract_error"
)

type Health struct {
	Configured   bool         `json:"configured"`
	Availability Availability `json:"availability"`
	MTLS         CheckStatus  `json:"mtls"`
	ServiceJWT   CheckStatus  `json:"service_jwt"`
	Upstream     CheckStatus  `json:"upstream"`
	CheckedAt    time.Time    `json:"checked_at"`
}

type IdentityKind string

const (
	IdentityEmail IdentityKind = "email"
	IdentityPhone IdentityKind = "phone"
)

type UserStatus string

const (
	UserActive          UserStatus = "active"
	UserPendingDeletion UserStatus = "pending_deletion"
	UserDisabled        UserStatus = "disabled"
)

type DeviceStatus string

const (
	DeviceActive   DeviceStatus = "active"
	DeviceInactive DeviceStatus = "inactive"
	DeviceRevoked  DeviceStatus = "revoked"
)

type SessionStatus string

const (
	SessionActive         SessionStatus = "active"
	SessionRotated        SessionStatus = "rotated"
	SessionExpired        SessionStatus = "expired"
	SessionRevoked        SessionStatus = "revoked"
	SessionReplayDetected SessionStatus = "replay_detected"
)

type OperationStatus string

const (
	OperationQueued    OperationStatus = "queued"
	OperationExecuting OperationStatus = "executing"
	OperationSucceeded OperationStatus = "succeeded"
	OperationFailed    OperationStatus = "failed"
	OperationConflict  OperationStatus = "conflict"
)

type PageRequest struct {
	Cursor string
	Limit  int
}

type ListUsersRequest struct {
	PageRequest
	Status UserStatus
}

type LookupRequest struct {
	Kind  IdentityKind `json:"type"`
	Value string       `json:"value"`
}

type Page[T any] struct {
	Items      []T    `json:"items"`
	NextCursor string `json:"next_cursor,omitempty"`
}

type User struct {
	ID                       uuid.UUID  `json:"user_id"`
	MaskedEmail              string     `json:"masked_email,omitempty"`
	MaskedPhone              string     `json:"masked_phone,omitempty"`
	Status                   UserStatus `json:"status"`
	AdministrativelyDisabled bool       `json:"administratively_disabled"`
	DeletionFinalizedAt      *time.Time `json:"deletion_finalized_at,omitempty"`
	AdministrativeRevision   int64      `json:"administrative_revision"`
	DeviceCount              int        `json:"device_count"`
	ActiveDeviceCount        int        `json:"active_device_count"`
	ActiveSessionCount       int        `json:"active_session_count"`
	CreatedAt                time.Time  `json:"created_at"`
	LastCloudActivityAt      *time.Time `json:"last_cloud_activity_at,omitempty"`
}

type Device struct {
	ID            uuid.UUID    `json:"device_id"`
	UserID        uuid.UUID    `json:"user_id"`
	DisplayName   string       `json:"display_name"`
	Platform      string       `json:"platform"`
	ClientVersion string       `json:"client_version"`
	Status        DeviceStatus `json:"status"`
	LastSeenAt    *time.Time   `json:"last_seen_at,omitempty"`
}

type Session struct {
	ID        uuid.UUID     `json:"session_id"`
	UserID    uuid.UUID     `json:"user_id"`
	DeviceID  uuid.UUID     `json:"device_id"`
	Status    SessionStatus `json:"status"`
	IssuedAt  time.Time     `json:"issued_at"`
	ExpiresAt time.Time     `json:"expires_at"`
	RevokedAt *time.Time    `json:"revoked_at,omitempty"`
}

type Operation struct {
	ID                     uuid.UUID       `json:"operation_id"`
	Status                 OperationStatus `json:"status"`
	ErrorCode              string          `json:"error_code,omitempty"`
	AdministrativeRevision int64           `json:"administrative_revision,omitempty"`
	UpdatedAt              time.Time       `json:"updated_at"`
}

func (user User) Validate() error {
	emailOK := user.MaskedEmail == "" || maskedEmailPattern.MatchString(user.MaskedEmail)
	phoneOK := user.MaskedPhone == "" || maskedPhonePattern.MatchString(user.MaskedPhone)
	statusOK := user.Status == UserActive || user.Status == UserPendingDeletion || user.Status == UserDisabled
	if user.ID == uuid.Nil || !emailOK || !phoneOK || (user.MaskedEmail == "" && user.MaskedPhone == "") ||
		!statusOK || user.AdministrativeRevision <= 0 || user.DeviceCount < 0 ||
		user.ActiveDeviceCount < 0 || user.ActiveDeviceCount > user.DeviceCount || user.ActiveSessionCount < 0 ||
		user.CreatedAt.IsZero() {
		return ErrContractViolation
	}
	return nil
}

func (device Device) Validate() error {
	statusOK := device.Status == DeviceActive || device.Status == DeviceInactive || device.Status == DeviceRevoked
	if device.ID == uuid.Nil || device.UserID == uuid.Nil || !statusOK ||
		!validBoundedLabel(device.DisplayName, 100) || !validBoundedLabel(device.Platform, 32) ||
		!validBoundedLabel(device.ClientVersion, 64) {
		return ErrContractViolation
	}
	return nil
}

func (session Session) Validate() error {
	statusOK := session.Status == SessionActive || session.Status == SessionRotated || session.Status == SessionExpired ||
		session.Status == SessionRevoked || session.Status == SessionReplayDetected
	if session.ID == uuid.Nil || session.UserID == uuid.Nil || session.DeviceID == uuid.Nil || !statusOK ||
		session.IssuedAt.IsZero() || !session.ExpiresAt.After(session.IssuedAt) ||
		(session.RevokedAt != nil && session.RevokedAt.Before(session.IssuedAt)) {
		return ErrContractViolation
	}
	return nil
}

func validateCursor(cursor string) error {
	if cursor != "" && !cursorPattern.MatchString(cursor) {
		return ErrContractViolation
	}
	return nil
}

func validateOperation(operation Operation) error {
	statusOK := operation.Status == OperationQueued || operation.Status == OperationExecuting ||
		operation.Status == OperationSucceeded || operation.Status == OperationFailed || operation.Status == OperationConflict
	if operation.ID == uuid.Nil || !statusOK || operation.UpdatedAt.IsZero() ||
		(operation.ErrorCode != "" && !errorCodePattern.MatchString(operation.ErrorCode)) {
		return ErrContractViolation
	}
	return nil
}

func validateUserPage(page Page[User]) error {
	if page.Items == nil || validateCursor(page.NextCursor) != nil {
		return ErrContractViolation
	}
	for _, item := range page.Items {
		if err := item.Validate(); err != nil {
			return err
		}
	}
	return nil
}

func validateDevicePage(page Page[Device]) error {
	if page.Items == nil || validateCursor(page.NextCursor) != nil {
		return ErrContractViolation
	}
	for _, item := range page.Items {
		if err := item.Validate(); err != nil {
			return err
		}
	}
	return nil
}

func validateSessionPage(page Page[Session]) error {
	if page.Items == nil || validateCursor(page.NextCursor) != nil {
		return ErrContractViolation
	}
	for _, item := range page.Items {
		if err := item.Validate(); err != nil {
			return err
		}
	}
	return nil
}

func validBoundedLabel(value string, maximum int) bool {
	if value == "" || !utf8.ValidString(value) || utf8.RuneCountInString(value) > maximum ||
		strings.Contains(value, "@") || phonePattern.MatchString(value) {
		return false
	}
	for _, character := range value {
		if unicode.IsControl(character) {
			return false
		}
	}
	return true
}
