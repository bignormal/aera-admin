package audit

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"time"

	"github.com/bignormal/aera-admin/internal/rbac"
	"github.com/google/uuid"
)

var ErrInvalidQuery = errors.New("administrator audit query is invalid")

type Query struct {
	Cursor       string
	Limit        int
	ActorAdminID *uuid.UUID
	EventType    string
	ObjectType   string
	ObjectID     *uuid.UUID
	Outcome      Outcome
	ReasonCode   string
	From         time.Time
	To           time.Time
}

type PublicEvent struct {
	ID              uuid.UUID         `json:"id"`
	ActorAdminID    *uuid.UUID        `json:"actor_admin_id"`
	ActorRole       rbac.Role         `json:"actor_role,omitempty"`
	EventType       string            `json:"event_type"`
	ObjectType      string            `json:"object_type"`
	ObjectID        *uuid.UUID        `json:"object_id"`
	Outcome         Outcome           `json:"outcome"`
	ReasonCode      string            `json:"reason_code,omitempty"`
	TicketReference string            `json:"ticket_reference,omitempty"`
	Note            string            `json:"note,omitempty"`
	ApprovalID      *uuid.UUID        `json:"approval_id"`
	OperationID     *uuid.UUID        `json:"operation_id"`
	ErrorCode       string            `json:"error_code,omitempty"`
	BeforeState     map[string]string `json:"before_state,omitempty"`
	AfterState      map[string]string `json:"after_state,omitempty"`
	RequestID       string            `json:"request_id"`
	CreatedAt       time.Time         `json:"created_at"`
}

type Page struct {
	Items      []PublicEvent `json:"items"`
	NextCursor *string       `json:"next_cursor"`
}

type cursorDocument struct {
	CreatedAt string `json:"created_at"`
	ID        string `json:"id"`
}

func (query Query) Validate() error {
	if query.Limit < 1 || query.Limit > 100 ||
		(query.ActorAdminID != nil && *query.ActorAdminID == uuid.Nil) ||
		(query.ObjectID != nil && *query.ObjectID == uuid.Nil) ||
		(query.EventType != "" && !namePattern.MatchString(query.EventType)) ||
		(query.ObjectType != "" && !namePattern.MatchString(query.ObjectType)) ||
		(query.Outcome != "" && query.Outcome != OutcomeSuccess && query.Outcome != OutcomeFailure && query.Outcome != OutcomeDenied) ||
		(query.ReasonCode != "" && !reasonPattern.MatchString(query.ReasonCode)) ||
		(!query.From.IsZero() && !query.To.IsZero() && !query.From.Before(query.To)) {
		return ErrInvalidQuery
	}
	if query.Cursor != "" {
		if _, _, err := DecodeCursor(query.Cursor); err != nil {
			return ErrInvalidQuery
		}
	}
	return nil
}

func EncodeCursor(createdAt time.Time, id uuid.UUID) string {
	document := cursorDocument{
		CreatedAt: createdAt.UTC().Truncate(time.Microsecond).Format(time.RFC3339Nano),
		ID:        id.String(),
	}
	encoded, _ := json.Marshal(document)
	return base64.RawURLEncoding.EncodeToString(encoded)
}

func DecodeCursor(cursor string) (time.Time, uuid.UUID, error) {
	if cursor == "" || len(cursor) > 512 {
		return time.Time{}, uuid.Nil, ErrInvalidQuery
	}
	decoded, err := base64.RawURLEncoding.DecodeString(cursor)
	if err != nil || len(decoded) == 0 || len(decoded) > 256 {
		return time.Time{}, uuid.Nil, ErrInvalidQuery
	}
	decoder := json.NewDecoder(bytes.NewReader(decoded))
	decoder.DisallowUnknownFields()
	var document cursorDocument
	if err := decoder.Decode(&document); err != nil {
		return time.Time{}, uuid.Nil, ErrInvalidQuery
	}
	if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		return time.Time{}, uuid.Nil, ErrInvalidQuery
	}
	createdAt, err := time.Parse(time.RFC3339Nano, document.CreatedAt)
	if err != nil || createdAt.IsZero() {
		return time.Time{}, uuid.Nil, ErrInvalidQuery
	}
	createdAt = createdAt.UTC()
	if createdAt != createdAt.Truncate(time.Microsecond) {
		return time.Time{}, uuid.Nil, ErrInvalidQuery
	}
	id, err := uuid.Parse(document.ID)
	if err != nil || id == uuid.Nil {
		return time.Time{}, uuid.Nil, ErrInvalidQuery
	}
	return createdAt, id, nil
}
