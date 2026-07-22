package operations

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/json"
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
	canonicalPayload, payloadDigest, err := canonicalCommandPayload(request.Action, request.Payload)
	if err != nil {
		return Result{}, err
	}

	keyMAC := hmac.New(sha256.New, repository.hmacKey)
	_, _ = keyMAC.Write([]byte("aera-admin.operation-idempotency.v1\x00" + request.BrowserIdempotencyKey))
	keyDigest := keyMAC.Sum(nil)
	semanticDigest := requestDigest(request, payloadDigest)
	now := repository.clock().UTC()
	operationID, err := uuid.NewRandom()
	if err != nil {
		return Result{}, errors.New("operation identifier could not be generated")
	}
	command, err := tx.Exec(ctx, `
		INSERT INTO admin_idempotency_records (
			operation_id, actor_admin_id, action, idempotency_key_hmac, request_hash,
			command_payload, command_payload_digest, state, created_at, updated_at, expires_at
		) VALUES ($1, $2, $3, $4, $5, $6, $7, 'queued', $8, $8, $9)
		ON CONFLICT (actor_admin_id, action, idempotency_key_hmac) DO NOTHING
	`, operationID, request.Actor.AdminID, request.Action, keyDigest, semanticDigest[:],
		canonicalPayload, payloadDigest[:], now, now.Add(30*24*time.Hour))
	if err != nil {
		return Result{}, errors.New("idempotency record could not be stored")
	}
	if command.RowsAffected() == 0 {
		var existing Result
		var existingHash, existingPayload, existingPayloadDigest []byte
		err := tx.QueryRow(ctx, `
			SELECT operation_id, state, COALESCE(error_code, ''), updated_at, request_hash,
			       command_payload, command_payload_digest
			FROM admin_idempotency_records
			WHERE actor_admin_id = $1 AND action = $2 AND idempotency_key_hmac = $3
			FOR UPDATE
		`, request.Actor.AdminID, request.Action, keyDigest).Scan(
			&existing.OperationID, &existing.State, &existing.ErrorCode, &existing.UpdatedAt, &existingHash,
			&existingPayload, &existingPayloadDigest,
		)
		if err != nil {
			return Result{}, errors.New("idempotency record could not be read")
		}
		if len(existingHash) != sha256.Size || len(existingPayloadDigest) != sha256.Size ||
			subtle.ConstantTimeCompare(existingHash, semanticDigest[:]) != 1 ||
			subtle.ConstantTimeCompare(existingPayloadDigest, payloadDigest[:]) != 1 ||
			!bytes.Equal(existingPayload, canonicalPayload) {
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
			idempotency_key_hmac, expected_revision, command_payload, command_payload_digest,
			reason_code, ticket_reference, note, request_id, status, attempts,
			available_at, created_at, updated_at
		) VALUES (
			$1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, NULLIF($12, ''),
			NULLIF($13, ''), $14, 'queued', 0, $15, $15, $15
		)
	`, operationID, request.Action, request.TargetID, request.ApprovalID, request.Actor.AdminID,
		request.Actor.Role, keyDigest, request.ExpectedRevision, canonicalPayload, payloadDigest[:],
		request.Reason.Code, request.Reason.TicketReference, request.Reason.Note,
		request.Reason.Meta.RequestID, now)
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

func (repository *repository) Claim(ctx context.Context, limit int, lease time.Duration, sink ExecutionSink) ([]Job, error) {
	if repository == nil || repository.postgres == nil || sink == nil || limit < 1 || limit > 32 ||
		lease < 5*time.Second || lease > 5*time.Minute {
		return nil, ErrInvalidRequest
	}
	now := repository.clock().UTC()
	tx, err := repository.postgres.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return nil, errors.New("Outbox claim transaction could not start")
	}
	defer func() { _ = tx.Rollback(context.Background()) }()
	rows, err := tx.Query(ctx, `
		WITH candidates AS (
			SELECT operation_id, status AS previous_status
			FROM admin_outbox
			WHERE (
				status IN ('queued', 'reconciling') AND available_at <= $1
			) OR (
				status = 'executing' AND lease_until < $1
			)
			ORDER BY available_at, created_at, operation_id
			FOR UPDATE SKIP LOCKED
			LIMIT $2
		)
		UPDATE admin_outbox AS outbox
		SET status = 'executing', attempts = attempts + 1, lease_until = $3, updated_at = $1
		FROM candidates
		WHERE outbox.operation_id = candidates.operation_id
		RETURNING outbox.operation_id, outbox.action, outbox.target_id, outbox.approval_id,
			outbox.actor_admin_id, outbox.actor_role, outbox.expected_revision,
			outbox.command_payload, outbox.command_payload_digest, outbox.reason_code,
			COALESCE(outbox.ticket_reference, ''), COALESCE(outbox.note, ''),
			outbox.request_id, outbox.attempts,
			CASE WHEN candidates.previous_status = 'executing' THEN 'reconciling' ELSE candidates.previous_status END
	`, now, limit, now.Add(lease))
	if err != nil {
		return nil, errors.New("Outbox jobs could not be claimed")
	}
	jobs := make([]Job, 0, limit)
	for rows.Next() {
		var job Job
		var payloadDigestBytes []byte
		if err := rows.Scan(
			&job.OperationID, &job.Action, &job.TargetID, &job.ApprovalID,
			&job.ActorAdminID, &job.ActorRole, &job.ExpectedRevision,
			&job.Payload, &payloadDigestBytes, &job.ReasonCode,
			&job.TicketReference, &job.Note, &job.RequestID, &job.Attempts, &job.State,
		); err != nil {
			rows.Close()
			return nil, errors.New("Outbox job could not be decoded")
		}
		if len(payloadDigestBytes) == sha256.Size {
			copy(job.PayloadDigest[:], payloadDigestBytes)
		}
		job.Payload = append(json.RawMessage(nil), job.Payload...)
		canonicalPayload, payloadDigest, payloadErr := canonicalCommandPayload(job.Action, job.Payload)
		if job.OperationID == uuid.Nil || !job.Action.Valid() || job.TargetID == uuid.Nil ||
			job.ActorAdminID == uuid.Nil || !job.ActorRole.Valid() || job.ExpectedRevision <= 0 ||
			job.Attempts < 1 || (job.State != StateQueued && job.State != StateReconciling) ||
			len(payloadDigestBytes) != sha256.Size || payloadErr != nil ||
			!bytes.Equal(canonicalPayload, job.Payload) || payloadDigest != job.PayloadDigest {
			rows.Close()
			return nil, errors.New("Outbox job contains invalid state")
		}
		jobs = append(jobs, job)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return nil, errors.New("Outbox jobs could not be read")
	}
	rows.Close()

	for _, job := range jobs {
		command, err := tx.Exec(ctx, `
			UPDATE admin_idempotency_records
			SET state = 'executing', updated_at = $2
			WHERE operation_id = $1 AND state IN ('queued', 'reconciling', 'executing')
		`, job.OperationID, now)
		if err != nil || command.RowsAffected() != 1 {
			return nil, ErrStateConflict
		}
		if job.ApprovalID != nil && job.State == StateQueued {
			if err := sink.ApplyExecutionTx(ctx, tx, job.OperationID, StateExecuting, "", job.RequestID, now); err != nil {
				return nil, err
			}
		}
		if _, err := repository.audit.AppendTx(ctx, tx, audit.Record{
			ActorAdminID:    &job.ActorAdminID,
			ActorRole:       job.ActorRole,
			EventType:       "cloud_operation_started",
			ObjectType:      string(job.Action),
			ObjectID:        &job.TargetID,
			Outcome:         audit.OutcomeSuccess,
			ReasonCode:      job.ReasonCode,
			TicketReference: job.TicketReference,
			Note:            job.Note,
			ApprovalID:      job.ApprovalID,
			OperationID:     &job.OperationID,
			BeforeState:     map[string]string{"execution_status": string(job.State)},
			AfterState:      map[string]string{"execution_status": "executing"},
			RequestID:       job.RequestID,
		}); err != nil {
			return nil, err
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, errors.New("Outbox claims could not be committed")
	}
	return jobs, nil
}

func (repository *repository) Transition(
	ctx context.Context,
	job Job,
	nextState State,
	errorCode string,
	nextAttemptAt time.Time,
	sink ExecutionSink,
) error {
	if repository == nil || repository.postgres == nil || sink == nil ||
		(nextState != StateQueued && nextState != StateReconciling && !terminalState(nextState)) {
		return ErrStateConflict
	}
	needsError := nextState == StateFailed || nextState == StateConflict || nextState == StateReconciling
	if (needsError && !operationErrorCodePattern.MatchString(errorCode)) || (!needsError && errorCode != "") {
		return ErrInvalidRequest
	}
	now := repository.clock().UTC()
	availableAt := nextAttemptAt.UTC()
	if terminalState(nextState) {
		availableAt = now
	}
	if !terminalState(nextState) && !availableAt.After(now) {
		return ErrInvalidRequest
	}
	tx, err := repository.postgres.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return errors.New("operation transition could not start")
	}
	defer func() { _ = tx.Rollback(context.Background()) }()
	var completedAt any
	if terminalState(nextState) {
		completedAt = now
	}
	command, err := tx.Exec(ctx, `
		UPDATE admin_outbox
		SET status = $2, last_error_code = NULLIF($3, ''), available_at = $4,
			lease_until = NULL, completed_at = $5, updated_at = $6
		WHERE operation_id = $1 AND status = 'executing'
	`, job.OperationID, nextState, errorCode, availableAt, completedAt, now)
	if err != nil {
		return errors.New("Outbox transition could not be stored")
	}
	if command.RowsAffected() != 1 {
		return ErrStateConflict
	}
	resultJSON, err := json.Marshal(map[string]string{"state": string(nextState), "error_code": errorCode})
	if err != nil {
		return errors.New("operation result could not be encoded")
	}
	command, err = tx.Exec(ctx, `
		UPDATE admin_idempotency_records
		SET state = $2, error_code = NULLIF($3, ''), result = $4,
			completed_at = $5, updated_at = $6
		WHERE operation_id = $1 AND state = 'executing'
	`, job.OperationID, nextState, errorCode, resultJSON, completedAt, now)
	if err != nil || command.RowsAffected() != 1 {
		return ErrStateConflict
	}
	if job.ApprovalID != nil {
		if err := sink.ApplyExecutionTx(ctx, tx, job.OperationID, nextState, errorCode, job.RequestID, now); err != nil {
			return err
		}
	}
	outcome := audit.OutcomeSuccess
	if nextState != StateSucceeded && nextState != StateQueued {
		outcome = audit.OutcomeFailure
	}
	if _, err := repository.audit.AppendTx(ctx, tx, audit.Record{
		ActorAdminID:    &job.ActorAdminID,
		ActorRole:       job.ActorRole,
		EventType:       transitionEvent(nextState),
		ObjectType:      string(job.Action),
		ObjectID:        &job.TargetID,
		Outcome:         outcome,
		ErrorCode:       errorCode,
		ReasonCode:      job.ReasonCode,
		TicketReference: job.TicketReference,
		Note:            job.Note,
		ApprovalID:      job.ApprovalID,
		OperationID:     &job.OperationID,
		BeforeState:     map[string]string{"execution_status": "executing"},
		AfterState:      map[string]string{"execution_status": string(nextState)},
		RequestID:       job.RequestID,
	}); err != nil {
		return err
	}
	if err := tx.Commit(ctx); err != nil {
		return errors.New("operation transition could not be committed")
	}
	return nil
}

func (repository *repository) CleanupExpired(ctx context.Context, now time.Time, limit int) (int, error) {
	if repository == nil || repository.postgres == nil || limit < 1 || limit > 256 {
		return 0, ErrInvalidRequest
	}
	tx, err := repository.postgres.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return 0, errors.New("operation cleanup could not start")
	}
	defer func() { _ = tx.Rollback(context.Background()) }()
	rows, err := tx.Query(ctx, `
		SELECT operation_id
		FROM admin_idempotency_records
		WHERE state IN ('succeeded', 'failed', 'conflict') AND expires_at < $1
		ORDER BY expires_at, operation_id
		FOR UPDATE SKIP LOCKED
		LIMIT $2
	`, now.UTC(), limit)
	if err != nil {
		return 0, errors.New("expired operations could not be selected")
	}
	identifiers := make([]uuid.UUID, 0, limit)
	for rows.Next() {
		var id uuid.UUID
		if err := rows.Scan(&id); err != nil {
			rows.Close()
			return 0, errors.New("expired operation could not be decoded")
		}
		identifiers = append(identifiers, id)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return 0, errors.New("expired operations could not be read")
	}
	rows.Close()
	for _, id := range identifiers {
		command, err := tx.Exec(ctx, `
			DELETE FROM admin_outbox
			WHERE operation_id = $1 AND status IN ('succeeded', 'failed', 'conflict')
		`, id)
		if err != nil || command.RowsAffected() != 1 {
			return 0, ErrStateConflict
		}
		command, err = tx.Exec(ctx, `
			DELETE FROM admin_idempotency_records
			WHERE operation_id = $1 AND state IN ('succeeded', 'failed', 'conflict')
		`, id)
		if err != nil || command.RowsAffected() != 1 {
			return 0, ErrStateConflict
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return 0, errors.New("operation cleanup could not be committed")
	}
	return len(identifiers), nil
}

func terminalState(state State) bool {
	return state == StateSucceeded || state == StateFailed || state == StateConflict
}

func transitionEvent(state State) string {
	switch state {
	case StateQueued:
		return "cloud_operation_queued"
	case StateReconciling:
		return "cloud_operation_reconciling"
	case StateSucceeded:
		return "cloud_operation_succeeded"
	case StateConflict:
		return "cloud_operation_conflict"
	default:
		return "cloud_operation_failed"
	}
}
