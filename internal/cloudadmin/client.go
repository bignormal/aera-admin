package cloudadmin

import (
	"context"

	"github.com/google/uuid"
)

type Client interface {
	OfficialAgentClient
	Health(context.Context) (Health, error)
	Stats(context.Context) (PlatformStats, error)
	DeviceStats(context.Context) (DeviceStats, error)
	ListUsers(context.Context, ListUsersRequest) (Page[User], error)
	LookupUser(context.Context, LookupRequest) (User, error)
	GetUser(context.Context, uuid.UUID) (User, error)
	UserMemberships(context.Context, uuid.UUID) (UserMemberships, error)
	ListUserDevices(context.Context, uuid.UUID, PageRequest) (Page[Device], error)
	ListUserSessions(context.Context, uuid.UUID, PageRequest) (Page[Session], error)
	RevokeDevice(context.Context, uuid.UUID, CommandMeta) (Operation, error)
	RevokeSession(context.Context, uuid.UUID, CommandMeta) (Operation, error)
	RevokeAllSessions(context.Context, uuid.UUID, CommandMeta) (Operation, error)
	ForcePasswordReset(context.Context, uuid.UUID, CommandMeta) (Operation, error)
	DisableUser(context.Context, uuid.UUID, CommandMeta) (Operation, error)
	EnableUser(context.Context, uuid.UUID, CommandMeta) (Operation, error)
	GetOperation(context.Context, uuid.UUID) (Operation, error)
}

type CommandMeta struct {
	OperationID      uuid.UUID  `json:"operation_id"`
	ActorAdminID     uuid.UUID  `json:"actor_admin_id"`
	ApprovalID       *uuid.UUID `json:"approval_id,omitempty"`
	RequestID        string     `json:"request_id"`
	ReasonCode       string     `json:"reason_code"`
	TicketReference  string     `json:"ticket_reference,omitempty"`
	Note             string     `json:"note,omitempty"`
	ExpectedRevision int64      `json:"expected_revision"`
}

type DisabledClient struct{}

func (DisabledClient) Health(context.Context) (Health, error) {
	return Health{
		Configured: false, Availability: NotConfigured, MTLS: CheckNotChecked,
		ServiceJWT: CheckNotChecked, Upstream: CheckNotChecked,
	}, ErrNotConfigured
}

func (DisabledClient) ListUsers(context.Context, ListUsersRequest) (Page[User], error) {
	return Page[User]{}, ErrNotConfigured
}

func (DisabledClient) Stats(context.Context) (PlatformStats, error) {
	return PlatformStats{}, ErrNotConfigured
}

func (DisabledClient) DeviceStats(context.Context) (DeviceStats, error) {
	return DeviceStats{}, ErrNotConfigured
}

func (DisabledClient) LookupUser(context.Context, LookupRequest) (User, error) {
	return User{}, ErrNotConfigured
}

func (DisabledClient) GetUser(context.Context, uuid.UUID) (User, error) {
	return User{}, ErrNotConfigured
}

func (DisabledClient) UserMemberships(context.Context, uuid.UUID) (UserMemberships, error) {
	return UserMemberships{}, ErrNotConfigured
}

func (DisabledClient) ListUserDevices(context.Context, uuid.UUID, PageRequest) (Page[Device], error) {
	return Page[Device]{}, ErrNotConfigured
}

func (DisabledClient) ListUserSessions(context.Context, uuid.UUID, PageRequest) (Page[Session], error) {
	return Page[Session]{}, ErrNotConfigured
}

func (DisabledClient) RevokeDevice(context.Context, uuid.UUID, CommandMeta) (Operation, error) {
	return Operation{}, ErrNotConfigured
}

func (DisabledClient) RevokeSession(context.Context, uuid.UUID, CommandMeta) (Operation, error) {
	return Operation{}, ErrNotConfigured
}

func (DisabledClient) RevokeAllSessions(context.Context, uuid.UUID, CommandMeta) (Operation, error) {
	return Operation{}, ErrNotConfigured
}

func (DisabledClient) ForcePasswordReset(context.Context, uuid.UUID, CommandMeta) (Operation, error) {
	return Operation{}, ErrNotConfigured
}

func (DisabledClient) DisableUser(context.Context, uuid.UUID, CommandMeta) (Operation, error) {
	return Operation{}, ErrNotConfigured
}

func (DisabledClient) EnableUser(context.Context, uuid.UUID, CommandMeta) (Operation, error) {
	return Operation{}, ErrNotConfigured
}

func (DisabledClient) GetOperation(context.Context, uuid.UUID) (Operation, error) {
	return Operation{}, ErrNotConfigured
}

func (DisabledClient) ListOfficialDefinitions(context.Context, ActorContext, PageRequest) (Page[OfficialDefinition], error) {
	return Page[OfficialDefinition]{}, ErrNotConfigured
}

func (DisabledClient) GetOfficialDefinition(context.Context, ActorContext, uuid.UUID) (OfficialDefinitionDetail, error) {
	return OfficialDefinitionDetail{}, ErrNotConfigured
}

func (DisabledClient) ListOfficialDrafts(context.Context, ActorContext, PageRequest) (Page[OfficialDraft], error) {
	return Page[OfficialDraft]{}, ErrNotConfigured
}

func (DisabledClient) GetOfficialDraft(context.Context, ActorContext, uuid.UUID) (OfficialDraft, error) {
	return OfficialDraft{}, ErrNotConfigured
}

func (DisabledClient) ValidateOfficialDraft(context.Context, ActorContext, uuid.UUID) (OfficialDraftValidation, error) {
	return OfficialDraftValidation{}, ErrNotConfigured
}

func (DisabledClient) ListOfficialSubmissions(context.Context, ActorContext, OfficialSubmissionFilter) (Page[OfficialSubmission], error) {
	return Page[OfficialSubmission]{}, ErrNotConfigured
}

func (DisabledClient) GetOfficialSubmission(context.Context, ActorContext, uuid.UUID) (OfficialSubmission, error) {
	return OfficialSubmission{}, ErrNotConfigured
}

func (DisabledClient) ListOfficialVersions(context.Context, ActorContext, PageRequest) (Page[OfficialVersion], error) {
	return Page[OfficialVersion]{}, ErrNotConfigured
}

func (DisabledClient) GetOfficialVersion(context.Context, ActorContext, uuid.UUID) (OfficialVersion, error) {
	return OfficialVersion{}, ErrNotConfigured
}

func (DisabledClient) ListOfficialReleases(context.Context, ActorContext, PageRequest) (Page[OfficialRelease], error) {
	return Page[OfficialRelease]{}, ErrNotConfigured
}

func (DisabledClient) GetOfficialRelease(context.Context, ActorContext, uuid.UUID) (OfficialReleaseDetail, error) {
	return OfficialReleaseDetail{}, ErrNotConfigured
}

func (DisabledClient) ListOfficialAudit(context.Context, ActorContext, PageRequest) (Page[OfficialAuditEvent], error) {
	return Page[OfficialAuditEvent]{}, ErrNotConfigured
}

func (DisabledClient) ExecuteOfficialCommand(context.Context, ActorContext, OfficialCommand) (Operation, error) {
	return Operation{}, ErrNotConfigured
}
