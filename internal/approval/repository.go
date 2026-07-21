package approval

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"strings"
	"time"

	"github.com/bignormal/aera-admin/internal/admin"
	"github.com/bignormal/aera-admin/internal/audit"
	"github.com/bignormal/aera-admin/internal/cloudadmin"
	"github.com/bignormal/aera-admin/internal/rbac"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
)

const requestColumns = `
	id, action, target_user_id, target_snapshot, requested_by_admin_id, requested_by_role,
	reviewed_by_admin_id, reason_code, COALESCE(ticket_reference, ''), COALESCE(note, ''),
	expected_revision, approval_status, execution_status, operation_id, expires_at,
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
		return nil, errors.New("approval repository is unavailable")
	}
	tx, err := repository.postgres.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return nil, errors.New("approval transaction could not start")
	}
	return tx, nil
}

func lockRequest(ctx context.Context, tx pgx.Tx, id uuid.UUID) (Request, error) {
	if tx == nil || id == uuid.Nil {
		return Request{}, ErrInvalidRequest
	}
	return scanRequest(tx.QueryRow(ctx, `SELECT `+requestColumns+` FROM approval_requests WHERE id = $1 FOR UPDATE`, id))
}

func insertEvent(
	ctx context.Context,
	tx pgx.Tx,
	requestID uuid.UUID,
	actorID uuid.UUID,
	actorRole rbac.Role,
	eventType string,
	before string,
	after string,
	resultCode string,
	traceRequestID string,
	now time.Time,
) error {
	eventID, err := uuid.NewRandom()
	if err != nil {
		return errors.New("approval event identifier could not be generated")
	}
	_, err = tx.Exec(ctx, `
		INSERT INTO approval_events (
			id, approval_request_id, actor_admin_id, actor_role, event_type,
			before_status, after_status, result_code, request_id, created_at
		) VALUES ($1, $2, $3, $4, $5, $6, $7, NULLIF($8, ''), $9, $10)
	`, eventID, requestID, actorID, actorRole, eventType, before, after, resultCode, traceRequestID, now)
	if err != nil {
		return errors.New("approval event could not be stored")
	}
	return nil
}

func (repository *repository) InsertWithAudit(
	ctx context.Context,
	request Request,
	actor admin.Actor,
	reason admin.ActionReason,
	recorder *audit.Service,
) (Request, error) {
	snapshot, err := json.Marshal(request.TargetSnapshot)
	if err != nil {
		return Request{}, cloudadmin.ErrContractViolation
	}
	tx, err := repository.begin(ctx)
	if err != nil {
		return Request{}, err
	}
	defer func() { _ = tx.Rollback(context.Background()) }()
	_, err = tx.Exec(ctx, `
		INSERT INTO approval_requests (
			id, action, target_user_id, target_snapshot, requested_by_admin_id, requested_by_role,
			reason_code, ticket_reference, note, expected_revision, approval_status, execution_status,
			expires_at, created_at, updated_at, version
		) VALUES (
			$1, $2, $3, $4, $5, $6, $7, NULLIF($8, ''), NULLIF($9, ''), $10, $11, $12,
			$13, $14, $14, $15
		)
	`, request.ID, request.Action, request.TargetUserID, snapshot, request.RequestedByAdminID,
		request.RequestedByRole, request.ReasonCode, request.TicketReference, request.Note,
		request.ExpectedRevision, request.Status, request.ExecutionStatus, request.ExpiresAt,
		request.CreatedAt, request.Version)
	if err != nil {
		var databaseError *pgconn.PgError
		if errors.As(err, &databaseError) && databaseError.Code == "23505" {
			return Request{}, ErrStateConflict
		}
		return Request{}, errors.New("approval request could not be stored")
	}
	if err := insertEvent(
		ctx, tx, request.ID, actor.AdminID, actor.Role, "created", "", string(PendingReview),
		"", actor.Meta.RequestID, request.CreatedAt,
	); err != nil {
		return Request{}, err
	}
	if _, err := recorder.AppendTx(ctx, tx, audit.Record{
		ActorAdminID:    &actor.AdminID,
		ActorRole:       actor.Role,
		EventType:       "account_lifecycle_requested",
		ObjectType:      "cloud_user",
		ObjectID:        &request.TargetUserID,
		Outcome:         audit.OutcomeSuccess,
		ReasonCode:      reason.Code,
		TicketReference: reason.TicketReference,
		Note:            reason.Note,
		ApprovalID:      &request.ID,
		AfterState: map[string]string{
			"approval_status":  "pending_review",
			"execution_status": "not_started",
		},
		RequestID:    actor.Meta.RequestID,
		SourceIPHMAC: actor.Meta.SourceIPHMAC,
		UserAgent:    actor.Meta.UserAgent,
	}); err != nil {
		return Request{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return Request{}, errors.New("approval request could not be committed")
	}
	return repository.Get(ctx, actor, request.ID)
}

func scanRequest(row rowScanner) (Request, error) {
	var request Request
	var snapshot []byte
	err := row.Scan(
		&request.ID,
		&request.Action,
		&request.TargetUserID,
		&snapshot,
		&request.RequestedByAdminID,
		&request.RequestedByRole,
		&request.ReviewedByAdminID,
		&request.ReasonCode,
		&request.TicketReference,
		&request.Note,
		&request.ExpectedRevision,
		&request.Status,
		&request.ExecutionStatus,
		&request.OperationID,
		&request.ExpiresAt,
		&request.CreatedAt,
		&request.UpdatedAt,
		&request.Version,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return Request{}, ErrNotFound
	}
	if err != nil {
		return Request{}, errors.New("approval request could not be decoded")
	}
	decoder := json.NewDecoder(bytes.NewReader(snapshot))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&request.TargetSnapshot); err != nil {
		return Request{}, cloudadmin.ErrContractViolation
	}
	var extra any
	if err := decoder.Decode(&extra); !errors.Is(err, io.EOF) {
		return Request{}, cloudadmin.ErrContractViolation
	}
	if err := request.TargetSnapshot.Validate(); err != nil || request.TargetSnapshot.ID != request.TargetUserID ||
		request.TargetSnapshot.AdministrativeRevision != request.ExpectedRevision || request.ID == uuid.Nil ||
		request.RequestedByAdminID == uuid.Nil || request.RequestedByRole != rbac.Operator ||
		(request.Action != DisableUser && request.Action != EnableUser) || !request.Status.valid() ||
		!request.ExecutionStatus.valid() || request.Version <= 0 || request.CreatedAt.IsZero() ||
		request.UpdatedAt.Before(request.CreatedAt) || !request.ExpiresAt.After(request.CreatedAt) {
		return Request{}, cloudadmin.ErrContractViolation
	}
	return request, nil
}

func canSee(actor admin.Actor, request Request) bool {
	return actor.Role == rbac.SuperAdmin || (actor.Role == rbac.Operator && request.RequestedByAdminID == actor.AdminID)
}

func (repository *repository) Get(ctx context.Context, actor admin.Actor, id uuid.UUID) (Request, error) {
	if actor.AdminID == uuid.Nil || !actor.Role.Valid() || id == uuid.Nil {
		return Request{}, ErrInvalidRequest
	}
	request, err := scanRequest(repository.postgres.QueryRow(
		ctx, `SELECT `+requestColumns+` FROM approval_requests WHERE id = $1`, id,
	))
	if err != nil {
		return Request{}, err
	}
	if !canSee(actor, request) {
		return Request{}, ErrPermissionDenied
	}
	rows, err := repository.postgres.Query(ctx, `
		SELECT id, event_type, before_status, after_status, COALESCE(result_code, ''),
			actor_admin_id, actor_role, request_id, created_at
		FROM approval_events
		WHERE approval_request_id = $1
		ORDER BY created_at, id
	`, id)
	if err != nil {
		return Request{}, errors.New("approval events could not be listed")
	}
	defer rows.Close()
	request.Events = make([]Event, 0)
	for rows.Next() {
		var event Event
		if err := rows.Scan(
			&event.ID, &event.EventType, &event.BeforeStatus, &event.AfterStatus,
			&event.ResultCode, &event.ActorAdminID, &event.ActorRole, &event.RequestID, &event.CreatedAt,
		); err != nil {
			return Request{}, errors.New("approval event could not be decoded")
		}
		request.Events = append(request.Events, event)
	}
	if err := rows.Err(); err != nil {
		return Request{}, errors.New("approval events could not be read")
	}
	return request, nil
}

type approvalCursor struct {
	CreatedAt time.Time
	ID        uuid.UUID
}

func encodeApprovalCursor(value approvalCursor) string {
	return base64.RawURLEncoding.EncodeToString([]byte(
		value.CreatedAt.UTC().Format(time.RFC3339Nano) + "|" + value.ID.String(),
	))
}

func decodeApprovalCursor(raw string) (*approvalCursor, error) {
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
	return &approvalCursor{CreatedAt: createdAt, ID: id}, nil
}

func (repository *repository) List(ctx context.Context, actor admin.Actor, filter ListFilter) (Page, error) {
	if actor.AdminID == uuid.Nil || (actor.Role != rbac.Operator && actor.Role != rbac.SuperAdmin) {
		return Page{}, ErrPermissionDenied
	}
	if filter.Limit < 1 || filter.Limit > 100 {
		return Page{}, ErrInvalidRequest
	}
	cursor, err := decodeApprovalCursor(filter.Cursor)
	if err != nil {
		return Page{}, err
	}
	view := filter.View
	if actor.Role == rbac.Operator {
		view = "mine"
	}
	if view != "mine" && view != "pending_for_me" && view != "all" {
		return Page{}, ErrInvalidRequest
	}
	var cursorTime any
	var cursorID any
	if cursor != nil {
		cursorTime, cursorID = cursor.CreatedAt, cursor.ID
	}
	rows, err := repository.postgres.Query(ctx, `
		SELECT `+requestColumns+`
		FROM approval_requests
		WHERE ($1 <> 'mine' OR requested_by_admin_id = $2)
		  AND ($1 <> 'pending_for_me' OR (approval_status = 'pending_review' AND requested_by_admin_id <> $2))
		  AND ($3::timestamptz IS NULL OR (created_at, id) < ($3, $4::uuid))
		ORDER BY created_at DESC, id DESC
		LIMIT $5
	`, view, actor.AdminID, cursorTime, cursorID, filter.Limit+1)
	if err != nil {
		return Page{}, errors.New("approval requests could not be listed")
	}
	defer rows.Close()
	items := make([]Request, 0, filter.Limit+1)
	for rows.Next() {
		item, err := scanRequest(rows)
		if err != nil {
			return Page{}, err
		}
		items = append(items, item)
	}
	if err := rows.Err(); err != nil {
		return Page{}, errors.New("approval requests could not be read")
	}
	page := Page{Items: items}
	if len(items) > filter.Limit {
		page.Items = items[:filter.Limit]
		last := page.Items[len(page.Items)-1]
		page.NextCursor = encodeApprovalCursor(approvalCursor{CreatedAt: last.CreatedAt, ID: last.ID})
	}
	return page, nil
}
