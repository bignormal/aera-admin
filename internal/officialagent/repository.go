package officialagent

import (
	"context"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"strings"
	"time"

	"github.com/bignormal/aera-admin/internal/admin"
	"github.com/bignormal/aera-admin/internal/audit"
	"github.com/bignormal/aera-admin/internal/operations"
	"github.com/bignormal/aera-admin/internal/rbac"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
)

const rollbackColumns = `
	id, release_id, target_version_id, target_release_revision_id,
	expected_head_revision, target_digest, requested_by_admin_id, reviewed_by_admin_id,
	reason_code, COALESCE(ticket_reference, ''), COALESCE(safe_note, ''),
	approval_status, execution_status, operation_id, expires_at, reviewed_at,
	created_at, updated_at, version
`

type repository struct {
	postgres *pgxpool.Pool
}

type rowScanner interface {
	Scan(...any) error
}

func (repository *repository) begin(ctx context.Context) (pgx.Tx, error) {
	if repository == nil || repository.postgres == nil {
		return nil, errors.New("official Agent repository is unavailable")
	}
	tx, err := repository.postgres.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return nil, errors.New("official Agent transaction could not start")
	}
	return tx, nil
}

func lockRollback(ctx context.Context, tx pgx.Tx, id uuid.UUID) (RollbackApproval, error) {
	if tx == nil || id == uuid.Nil {
		return RollbackApproval{}, ErrInvalidRequest
	}
	return scanRollback(tx.QueryRow(ctx, `SELECT `+rollbackColumns+` FROM official_agent_rollback_requests WHERE id = $1 FOR UPDATE`, id))
}

func scanRollback(row rowScanner) (RollbackApproval, error) {
	var approval RollbackApproval
	var targetDigest []byte
	err := row.Scan(
		&approval.ID, &approval.ReleaseID, &approval.TargetVersionID, &approval.TargetReleaseRevisionID,
		&approval.ExpectedHeadRevision, &targetDigest, &approval.RequestedByAdminID, &approval.ReviewedByAdminID,
		&approval.ReasonCode, &approval.TicketReference, &approval.SafeNote,
		&approval.ApprovalStatus, &approval.ExecutionStatus, &approval.OperationID, &approval.ExpiresAt,
		&approval.ReviewedAt, &approval.CreatedAt, &approval.UpdatedAt, &approval.Version,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return RollbackApproval{}, ErrNotFound
	}
	if err != nil {
		return RollbackApproval{}, errors.New("official Agent rollback request could not be decoded")
	}
	approval.TargetDigest = hex.EncodeToString(targetDigest)
	if approval.ID == uuid.Nil || approval.ReleaseID == uuid.Nil || approval.TargetVersionID == uuid.Nil ||
		approval.TargetReleaseRevisionID == uuid.Nil || approval.ExpectedHeadRevision <= 0 ||
		!digestPattern.MatchString(approval.TargetDigest) || approval.RequestedByAdminID == uuid.Nil ||
		!reasonCodePattern.MatchString(approval.ReasonCode) || !approval.ApprovalStatus.valid() ||
		!approval.ExecutionStatus.valid() || approval.Version <= 0 || approval.CreatedAt.IsZero() ||
		approval.UpdatedAt.Before(approval.CreatedAt) || !approval.ExpiresAt.After(approval.CreatedAt) ||
		(approval.ReviewedByAdminID != nil && *approval.ReviewedByAdminID == approval.RequestedByAdminID) {
		return RollbackApproval{}, errors.New("official Agent rollback request contains invalid state")
	}
	return approval, nil
}

func insertRollbackEvent(
	ctx context.Context,
	tx pgx.Tx,
	approval RollbackApproval,
	eventType string,
	actor admin.Actor,
	errorCode string,
	now time.Time,
) error {
	eventID, err := uuid.NewRandom()
	if err != nil {
		return errors.New("official Agent rollback event identifier could not be generated")
	}
	_, err = tx.Exec(ctx, `
		INSERT INTO official_agent_rollback_events (
			id, rollback_request_id, event_type, actor_admin_id, actor_role,
			approval_status, execution_status, operation_id, error_code, created_at
		) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NULLIF($9, ''), $10)
	`, eventID, approval.ID, eventType, actor.AdminID, actor.Role, approval.ApprovalStatus,
		approval.ExecutionStatus, approval.OperationID, errorCode, now.UTC())
	if err != nil {
		return errors.New("official Agent rollback event could not be stored")
	}
	return nil
}

func (repository *repository) insertRollbackWithAudit(
	ctx context.Context,
	approval RollbackApproval,
	actor admin.Actor,
	reason admin.ActionReason,
	recorder *audit.Service,
) (RollbackApproval, error) {
	targetDigest, err := hex.DecodeString(approval.TargetDigest)
	if err != nil || len(targetDigest) != 32 {
		return RollbackApproval{}, ErrInvalidRequest
	}
	tx, err := repository.begin(ctx)
	if err != nil {
		return RollbackApproval{}, err
	}
	defer func() { _ = tx.Rollback(context.Background()) }()
	_, err = tx.Exec(ctx, `
		INSERT INTO official_agent_rollback_requests (
			id, release_id, target_version_id, target_release_revision_id,
			expected_head_revision, target_digest, requested_by_admin_id,
			reason_code, ticket_reference, safe_note, approval_status, execution_status,
			expires_at, created_at, updated_at, version
		) VALUES (
			$1, $2, $3, $4, $5, $6, $7, $8, NULLIF($9, ''), NULLIF($10, ''),
			$11, $12, $13, $14, $14, $15
		)
	`, approval.ID, approval.ReleaseID, approval.TargetVersionID, approval.TargetReleaseRevisionID,
		approval.ExpectedHeadRevision, targetDigest, approval.RequestedByAdminID, approval.ReasonCode,
		approval.TicketReference, approval.SafeNote, approval.ApprovalStatus, approval.ExecutionStatus,
		approval.ExpiresAt, approval.CreatedAt, approval.Version)
	if err != nil {
		var databaseError *pgconn.PgError
		if errors.As(err, &databaseError) && databaseError.Code == "23505" {
			return RollbackApproval{}, ErrStateConflict
		}
		return RollbackApproval{}, errors.New("official Agent rollback request could not be stored")
	}
	if err := insertRollbackEvent(ctx, tx, approval, "requested", actor, "", approval.CreatedAt); err != nil {
		return RollbackApproval{}, err
	}
	if _, err := recorder.AppendTx(ctx, tx, audit.Record{
		ActorAdminID: &actor.AdminID, ActorRole: actor.Role,
		EventType: "official_release_rollback_requested", ObjectType: "official_release",
		ObjectID: &approval.ReleaseID, Outcome: audit.OutcomeSuccess,
		ReasonCode: reason.Code, TicketReference: reason.TicketReference, Note: reason.Note,
		ApprovalID: &approval.ID,
		AfterState: map[string]string{"approval_status": "pending_review", "execution_status": "not_started"},
		RequestID:  actor.Meta.RequestID, SourceIPHMAC: actor.Meta.SourceIPHMAC, UserAgent: actor.Meta.UserAgent,
	}); err != nil {
		return RollbackApproval{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return RollbackApproval{}, errors.New("official Agent rollback request could not be committed")
	}
	return repository.GetRollback(ctx, actor, approval.ID)
}

func (repository *repository) GetRollback(ctx context.Context, actor admin.Actor, id uuid.UUID) (RollbackApproval, error) {
	if actor.AdminID == uuid.Nil || !actor.Role.Valid() || id == uuid.Nil {
		return RollbackApproval{}, ErrInvalidRequest
	}
	approval, err := scanRollback(repository.postgres.QueryRow(
		ctx, `SELECT `+rollbackColumns+` FROM official_agent_rollback_requests WHERE id = $1`, id,
	))
	if err != nil {
		return RollbackApproval{}, err
	}
	if actor.Role != rbac.SuperAdmin && actor.Role != rbac.Auditor && actor.AdminID != approval.RequestedByAdminID {
		return RollbackApproval{}, ErrPermissionDenied
	}
	rows, err := repository.postgres.Query(ctx, `
		SELECT id, event_type, actor_admin_id, actor_role, approval_status,
			execution_status, operation_id, COALESCE(error_code, ''), created_at
		FROM official_agent_rollback_events
		WHERE rollback_request_id = $1
		ORDER BY created_at, id
	`, id)
	if err != nil {
		return RollbackApproval{}, errors.New("official Agent rollback events could not be listed")
	}
	defer rows.Close()
	approval.Events = make([]RollbackEvent, 0)
	for rows.Next() {
		var event RollbackEvent
		if err := rows.Scan(
			&event.ID, &event.EventType, &event.ActorAdminID, &event.ActorRole,
			&event.ApprovalStatus, &event.ExecutionStatus, &event.OperationID, &event.ErrorCode, &event.CreatedAt,
		); err != nil {
			return RollbackApproval{}, errors.New("official Agent rollback event could not be decoded")
		}
		approval.Events = append(approval.Events, event)
	}
	if rows.Err() != nil {
		return RollbackApproval{}, errors.New("official Agent rollback events could not be read")
	}
	return approval, nil
}

type rollbackCursor struct {
	CreatedAt time.Time
	ID        uuid.UUID
}

func encodeRollbackCursor(value rollbackCursor) string {
	return base64.RawURLEncoding.EncodeToString([]byte(
		value.CreatedAt.UTC().Format(time.RFC3339Nano) + "|" + value.ID.String(),
	))
}

func decodeRollbackCursor(raw string) (*rollbackCursor, error) {
	if raw == "" {
		return nil, nil
	}
	decoded, err := base64.RawURLEncoding.DecodeString(raw)
	if err != nil || len(decoded) > 128 {
		return nil, ErrInvalidRequest
	}
	parts := strings.Split(string(decoded), "|")
	if len(parts) != 2 {
		return nil, ErrInvalidRequest
	}
	createdAt, err := time.Parse(time.RFC3339Nano, parts[0])
	if err != nil {
		return nil, ErrInvalidRequest
	}
	id, err := uuid.Parse(parts[1])
	if err != nil || id == uuid.Nil {
		return nil, ErrInvalidRequest
	}
	return &rollbackCursor{CreatedAt: createdAt, ID: id}, nil
}

func (repository *repository) ListRollbacks(ctx context.Context, actor admin.Actor, filter ListFilter) (RollbackPage, error) {
	if actor.AdminID == uuid.Nil || (actor.Role != rbac.Operator && actor.Role != rbac.SuperAdmin && actor.Role != rbac.Auditor) {
		return RollbackPage{}, ErrPermissionDenied
	}
	if filter.Limit < 1 || filter.Limit > 100 {
		return RollbackPage{}, ErrInvalidRequest
	}
	cursor, err := decodeRollbackCursor(filter.Cursor)
	if err != nil {
		return RollbackPage{}, err
	}
	view := filter.View
	if actor.Role == rbac.Operator {
		view = "mine"
	}
	if actor.Role == rbac.Auditor {
		view = "all"
	}
	if view != "mine" && view != "pending_for_me" && view != "all" {
		return RollbackPage{}, ErrInvalidRequest
	}
	var cursorTime any
	var cursorID any
	if cursor != nil {
		cursorTime, cursorID = cursor.CreatedAt, cursor.ID
	}
	rows, err := repository.postgres.Query(ctx, `
		SELECT `+rollbackColumns+`
		FROM official_agent_rollback_requests
		WHERE ($1 <> 'mine' OR requested_by_admin_id = $2)
		  AND ($1 <> 'pending_for_me' OR (approval_status = 'pending_review' AND requested_by_admin_id <> $2))
		  AND ($3::timestamptz IS NULL OR (created_at, id) < ($3, $4::uuid))
		ORDER BY created_at DESC, id DESC
		LIMIT $5
	`, view, actor.AdminID, cursorTime, cursorID, filter.Limit+1)
	if err != nil {
		return RollbackPage{}, errors.New("official Agent rollback requests could not be listed")
	}
	defer rows.Close()
	items := make([]RollbackApproval, 0, filter.Limit+1)
	for rows.Next() {
		item, err := scanRollback(rows)
		if err != nil {
			return RollbackPage{}, err
		}
		items = append(items, item)
	}
	if rows.Err() != nil {
		return RollbackPage{}, errors.New("official Agent rollback requests could not be read")
	}
	page := RollbackPage{Items: items}
	if len(items) > filter.Limit {
		page.Items = items[:filter.Limit]
		last := page.Items[len(page.Items)-1]
		page.NextCursor = encodeRollbackCursor(rollbackCursor{CreatedAt: last.CreatedAt, ID: last.ID})
	}
	return page, nil
}

var _ operations.ExecutionSink = (*Service)(nil)
