package cloudadmin

import (
	"context"

	"github.com/google/uuid"
)

type Client interface {
	Health(context.Context) (Health, error)
	ListUsers(context.Context, ListUsersRequest) (Page[User], error)
	LookupUser(context.Context, LookupRequest) (User, error)
	GetUser(context.Context, uuid.UUID) (User, error)
	ListUserDevices(context.Context, uuid.UUID, PageRequest) (Page[Device], error)
	ListUserSessions(context.Context, uuid.UUID, PageRequest) (Page[Session], error)
	RevokeDevice(context.Context, uuid.UUID, CommandMeta) (Operation, error)
	RevokeSession(context.Context, uuid.UUID, CommandMeta) (Operation, error)
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

func (DisabledClient) LookupUser(context.Context, LookupRequest) (User, error) {
	return User{}, ErrNotConfigured
}

func (DisabledClient) GetUser(context.Context, uuid.UUID) (User, error) {
	return User{}, ErrNotConfigured
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

func (DisabledClient) DisableUser(context.Context, uuid.UUID, CommandMeta) (Operation, error) {
	return Operation{}, ErrNotConfigured
}

func (DisabledClient) EnableUser(context.Context, uuid.UUID, CommandMeta) (Operation, error) {
	return Operation{}, ErrNotConfigured
}

func (DisabledClient) GetOperation(context.Context, uuid.UUID) (Operation, error) {
	return Operation{}, ErrNotConfigured
}
