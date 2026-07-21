package audit

import (
	"context"
	"encoding/json"
	"errors"
	"time"

	"github.com/bignormal/aera-admin/internal/rbac"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

const auditChainAdvisoryLockID int64 = 0x41455241415544

func lockAuditActor(ctx context.Context, tx pgx.Tx, actorID *uuid.UUID) error {
	if actorID == nil {
		return nil
	}
	var lockedID uuid.UUID
	if err := tx.QueryRow(ctx, `
		SELECT id
		FROM admin_users
		WHERE id = $1
		FOR KEY SHARE
	`, *actorID).Scan(&lockedID); err != nil {
		return errors.New("administrator audit actor could not be locked")
	}
	return nil
}

func lockAuditChain(ctx context.Context, tx pgx.Tx) error {
	if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock($1)`, auditChainAdvisoryLockID); err != nil {
		return errors.New("administrator audit chain lock could not be acquired")
	}
	return nil
}

func latestAuditHash(ctx context.Context, tx pgx.Tx) ([]byte, time.Time, error) {
	var eventHash []byte
	var createdAt time.Time
	err := tx.QueryRow(ctx, `
		SELECT event_hash, created_at
		FROM admin_audit_events
		ORDER BY created_at DESC, id DESC
		LIMIT 1
	`).Scan(&eventHash, &createdAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return make([]byte, 32), time.Time{}, nil
	}
	if err != nil {
		return nil, time.Time{}, errors.New("administrator audit chain head could not be read")
	}
	if len(eventHash) != 32 {
		return nil, time.Time{}, ErrIntegrity
	}
	return append([]byte(nil), eventHash...), createdAt.UTC(), nil
}

func insertAuditEvent(ctx context.Context, tx pgx.Tx, event auditEvent) error {
	beforeState, err := marshalState(event.Record.BeforeState)
	if err != nil {
		return ErrInvalidRecord
	}
	afterState, err := marshalState(event.Record.AfterState)
	if err != nil {
		return ErrInvalidRecord
	}
	_, err = tx.Exec(ctx, `
		INSERT INTO admin_audit_events (
			id, actor_admin_id, actor_role, event_type, object_type, object_id,
			outcome, reason_code, ticket_reference, note, approval_id, operation_id,
			error_code, before_state, after_state, request_id, source_ip_hmac,
			user_agent, previous_hash, event_hash, created_at
		) VALUES (
			$1, $2, $3, $4, $5, $6,
			$7, $8, $9, $10, $11, $12,
			$13, $14::jsonb, $15::jsonb, $16, $17,
			$18, $19, $20, $21
		)
	`,
		event.ID,
		event.Record.ActorAdminID,
		nullableString(string(event.Record.ActorRole)),
		event.Record.EventType,
		event.Record.ObjectType,
		event.Record.ObjectID,
		event.Record.Outcome,
		nullableString(event.Record.ReasonCode),
		nullableString(event.Record.TicketReference),
		nullableString(event.Record.Note),
		event.Record.ApprovalID,
		event.Record.OperationID,
		nullableString(event.Record.ErrorCode),
		beforeState,
		afterState,
		event.Record.RequestID,
		nullableBytes(event.Record.SourceIPHMAC),
		nullableString(event.Record.UserAgent),
		event.PreviousHash,
		event.EventHash,
		event.CreatedAt,
	)
	if err != nil {
		return errors.New("administrator audit event could not be appended")
	}
	return nil
}

func loadAuditEvents(ctx context.Context, tx pgx.Tx) ([]auditEvent, error) {
	rows, err := tx.Query(ctx, `
		SELECT
			id,
			COALESCE(actor_admin_id::text, ''),
			COALESCE(actor_role, ''),
			event_type,
			object_type,
			COALESCE(object_id::text, ''),
			outcome,
			COALESCE(reason_code, ''),
			COALESCE(ticket_reference, ''),
			COALESCE(note, ''),
			COALESCE(approval_id::text, ''),
			COALESCE(operation_id::text, ''),
			COALESCE(error_code, ''),
			COALESCE(before_state, '{}'::jsonb)::text,
			COALESCE(after_state, '{}'::jsonb)::text,
			request_id,
			source_ip_hmac,
			COALESCE(user_agent, ''),
			previous_hash,
			event_hash,
			created_at
		FROM admin_audit_events
		ORDER BY created_at, id
	`)
	if err != nil {
		return nil, errors.New("administrator audit chain could not be read")
	}
	defer rows.Close()

	events := make([]auditEvent, 0)
	for rows.Next() {
		var event auditEvent
		var actorID, objectID, approvalID, operationID string
		var actorRole string
		var beforeState, afterState string
		if err := rows.Scan(
			&event.ID,
			&actorID,
			&actorRole,
			&event.Record.EventType,
			&event.Record.ObjectType,
			&objectID,
			&event.Record.Outcome,
			&event.Record.ReasonCode,
			&event.Record.TicketReference,
			&event.Record.Note,
			&approvalID,
			&operationID,
			&event.Record.ErrorCode,
			&beforeState,
			&afterState,
			&event.Record.RequestID,
			&event.Record.SourceIPHMAC,
			&event.Record.UserAgent,
			&event.PreviousHash,
			&event.EventHash,
			&event.CreatedAt,
		); err != nil {
			return nil, errors.New("administrator audit chain contains an unreadable event")
		}
		event.Record.ActorRole = rbac.Role(actorRole)
		if event.Record.ActorAdminID, err = parseOptionalUUID(actorID); err != nil {
			return nil, ErrIntegrity
		}
		if event.Record.ObjectID, err = parseOptionalUUID(objectID); err != nil {
			return nil, ErrIntegrity
		}
		if event.Record.ApprovalID, err = parseOptionalUUID(approvalID); err != nil {
			return nil, ErrIntegrity
		}
		if event.Record.OperationID, err = parseOptionalUUID(operationID); err != nil {
			return nil, ErrIntegrity
		}
		if err := json.Unmarshal([]byte(beforeState), &event.Record.BeforeState); err != nil {
			return nil, ErrIntegrity
		}
		if len(event.Record.BeforeState) == 0 {
			event.Record.BeforeState = nil
		}
		if err := json.Unmarshal([]byte(afterState), &event.Record.AfterState); err != nil {
			return nil, ErrIntegrity
		}
		if len(event.Record.AfterState) == 0 {
			event.Record.AfterState = nil
		}
		event.CreatedAt = event.CreatedAt.UTC().Truncate(time.Microsecond)
		events = append(events, event)
	}
	if err := rows.Err(); err != nil {
		return nil, errors.New("administrator audit chain could not be read")
	}
	return events, nil
}

func marshalState(state map[string]string) (any, error) {
	if len(state) == 0 {
		return nil, nil
	}
	encoded, err := json.Marshal(state)
	if err != nil {
		return nil, err
	}
	return string(encoded), nil
}

func parseOptionalUUID(raw string) (*uuid.UUID, error) {
	if raw == "" {
		return nil, nil
	}
	parsed, err := uuid.Parse(raw)
	if err != nil || parsed == uuid.Nil {
		return nil, ErrIntegrity
	}
	return &parsed, nil
}

func nullableString(value string) any {
	if value == "" {
		return nil
	}
	return value
}

func nullableBytes(value []byte) any {
	if len(value) == 0 {
		return nil
	}
	return value
}
