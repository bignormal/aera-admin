package operations

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"crypto/subtle"
	"errors"
	"time"

	"github.com/bignormal/aera-admin/internal/admin"
	"github.com/bignormal/aera-admin/internal/audit"
	"github.com/bignormal/aera-admin/internal/rbac"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

type TransactionalEnqueuer interface {
	EnqueueTx(context.Context, pgx.Tx, EnqueueRequest) (Result, error)
}

type repository struct {
	postgres *pgxpool.Pool
	hmacKey  []byte
	audit    *audit.Service
	clock    func() time.Time
}

func newRepository(postgres *pgxpool.Pool, hmacKey []byte, recorder *audit.Service, clock func() time.Time) (*repository, error) {
	if postgres == nil || len(hmacKey) < 32 || recorder == nil || clock == nil {
		return nil, errors.New("operation repository dependencies are required")
	}
	return &repository{
		postgres: postgres,
		hmacKey:  append([]byte(nil), hmacKey...),
		audit:    recorder,
		clock:    clock,
	}, nil
}

func (repository *repository) Enqueue(ctx context.Context, request EnqueueRequest) (Result, error) {
	tx, err := repository.postgres.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return Result{}, errors.New("operation transaction could not start")
	}
	defer func() { _ = tx.Rollback(context.Background()) }()
	result, err := repository.EnqueueTx(ctx, tx, request)
	if err != nil {
		return Result{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return Result{}, errors.New("operation could not be committed")
	}
	return result, nil
}

func (repository *repository) EnqueueTx(ctx context.Context, tx pgx.Tx, request EnqueueRequest) (Result, error) {
	if repository == nil || tx == nil {
		return Result{}, ErrInvalidRequest
	}
	if err := request.validate(); err != nil {
		return Result{}, err
	}
	if !rbac.Allowed(request.Actor.Role, permissionFor(request.Action)) {
		return Result{}, ErrPermissionDenied
	}

	keyMAC := hmac.New(sha256.New, repository.hmacKey)
	_, _ = keyMAC.Write([]byte("aera-admin.operation-idempotency.v1\x00" + request.BrowserIdempotencyKey))
	keyDigest := keyMAC.Sum(nil)
	semanticDigest := requestDigest(request)
	now := repository.clock().UTC()
	operationID, err := uuid.NewRandom()
	if err != nil {
		return Result{}, errors.New("operation identifier could not be generated")
	}
	command, err := tx.Exec(ctx, `
		INSERT INTO admin_idempotency_records (
			operation_id, actor_admin_id, action, idempotency_key_hmac, request_hash,
			state, created_at, updated_at, expires_at
		) VALUES ($1, $2, $3, $4, $5, 'queued', $6, $6, $7)
		ON CONFLICT (actor_admin_id, action, idempotency_key_hmac) DO NOTHING
	`, operationID, request.Actor.AdminID, request.Action, keyDigest, semanticDigest[:], now, now.Add(30*24*time.Hour))
	if err != nil {
		return Result{}, errors.New("idempotency record could not be stored")
	}
	if command.RowsAffected() == 0 {
		var existing Result
		var existingHash []byte
		err := tx.QueryRow(ctx, `
			SELECT operation_id, state, COALESCE(error_code, ''), updated_at, request_hash
			FROM admin_idempotency_records
			WHERE actor_admin_id = $1 AND action = $2 AND idempotency_key_hmac = $3
			FOR UPDATE
		`, request.Actor.AdminID, request.Action, keyDigest).Scan(
			&existing.OperationID, &existing.State, &existing.ErrorCode, &existing.UpdatedAt, &existingHash,
		)
		if err != nil {
			return Result{}, errors.New("idempotency record could not be read")
		}
		if len(existingHash) != sha256.Size || subtle.ConstantTimeCompare(existingHash, semanticDigest[:]) != 1 {
			return Result{}, ErrIdempotencyKeyReused
		}
		if !existing.State.valid() || (existing.ErrorCode != "" && !operationErrorCodePattern.MatchString(existing.ErrorCode)) {
			return Result{}, errors.New("operation state is invalid")
		}
		return existing, nil
	}

	_, err = tx.Exec(ctx, `
		INSERT INTO admin_outbox (
			operation_id, action, target_id, approval_id, actor_admin_id, actor_role,
			idempotency_key_hmac, expected_revision, reason_code, ticket_reference,
			note, request_id, status, attempts, available_at, created_at, updated_at
		) VALUES (
			$1, $2, $3, $4, $5, $6, $7, $8, $9, NULLIF($10, ''),
			NULLIF($11, ''), $12, 'queued', 0, $13, $13, $13
		)
	`, operationID, request.Action, request.TargetID, request.ApprovalID, request.Actor.AdminID,
		request.Actor.Role, keyDigest, request.ExpectedRevision, request.Reason.Code,
		request.Reason.TicketReference, request.Reason.Note, request.Reason.Meta.RequestID, now)
	if err != nil {
		return Result{}, errors.New("operation Outbox record could not be stored")
	}
	if _, err := repository.audit.AppendTx(ctx, tx, audit.Record{
		ActorAdminID:    &request.Actor.AdminID,
		ActorRole:       request.Actor.Role,
		EventType:       "cloud_operation_queued",
		ObjectType:      string(request.Action),
		ObjectID:        &request.TargetID,
		Outcome:         audit.OutcomeSuccess,
		ReasonCode:      request.Reason.Code,
		TicketReference: request.Reason.TicketReference,
		Note:            request.Reason.Note,
		ApprovalID:      request.ApprovalID,
		OperationID:     &operationID,
		AfterState:      map[string]string{"execution_status": "queued"},
		RequestID:       request.Reason.Meta.RequestID,
		SourceIPHMAC:    request.Reason.Meta.SourceIPHMAC,
		UserAgent:       request.Reason.Meta.UserAgent,
	}); err != nil {
		return Result{}, err
	}
	return Result{OperationID: operationID, State: StateQueued, UpdatedAt: now}, nil
}

func (repository *repository) Get(ctx context.Context, actor admin.Actor, operationID uuid.UUID) (Result, error) {
	var ownerID uuid.UUID
	var result Result
	err := repository.postgres.QueryRow(ctx, `
		SELECT operation_id, actor_admin_id, state, COALESCE(error_code, ''), updated_at
		FROM admin_idempotency_records
		WHERE operation_id = $1
	`, operationID).Scan(&result.OperationID, &ownerID, &result.State, &result.ErrorCode, &result.UpdatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return Result{}, ErrOperationNotFound
	}
	if err != nil {
		return Result{}, errors.New("operation state could not be read")
	}
	if ownerID != actor.AdminID && !rbac.Allowed(actor.Role, rbac.ReadFullAudit) {
		return Result{}, ErrPermissionDenied
	}
	if !result.State.valid() || (result.ErrorCode != "" && !operationErrorCodePattern.MatchString(result.ErrorCode)) {
		return Result{}, errors.New("operation state is invalid")
	}
	return result, nil
}

var _ TransactionalEnqueuer = (*repository)(nil)
