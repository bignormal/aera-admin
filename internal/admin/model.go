package admin

import (
	"errors"
	"time"

	"github.com/bignormal/aera-admin/internal/rbac"
	"github.com/google/uuid"
)

var (
	ErrInvalidRequest        = errors.New("administrator request is invalid")
	ErrInvalidInvitation     = errors.New("administrator invitation is invalid")
	ErrInvalidActivation     = errors.New("administrator activation is invalid")
	ErrIdentityExists        = errors.New("administrator identity already exists")
	ErrBootstrapIncomplete   = errors.New("administrator bootstrap is incomplete")
	ErrBootstrapComplete     = errors.New("administrator bootstrap is complete")
	ErrMinimumSuperAdmins    = errors.New("at least two active super administrators are required")
	ErrSelfManagement        = errors.New("administrators cannot perform this action on themselves")
	ErrPermissionDenied      = errors.New("administrator permission is denied")
	ErrAdministratorNotFound = errors.New("administrator was not found")
	ErrStateConflict         = errors.New("administrator state has changed")
)

type Status string

const (
	StatusInvited   Status = "invited"
	StatusActive    Status = "active"
	StatusSuspended Status = "suspended"
)

type InvitationPurpose string

const (
	InvitationPurposeActivation InvitationPurpose = "activation"
	InvitationPurposeTOTPReset  InvitationPurpose = "totp_reset"
)

type RequestMeta struct {
	RequestID    string
	SourceIPHMAC []byte
	UserAgent    string
}

type ActionReason struct {
	Code            string
	TicketReference string
	Note            string
	Meta            RequestMeta
}

type Actor struct {
	AdminID uuid.UUID
	Role    rbac.Role
	Meta    RequestMeta
}

type InviteRequest struct {
	Email       string
	DisplayName string
	Role        rbac.Role
	Reason      ActionReason
}

type InvitationResult struct {
	InvitationID  uuid.UUID `json:"invitation_id"`
	AdminID       uuid.UUID `json:"admin_id"`
	ActivationURL string    `json:"activation_url"`
	ExpiresAt     time.Time `json:"expires_at"`
}

type ActivationPreparation struct {
	AdminID         uuid.UUID         `json:"admin_id"`
	DisplayName     string            `json:"display_name"`
	MaskedIdentity  string            `json:"masked_identity"`
	Purpose         InvitationPurpose `json:"purpose"`
	ProvisioningURI string            `json:"provisioning_uri"`
	ExpiresAt       time.Time         `json:"expires_at"`
}

type ActivateRequest struct {
	Token    string
	Password string
	TOTPCode string
	Meta     RequestMeta
}

type ActivationResult struct {
	AdminID       uuid.UUID `json:"admin_id"`
	RecoveryCodes []string  `json:"recovery_codes"`
}

type Administrator struct {
	ID              uuid.UUID  `json:"id"`
	MaskedIdentity  string     `json:"masked_identity"`
	DisplayName     string     `json:"display_name"`
	Role            rbac.Role  `json:"role"`
	Status          Status     `json:"status"`
	MFAEnabled      bool       `json:"mfa_enabled"`
	SecurityVersion int64      `json:"security_version"`
	LastLoginAt     *time.Time `json:"last_login_at,omitempty"`
	CreatedAt       time.Time  `json:"created_at"`
	UpdatedAt       time.Time  `json:"updated_at"`
}
