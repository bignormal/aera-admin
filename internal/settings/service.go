package settings

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"log/slog"
	"strconv"
	"strings"
	"time"

	"github.com/bignormal/aera-admin/internal/audit"
	"github.com/bignormal/aera-admin/internal/rbac"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

const (
	actionUpdatePolicy     = "update_security_policy"
	actionCreateReasonCode = "create_reason_code"
	actionUpdateReasonCode = "update_reason_code"
	idempotencyLifetime    = 24 * time.Hour
)

type LiveSessionInvalidator interface {
	InvalidateLiveSessions(context.Context, [][]byte) error
}

type ServiceConfig struct {
	Store        *Store
	Audit        audit.TransactionalRecorder
	HMACKey      []byte
	Clock        func() time.Time
	LiveSessions LiveSessionInvalidator
}

type Service struct {
	store        *Store
	audit        audit.TransactionalRecorder
	hmacKey      []byte
	clock        func() time.Time
	liveSessions LiveSessionInvalidator
}

func NewService(config ServiceConfig) (*Service, error) {
	if config.Store == nil || config.Store.postgres == nil || config.Audit == nil ||
		len(config.HMACKey) < sha256.Size || config.LiveSessions == nil {
		return nil, errors.New("settings service dependencies are required")
	}
	clock := config.Clock
	if clock == nil {
		clock = time.Now
	}
	return &Service{
		store: config.Store, audit: config.Audit, hmacKey: append([]byte(nil), config.HMACKey...),
		clock: clock, liveSessions: config.LiveSessions,
	}, nil
}

func (service *Service) GetPolicy(ctx context.Context) (Policy, error) {
	if service == nil || service.store == nil {
		return Policy{}, ErrUnavailable
	}
	return service.store.GetPolicy(ctx)
}

func (service *Service) ListReasonCodes(ctx context.Context, query ReasonQuery) (Page, error) {
	if service == nil || service.store == nil {
		return Page{}, ErrUnavailable
	}
	return service.store.ListReasonCodes(ctx, query)
}

func (service *Service) ValidateReason(ctx context.Context, usage ReasonUsage, code string) error {
	if service == nil || service.store == nil {
		return ErrUnavailable
	}
	return service.store.ValidateReason(ctx, usage, code)
}

func (service *Service) UpdatePolicy(
	ctx context.Context,
	mutation MutationContext,
	input UpdatePolicyInput,
) (PolicyMutationResult, error) {
	if service == nil || service.store == nil || mutation.Validate() != nil || input.Validate() != nil {
		return PolicyMutationResult{}, ErrInvalidRequest
	}
	digest := policyRequestDigest(input)
	tx, err := service.store.postgres.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return PolicyMutationResult{}, ErrUnavailable
	}
	defer func() { _ = tx.Rollback(context.Background()) }()
	if err := authorizeMutationActor(ctx, tx, mutation); err != nil {
		return PolicyMutationResult{}, err
	}
	operationID, replay, err := service.reserveIdempotency(ctx, tx, mutation, actionUpdatePolicy, httpStatusOK, digest)
	if err != nil {
		return PolicyMutationResult{}, err
	}
	if replay != nil {
		var result PolicyMutationResult
		if err := json.Unmarshal(replay, &result); err != nil || result.OperationID != operationID || result.Policy.Validate() != nil {
			return PolicyMutationResult{}, ErrUnavailable
		}
		return result, nil
	}

	current, err := readPolicy(ctx, tx, true)
	if err != nil || current.Validate() != nil {
		return PolicyMutationResult{}, ErrUnavailable
	}
	if current.Revision != input.ExpectedRevision {
		return PolicyMutationResult{}, ErrRevisionConflict
	}
	if err := validateReason(ctx, tx, UsageSettings, input.ReasonCode); err != nil {
		return PolicyMutationResult{}, err
	}
	now := service.now()
	var updated Policy
	if err := tx.QueryRow(ctx, `
		UPDATE admin_security_settings
		SET session_idle_minutes = $1, session_absolute_hours = $2, audit_retention_days = $3,
			revision = revision + 1, updated_by_admin_id = $4, updated_at = $5
		WHERE settings_key = 'global' AND revision = $6
		RETURNING session_idle_minutes, session_absolute_hours, audit_retention_days,
			revision, updated_by_admin_id, updated_at
	`, input.SessionIdleMinutes, input.SessionAbsoluteHours, input.AuditRetentionDays,
		mutation.ActorAdminID, now, input.ExpectedRevision).Scan(
		&updated.SessionIdleMinutes, &updated.SessionAbsoluteHours, &updated.AuditRetentionDays,
		&updated.Revision, &updated.UpdatedByAdminID, &updated.UpdatedAt,
	); err != nil || updated.Validate() != nil {
		return PolicyMutationResult{}, ErrUnavailable
	}
	lifetimeChanged := current.SessionIdleMinutes != updated.SessionIdleMinutes ||
		current.SessionAbsoluteHours != updated.SessionAbsoluteHours
	tokens := make([][]byte, 0)
	if lifetimeChanged {
		rows, err := tx.Query(ctx, `
			UPDATE admin_sessions
			SET revoked_at = $1
			WHERE revoked_at IS NULL
			RETURNING token_hmac
		`, now)
		if err != nil {
			return PolicyMutationResult{}, ErrUnavailable
		}
		for rows.Next() {
			var token []byte
			if err := rows.Scan(&token); err != nil || len(token) != sha256.Size {
				rows.Close()
				return PolicyMutationResult{}, ErrUnavailable
			}
			tokens = append(tokens, append([]byte(nil), token...))
		}
		if rows.Err() != nil {
			rows.Close()
			return PolicyMutationResult{}, ErrUnavailable
		}
		rows.Close()
	}
	if _, err := service.audit.AppendTx(ctx, tx, audit.Record{
		ActorAdminID: &mutation.ActorAdminID, ActorRole: mutation.ActorRole,
		EventType: "security_policy_updated", ObjectType: "admin_security_settings",
		Outcome: audit.OutcomeSuccess, ReasonCode: input.ReasonCode,
		TicketReference: strings.TrimSpace(input.TicketReference), Note: strings.TrimSpace(input.Note),
		OperationID: &operationID,
		BeforeState: policyAuditState(current), AfterState: policyAuditState(updated),
		RequestID: mutation.RequestID, SourceIPHMAC: mutation.SourceIPHMAC, UserAgent: mutation.UserAgent,
	}); err != nil {
		return PolicyMutationResult{}, err
	}
	result := PolicyMutationResult{OperationID: operationID, Policy: updated, SessionsRevoked: lifetimeChanged}
	if err := storeIdempotentResult(ctx, tx, mutation, actionUpdatePolicy, operationID, result); err != nil {
		return PolicyMutationResult{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return PolicyMutationResult{}, ErrUnavailable
	}
	if len(tokens) > 0 {
		cleanupCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if err := service.liveSessions.InvalidateLiveSessions(cleanupCtx, tokens); err != nil {
			slog.Warn("administrator session cache cleanup failed after policy commit", "session_count", len(tokens))
		}
	}
	return result, nil
}

func (service *Service) CreateReasonCode(
	ctx context.Context,
	mutation MutationContext,
	input CreateReasonCodeInput,
) (ReasonMutationResult, error) {
	if service == nil || service.store == nil || mutation.Validate() != nil || input.Validate() != nil {
		return ReasonMutationResult{}, ErrInvalidRequest
	}
	digest := createReasonRequestDigest(input)
	tx, err := service.store.postgres.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return ReasonMutationResult{}, ErrUnavailable
	}
	defer func() { _ = tx.Rollback(context.Background()) }()
	if err := authorizeMutationActor(ctx, tx, mutation); err != nil {
		return ReasonMutationResult{}, err
	}
	operationID, replay, err := service.reserveIdempotency(ctx, tx, mutation, actionCreateReasonCode, httpStatusCreated, digest)
	if err != nil {
		return ReasonMutationResult{}, err
	}
	if replay != nil {
		return decodeReasonReplay(replay, operationID)
	}
	policy, err := readPolicy(ctx, tx, true)
	if err != nil || policy.Validate() != nil {
		return ReasonMutationResult{}, ErrUnavailable
	}
	if policy.Revision != input.ExpectedSettingsRevision {
		return ReasonMutationResult{}, ErrRevisionConflict
	}
	if err := validateReason(ctx, tx, UsageSettings, input.ReasonCode); err != nil {
		return ReasonMutationResult{}, err
	}
	now := service.now()
	reason := ReasonCode{
		Code: input.Code, Category: input.Category, Label: strings.TrimSpace(input.Label), Active: true,
		Revision: 1, CreatedAt: now, UpdatedAt: now,
	}
	_, err = tx.Exec(ctx, `
		INSERT INTO reason_codes (code, category, label, active, revision, created_at, updated_at)
		VALUES ($1, $2, $3, TRUE, 1, $4, $4)
	`, reason.Code, reason.Category, reason.Label, now)
	if err != nil {
		var postgresError *pgconn.PgError
		if errors.As(err, &postgresError) && postgresError.Code == "23505" {
			return ReasonMutationResult{}, ErrReasonExists
		}
		return ReasonMutationResult{}, ErrUnavailable
	}
	settingsRevision, err := updateSettingsRevision(ctx, tx, mutation.ActorAdminID, now, policy.Revision)
	if err != nil {
		return ReasonMutationResult{}, err
	}
	if _, err := service.audit.AppendTx(ctx, tx, audit.Record{
		ActorAdminID: &mutation.ActorAdminID, ActorRole: mutation.ActorRole,
		EventType: "reason_code_created", ObjectType: "reason_code", Outcome: audit.OutcomeSuccess,
		ReasonCode: input.ReasonCode, TicketReference: strings.TrimSpace(input.TicketReference),
		Note: strings.TrimSpace(input.Note), OperationID: &operationID,
		AfterState: reasonAuditState(reason, true), RequestID: mutation.RequestID,
		SourceIPHMAC: mutation.SourceIPHMAC, UserAgent: mutation.UserAgent,
	}); err != nil {
		return ReasonMutationResult{}, err
	}
	result := ReasonMutationResult{OperationID: operationID, Reason: reason, SettingsRevision: settingsRevision}
	if err := storeIdempotentResult(ctx, tx, mutation, actionCreateReasonCode, operationID, result); err != nil {
		return ReasonMutationResult{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return ReasonMutationResult{}, ErrUnavailable
	}
	return result, nil
}

func (service *Service) UpdateReasonCode(
	ctx context.Context,
	mutation MutationContext,
	code string,
	input UpdateReasonCodeInput,
) (ReasonMutationResult, error) {
	if service == nil || service.store == nil || mutation.Validate() != nil ||
		!reasonCodePattern.MatchString(code) || input.Validate() != nil {
		return ReasonMutationResult{}, ErrInvalidRequest
	}
	digest := updateReasonRequestDigest(code, input)
	tx, err := service.store.postgres.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return ReasonMutationResult{}, ErrUnavailable
	}
	defer func() { _ = tx.Rollback(context.Background()) }()
	if err := authorizeMutationActor(ctx, tx, mutation); err != nil {
		return ReasonMutationResult{}, err
	}
	operationID, replay, err := service.reserveIdempotency(ctx, tx, mutation, actionUpdateReasonCode, httpStatusOK, digest)
	if err != nil {
		return ReasonMutationResult{}, err
	}
	if replay != nil {
		return decodeReasonReplay(replay, operationID)
	}
	policy, err := readPolicy(ctx, tx, true)
	if err != nil || policy.Validate() != nil {
		return ReasonMutationResult{}, ErrUnavailable
	}
	if policy.Revision != input.ExpectedSettingsRevision {
		return ReasonMutationResult{}, ErrRevisionConflict
	}
	if err := validateReason(ctx, tx, UsageSettings, input.ReasonCode); err != nil {
		return ReasonMutationResult{}, err
	}
	current, err := lockReasonCode(ctx, tx, code)
	if err != nil {
		return ReasonMutationResult{}, err
	}
	if current.Revision != input.ExpectedReasonRevision {
		return ReasonMutationResult{}, ErrRevisionConflict
	}
	if !input.Active && ProtectedReasonCode(code) {
		return ReasonMutationResult{}, ErrReasonProtected
	}
	if current.Active && !input.Active {
		var otherActive int
		if err := tx.QueryRow(ctx, `
			SELECT count(*) FROM reason_codes WHERE category = $1 AND active = TRUE AND code <> $2
		`, current.Category, current.Code).Scan(&otherActive); err != nil {
			return ReasonMutationResult{}, ErrUnavailable
		}
		if otherActive == 0 {
			return ReasonMutationResult{}, ErrLastActiveReason
		}
	}
	now := service.now()
	var updated ReasonCode
	if err := tx.QueryRow(ctx, `
		UPDATE reason_codes
		SET label = $1, active = $2, revision = revision + 1, updated_at = $3
		WHERE code = $4 AND revision = $5
		RETURNING code, category, label, active, revision, created_at, updated_at
	`, strings.TrimSpace(input.Label), input.Active, now, code, input.ExpectedReasonRevision).Scan(
		&updated.Code, &updated.Category, &updated.Label, &updated.Active,
		&updated.Revision, &updated.CreatedAt, &updated.UpdatedAt,
	); err != nil || updated.Validate() != nil {
		return ReasonMutationResult{}, ErrUnavailable
	}
	settingsRevision, err := updateSettingsRevision(ctx, tx, mutation.ActorAdminID, now, policy.Revision)
	if err != nil {
		return ReasonMutationResult{}, err
	}
	labelChanged := current.Label != updated.Label
	if _, err := service.audit.AppendTx(ctx, tx, audit.Record{
		ActorAdminID: &mutation.ActorAdminID, ActorRole: mutation.ActorRole,
		EventType: "reason_code_updated", ObjectType: "reason_code", Outcome: audit.OutcomeSuccess,
		ReasonCode: input.ReasonCode, TicketReference: strings.TrimSpace(input.TicketReference),
		Note: strings.TrimSpace(input.Note), OperationID: &operationID,
		BeforeState: reasonAuditState(current, labelChanged), AfterState: reasonAuditState(updated, labelChanged),
		RequestID: mutation.RequestID, SourceIPHMAC: mutation.SourceIPHMAC, UserAgent: mutation.UserAgent,
	}); err != nil {
		return ReasonMutationResult{}, err
	}
	result := ReasonMutationResult{OperationID: operationID, Reason: updated, SettingsRevision: settingsRevision}
	if err := storeIdempotentResult(ctx, tx, mutation, actionUpdateReasonCode, operationID, result); err != nil {
		return ReasonMutationResult{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return ReasonMutationResult{}, ErrUnavailable
	}
	return result, nil
}

const (
	httpStatusOK      = 200
	httpStatusCreated = 201
)

func (service *Service) reserveIdempotency(
	ctx context.Context,
	tx pgx.Tx,
	mutation MutationContext,
	action string,
	responseStatus int,
	requestDigest [sha256.Size]byte,
) (uuid.UUID, []byte, error) {
	keyMAC := hmac.New(sha256.New, service.hmacKey)
	_, _ = keyMAC.Write([]byte("aera-admin.settings-idempotency.v1\x00" + mutation.IdempotencyKey))
	keyDigest := keyMAC.Sum(nil)
	now := service.now()
	if _, err := tx.Exec(ctx, `
		DELETE FROM admin_settings_idempotency
		WHERE actor_admin_id = $1 AND action = $2 AND idempotency_key_hmac = $3 AND expires_at <= $4
	`, mutation.ActorAdminID, action, keyDigest, now); err != nil {
		return uuid.Nil, nil, ErrUnavailable
	}
	operationID, err := uuid.NewRandom()
	if err != nil {
		return uuid.Nil, nil, ErrUnavailable
	}
	command, err := tx.Exec(ctx, `
		INSERT INTO admin_settings_idempotency (
			operation_id, actor_admin_id, action, idempotency_key_hmac, request_hash,
			response_status, response_body, created_at, expires_at
		) VALUES ($1, $2, $3, $4, $5, $6, '{}'::jsonb, $7, $8)
		ON CONFLICT (actor_admin_id, action, idempotency_key_hmac) DO NOTHING
	`, operationID, mutation.ActorAdminID, action, keyDigest, requestDigest[:], responseStatus, now, now.Add(idempotencyLifetime))
	if err != nil {
		return uuid.Nil, nil, ErrUnavailable
	}
	if command.RowsAffected() == 1 {
		return operationID, nil, nil
	}
	var existingID uuid.UUID
	var existingHash, responseBody []byte
	var storedStatus int
	if err := tx.QueryRow(ctx, `
		SELECT operation_id, request_hash, response_status, response_body
		FROM admin_settings_idempotency
		WHERE actor_admin_id = $1 AND action = $2 AND idempotency_key_hmac = $3
		FOR UPDATE
	`, mutation.ActorAdminID, action, keyDigest).Scan(
		&existingID, &existingHash, &storedStatus, &responseBody,
	); err != nil {
		return uuid.Nil, nil, ErrUnavailable
	}
	if len(existingHash) != sha256.Size || subtle.ConstantTimeCompare(existingHash, requestDigest[:]) != 1 {
		return uuid.Nil, nil, ErrIdempotencyKeyReused
	}
	if storedStatus != responseStatus || len(responseBody) <= 2 {
		return uuid.Nil, nil, ErrUnavailable
	}
	return existingID, append([]byte(nil), responseBody...), nil
}

func storeIdempotentResult(
	ctx context.Context,
	tx pgx.Tx,
	mutation MutationContext,
	action string,
	operationID uuid.UUID,
	result any,
) error {
	encoded, err := json.Marshal(result)
	if err != nil {
		return ErrUnavailable
	}
	command, err := tx.Exec(ctx, `
		UPDATE admin_settings_idempotency
		SET response_body = $1::jsonb
		WHERE operation_id = $2 AND actor_admin_id = $3 AND action = $4
	`, string(encoded), operationID, mutation.ActorAdminID, action)
	if err != nil || command.RowsAffected() != 1 {
		return ErrUnavailable
	}
	return nil
}

func authorizeMutationActor(ctx context.Context, tx pgx.Tx, mutation MutationContext) error {
	var role rbac.Role
	var status string
	if err := tx.QueryRow(ctx, `SELECT role, status FROM admin_users WHERE id = $1 FOR UPDATE`, mutation.ActorAdminID).Scan(&role, &status); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return ErrPermissionDenied
		}
		return ErrUnavailable
	}
	if role != mutation.ActorRole || status != "active" || !rbac.Allowed(role, rbac.ManageSystemSettings) {
		return ErrPermissionDenied
	}
	return nil
}

func updateSettingsRevision(
	ctx context.Context,
	tx pgx.Tx,
	actorID uuid.UUID,
	now time.Time,
	expectedRevision int64,
) (int64, error) {
	var revision int64
	if err := tx.QueryRow(ctx, `
		UPDATE admin_security_settings
		SET revision = revision + 1, updated_by_admin_id = $1, updated_at = $2
		WHERE settings_key = 'global' AND revision = $3
		RETURNING revision
	`, actorID, now, expectedRevision).Scan(&revision); err != nil || revision != expectedRevision+1 {
		return 0, ErrUnavailable
	}
	return revision, nil
}

func lockReasonCode(ctx context.Context, tx pgx.Tx, code string) (ReasonCode, error) {
	var reason ReasonCode
	if err := tx.QueryRow(ctx, `
		SELECT code, category, label, active, revision, created_at, updated_at
		FROM reason_codes WHERE code = $1 FOR UPDATE
	`, code).Scan(
		&reason.Code, &reason.Category, &reason.Label, &reason.Active,
		&reason.Revision, &reason.CreatedAt, &reason.UpdatedAt,
	); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return ReasonCode{}, ErrReasonNotFound
		}
		return ReasonCode{}, ErrUnavailable
	}
	if err := reason.Validate(); err != nil {
		return ReasonCode{}, ErrUnavailable
	}
	return reason, nil
}

func decodeReasonReplay(encoded []byte, operationID uuid.UUID) (ReasonMutationResult, error) {
	var result ReasonMutationResult
	if err := json.Unmarshal(encoded, &result); err != nil || result.OperationID != operationID ||
		result.SettingsRevision <= 0 || result.Reason.Validate() != nil {
		return ReasonMutationResult{}, ErrUnavailable
	}
	return result, nil
}

func policyAuditState(policy Policy) map[string]string {
	return map[string]string{
		"session_idle_minutes":   strconv.Itoa(policy.SessionIdleMinutes),
		"session_absolute_hours": strconv.Itoa(policy.SessionAbsoluteHours),
		"audit_retention_days":   strconv.Itoa(policy.AuditRetentionDays),
		"revision":               strconv.FormatInt(policy.Revision, 10),
	}
}

func reasonAuditState(reason ReasonCode, labelChanged bool) map[string]string {
	return map[string]string{
		"reason_code":   reason.Code,
		"category":      string(reason.Category),
		"active":        strconv.FormatBool(reason.Active),
		"revision":      strconv.FormatInt(reason.Revision, 10),
		"label_changed": strconv.FormatBool(labelChanged),
	}
}

func (service *Service) now() time.Time {
	clock := service.clock
	if clock == nil {
		clock = time.Now
	}
	return clock().UTC().Truncate(time.Microsecond)
}
