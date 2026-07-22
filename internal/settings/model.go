package settings

import (
	"crypto/sha256"
	"errors"
	"regexp"
	"strconv"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/bignormal/aera-admin/internal/audit"
	"github.com/bignormal/aera-admin/internal/rbac"
	"github.com/google/uuid"
)

var (
	ErrInvalidRequest       = errors.New("settings request is invalid")
	ErrPermissionDenied     = errors.New("settings permission is denied")
	ErrUnavailable          = errors.New("settings service is unavailable")
	ErrRevisionConflict     = errors.New("settings revision changed")
	ErrIdempotencyKeyReused = errors.New("settings idempotency key was reused for another request")
	ErrReasonNotFound       = errors.New("reason code was not found")
	ErrReasonExists         = errors.New("reason code already exists")
	ErrReasonInactive       = errors.New("reason code is inactive")
	ErrReasonIncompatible   = errors.New("reason code is incompatible with the requested action")
	ErrReasonProtected      = errors.New("protected reason code cannot be deactivated")
	ErrLastActiveReason     = errors.New("reason category must retain an active code")
)

var (
	reasonCodePattern     = regexp.MustCompile(`^[a-z][a-z0-9_]{2,63}$`)
	idempotencyKeyPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$`)
	ticketPattern         = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$`)
)

type ReasonCategory string

const (
	CategoryAdministrator ReasonCategory = "administrator"
	CategorySession       ReasonCategory = "session"
	CategoryDevice        ReasonCategory = "device"
	CategoryAccount       ReasonCategory = "account"
	CategorySecurity      ReasonCategory = "security"
	CategoryOfficialAgent ReasonCategory = "official_agent"
)

func (category ReasonCategory) Valid() bool {
	return category == CategoryAdministrator || category == CategorySession || category == CategoryDevice ||
		category == CategoryAccount || category == CategorySecurity || category == CategoryOfficialAgent
}

type ReasonUsage string

const (
	UsageAdministrator ReasonUsage = "administrator"
	UsageAccount       ReasonUsage = "account"
	UsageDevice        ReasonUsage = "device"
	UsageSession       ReasonUsage = "session"
	UsageSettings      ReasonUsage = "settings"
	UsageOfficialAgent ReasonUsage = "official_agent"
)

func (usage ReasonUsage) Valid() bool {
	return usage == UsageAdministrator || usage == UsageAccount || usage == UsageDevice ||
		usage == UsageSession || usage == UsageSettings || usage == UsageOfficialAgent
}

func CompatibleReason(usage ReasonUsage, category ReasonCategory) bool {
	if !usage.Valid() || !category.Valid() {
		return false
	}
	if category == CategorySecurity {
		return true
	}
	switch usage {
	case UsageAdministrator:
		return category == CategoryAdministrator
	case UsageAccount:
		return category == CategoryAccount
	case UsageDevice:
		return category == CategoryDevice
	case UsageSession:
		return category == CategorySession
	case UsageSettings:
		return false
	case UsageOfficialAgent:
		return category == CategoryOfficialAgent
	default:
		return false
	}
}

func ProtectedReasonCode(code string) bool {
	return code == "security_policy_change" || code == "reason_catalog_change"
}

type Policy struct {
	SessionIdleMinutes   int        `json:"session_idle_minutes"`
	SessionAbsoluteHours int        `json:"session_absolute_hours"`
	AuditRetentionDays   int        `json:"audit_retention_days"`
	Revision             int64      `json:"revision"`
	UpdatedByAdminID     *uuid.UUID `json:"updated_by_admin_id"`
	UpdatedAt            time.Time  `json:"updated_at"`
}

func (policy Policy) Validate() error {
	if policy.SessionIdleMinutes < 5 || policy.SessionIdleMinutes > 120 ||
		policy.SessionAbsoluteHours < 1 || policy.SessionAbsoluteHours > 24 ||
		policy.SessionAbsoluteHours*60 <= policy.SessionIdleMinutes ||
		policy.AuditRetentionDays < 365 || policy.AuditRetentionDays > 3650 ||
		policy.Revision <= 0 || (policy.UpdatedByAdminID != nil && *policy.UpdatedByAdminID == uuid.Nil) {
		return ErrInvalidRequest
	}
	return nil
}

func (policy Policy) SessionLifetimes() (time.Duration, time.Duration, error) {
	if err := policy.Validate(); err != nil {
		return 0, 0, err
	}
	return time.Duration(policy.SessionIdleMinutes) * time.Minute,
		time.Duration(policy.SessionAbsoluteHours) * time.Hour, nil
}

type ReasonCode struct {
	Code      string         `json:"code"`
	Category  ReasonCategory `json:"category"`
	Label     string         `json:"label"`
	Active    bool           `json:"active"`
	Revision  int64          `json:"revision"`
	CreatedAt time.Time      `json:"created_at"`
	UpdatedAt time.Time      `json:"updated_at"`
}

func (reason ReasonCode) Validate() error {
	if !reasonCodePattern.MatchString(reason.Code) || !reason.Category.Valid() ||
		!validHumanText(reason.Label, 1, 80) || reason.Revision <= 0 ||
		reason.CreatedAt.IsZero() || reason.UpdatedAt.IsZero() || reason.UpdatedAt.Before(reason.CreatedAt) {
		return ErrInvalidRequest
	}
	return nil
}

type Page struct {
	Items            []ReasonCode `json:"items"`
	SettingsRevision int64        `json:"settings_revision"`
}

type ReasonQuery struct {
	Usage           ReasonUsage
	Category        ReasonCategory
	IncludeInactive bool
}

func (query ReasonQuery) Validate() error {
	if query.Usage != "" && query.Category != "" ||
		(query.Usage != "" && !query.Usage.Valid()) ||
		(query.Usage != "" && query.IncludeInactive) ||
		(query.Category != "" && !query.Category.Valid()) {
		return ErrInvalidRequest
	}
	return nil
}

type MutationReason struct {
	ReasonCode      string `json:"reason_code"`
	TicketReference string `json:"ticket_reference"`
	Note            string `json:"note"`
}

func (reason MutationReason) Validate() error {
	if !reasonCodePattern.MatchString(reason.ReasonCode) ||
		(reason.TicketReference != "" && !ticketPattern.MatchString(strings.TrimSpace(reason.TicketReference))) ||
		!validOptionalText(reason.Note, 500) || audit.ContainsSensitiveText(reason.TicketReference) ||
		audit.ContainsSensitiveText(reason.Note) {
		return ErrInvalidRequest
	}
	return nil
}

type MutationContext struct {
	ActorAdminID   uuid.UUID
	ActorRole      rbac.Role
	IdempotencyKey string
	RequestID      string
	SourceIPHMAC   []byte
	UserAgent      string
}

func (mutation MutationContext) Validate() error {
	if mutation.ActorAdminID == uuid.Nil || !mutation.ActorRole.Valid() ||
		!idempotencyKeyPattern.MatchString(mutation.IdempotencyKey) || mutation.RequestID == "" ||
		len(mutation.RequestID) > 128 || len(mutation.SourceIPHMAC) != 0 && len(mutation.SourceIPHMAC) != sha256.Size {
		return ErrInvalidRequest
	}
	return nil
}

type UpdatePolicyInput struct {
	ExpectedRevision     int64 `json:"expected_revision"`
	SessionIdleMinutes   int   `json:"session_idle_minutes"`
	SessionAbsoluteHours int   `json:"session_absolute_hours"`
	AuditRetentionDays   int   `json:"audit_retention_days"`
	MutationReason
}

func (input UpdatePolicyInput) Validate() error {
	if input.ExpectedRevision <= 0 || input.MutationReason.Validate() != nil {
		return ErrInvalidRequest
	}
	return Policy{
		SessionIdleMinutes: input.SessionIdleMinutes, SessionAbsoluteHours: input.SessionAbsoluteHours,
		AuditRetentionDays: input.AuditRetentionDays, Revision: input.ExpectedRevision,
	}.Validate()
}

type CreateReasonCodeInput struct {
	Code                     string         `json:"code"`
	Category                 ReasonCategory `json:"category"`
	Label                    string         `json:"label"`
	ExpectedSettingsRevision int64          `json:"expected_settings_revision"`
	MutationReason
}

func (input CreateReasonCodeInput) Validate() error {
	if !reasonCodePattern.MatchString(input.Code) || !input.Category.Valid() ||
		!validHumanText(input.Label, 1, 80) || input.ExpectedSettingsRevision <= 0 ||
		input.MutationReason.Validate() != nil {
		return ErrInvalidRequest
	}
	return nil
}

type UpdateReasonCodeInput struct {
	ExpectedSettingsRevision int64  `json:"expected_settings_revision"`
	ExpectedReasonRevision   int64  `json:"expected_reason_revision"`
	Label                    string `json:"label"`
	Active                   bool   `json:"active"`
	MutationReason
}

func (input UpdateReasonCodeInput) Validate() error {
	if input.ExpectedSettingsRevision <= 0 || input.ExpectedReasonRevision <= 0 ||
		!validHumanText(input.Label, 1, 80) || input.MutationReason.Validate() != nil {
		return ErrInvalidRequest
	}
	return nil
}

type PolicyMutationResult struct {
	OperationID     uuid.UUID `json:"operation_id"`
	Policy          Policy    `json:"policy"`
	SessionsRevoked bool      `json:"sessions_revoked"`
}

type ReasonMutationResult struct {
	OperationID      uuid.UUID  `json:"operation_id"`
	Reason           ReasonCode `json:"reason"`
	SettingsRevision int64      `json:"settings_revision"`
}

func validHumanText(value string, minimum, maximum int) bool {
	value = strings.TrimSpace(value)
	if !utf8.ValidString(value) {
		return false
	}
	count := utf8.RuneCountInString(value)
	if count < minimum || count > maximum || audit.ContainsSensitiveText(value) {
		return false
	}
	for _, character := range value {
		if unicode.IsControl(character) {
			return false
		}
	}
	return true
}

func validOptionalText(value string, maximum int) bool {
	if value == "" {
		return true
	}
	return validHumanText(value, 1, maximum)
}

func policyRequestDigest(input UpdatePolicyInput) [sha256.Size]byte {
	return canonicalDigest(
		strconv.FormatInt(input.ExpectedRevision, 10), strconv.Itoa(input.SessionIdleMinutes),
		strconv.Itoa(input.SessionAbsoluteHours), strconv.Itoa(input.AuditRetentionDays),
		input.ReasonCode, strings.TrimSpace(input.TicketReference), strings.TrimSpace(input.Note),
	)
}

func createReasonRequestDigest(input CreateReasonCodeInput) [sha256.Size]byte {
	return canonicalDigest(
		input.Code, string(input.Category), strings.TrimSpace(input.Label),
		strconv.FormatInt(input.ExpectedSettingsRevision, 10), input.ReasonCode,
		strings.TrimSpace(input.TicketReference), strings.TrimSpace(input.Note),
	)
}

func updateReasonRequestDigest(code string, input UpdateReasonCodeInput) [sha256.Size]byte {
	return canonicalDigest(
		code, strconv.FormatInt(input.ExpectedSettingsRevision, 10),
		strconv.FormatInt(input.ExpectedReasonRevision, 10), strings.TrimSpace(input.Label),
		strconv.FormatBool(input.Active), input.ReasonCode,
		strings.TrimSpace(input.TicketReference), strings.TrimSpace(input.Note),
	)
}

func canonicalDigest(parts ...string) [sha256.Size]byte {
	return sha256.Sum256([]byte(strings.Join(parts, "\x00")))
}
