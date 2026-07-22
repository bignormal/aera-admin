package settings

import (
	"bytes"
	"context"
	"errors"
	"reflect"
	"testing"
	"time"

	"github.com/bignormal/aera-admin/internal/audit"
	"github.com/bignormal/aera-admin/internal/rbac"
	"github.com/bignormal/aera-admin/internal/testkit"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

func TestServiceUpdatesPolicyIdempotentlyAndRevokesSessionsOnlyForLifetimeChanges(t *testing.T) {
	fixture := newSettingsFixture(t, nil)
	token := bytes.Repeat([]byte{4}, 32)
	fixture.insertSession(t, token)
	input := UpdatePolicyInput{
		ExpectedRevision: 1, SessionIdleMinutes: 12, SessionAbsoluteHours: 3, AuditRetentionDays: 730,
		MutationReason: MutationReason{ReasonCode: "security_policy_change", TicketReference: "SEC-42", Note: "approved policy update"},
	}
	mutation := fixture.mutation("019f0000-0000-7000-8000-000000000101", "req-policy-lifetimes")
	first, err := fixture.service.UpdatePolicy(context.Background(), mutation, input)
	if err != nil {
		t.Fatalf("UpdatePolicy() error = %v", err)
	}
	if first.Policy.Revision != 2 || !first.SessionsRevoked || first.OperationID == uuid.Nil {
		t.Fatalf("UpdatePolicy() = %+v", first)
	}
	if len(fixture.invalidator.calls) != 1 || len(fixture.invalidator.calls[0]) != 1 ||
		!bytes.Equal(fixture.invalidator.calls[0][0], token) {
		t.Fatalf("invalidator calls = %#v", fixture.invalidator.calls)
	}
	var revokedAt *time.Time
	if err := fixture.postgres.QueryRow(context.Background(), `SELECT revoked_at FROM admin_sessions WHERE token_hmac = $1`, token).Scan(&revokedAt); err != nil || revokedAt == nil {
		t.Fatalf("session revoked_at/error = %v/%v", revokedAt, err)
	}

	replayed, err := fixture.service.UpdatePolicy(context.Background(), mutation, input)
	if err != nil || !reflect.DeepEqual(first, replayed) {
		t.Fatalf("idempotent replay = %+v, %v; want %+v", replayed, err, first)
	}
	if len(fixture.invalidator.calls) != 1 {
		t.Fatalf("replay invalidated live sessions again: %d", len(fixture.invalidator.calls))
	}
	changed := input
	changed.AuditRetentionDays = 731
	if _, err := fixture.service.UpdatePolicy(context.Background(), mutation, changed); !errors.Is(err, ErrIdempotencyKeyReused) {
		t.Fatalf("different-input replay error = %v", err)
	}
	staleMutation := fixture.mutation("019f0000-0000-7000-8000-000000000102", "req-policy-stale")
	if _, err := fixture.service.UpdatePolicy(context.Background(), staleMutation, input); !errors.Is(err, ErrRevisionConflict) {
		t.Fatalf("stale update error = %v", err)
	}

	retentionToken := bytes.Repeat([]byte{5}, 32)
	fixture.insertSession(t, retentionToken)
	retention := input
	retention.ExpectedRevision = 2
	retention.AuditRetentionDays = 800
	retentionResult, err := fixture.service.UpdatePolicy(
		context.Background(),
		fixture.mutation("019f0000-0000-7000-8000-000000000103", "req-policy-retention"),
		retention,
	)
	if err != nil {
		t.Fatalf("retention-only UpdatePolicy() error = %v", err)
	}
	if retentionResult.Policy.Revision != 3 || retentionResult.SessionsRevoked {
		t.Fatalf("retention-only result = %+v", retentionResult)
	}
	if err := fixture.postgres.QueryRow(context.Background(), `SELECT revoked_at FROM admin_sessions WHERE token_hmac = $1`, retentionToken).Scan(&revokedAt); err != nil || revokedAt != nil {
		t.Fatalf("retention-only session revoked_at/error = %v/%v", revokedAt, err)
	}
	var auditCount int
	if err := fixture.postgres.QueryRow(context.Background(), `SELECT count(*) FROM admin_audit_events WHERE event_type = 'security_policy_updated'`).Scan(&auditCount); err != nil || auditCount != 2 {
		t.Fatalf("security policy audit count/error = %d/%v", auditCount, err)
	}
}

func TestServiceCreatesAndUpdatesReasonCodesWithGuards(t *testing.T) {
	fixture := newSettingsFixture(t, nil)
	create := CreateReasonCodeInput{
		Code: "incident_followup", Category: CategorySecurity, Label: "事件后续复核", ExpectedSettingsRevision: 1,
		MutationReason: MutationReason{ReasonCode: "reason_catalog_change", TicketReference: "SEC-43", Note: "approved catalog update"},
	}
	createMutation := fixture.mutation("019f0000-0000-7000-8000-000000000111", "req-reason-create")
	created, err := fixture.service.CreateReasonCode(context.Background(), createMutation, create)
	if err != nil {
		t.Fatalf("CreateReasonCode() error = %v", err)
	}
	if created.Reason.Code != create.Code || created.Reason.Revision != 1 || created.SettingsRevision != 2 {
		t.Fatalf("created reason = %+v", created)
	}
	replayed, err := fixture.service.CreateReasonCode(context.Background(), createMutation, create)
	if err != nil || !reflect.DeepEqual(created, replayed) {
		t.Fatalf("create replay = %+v, %v", replayed, err)
	}
	changedCreate := create
	changedCreate.Label = "不同标签"
	if _, err := fixture.service.CreateReasonCode(context.Background(), createMutation, changedCreate); !errors.Is(err, ErrIdempotencyKeyReused) {
		t.Fatalf("changed create replay error = %v", err)
	}

	update := UpdateReasonCodeInput{
		ExpectedSettingsRevision: 2, ExpectedReasonRevision: 1, Label: "事件复核（已停用）", Active: false,
		MutationReason: MutationReason{ReasonCode: "reason_catalog_change", TicketReference: "SEC-44", Note: "retired custom reason"},
	}
	updated, err := fixture.service.UpdateReasonCode(
		context.Background(),
		fixture.mutation("019f0000-0000-7000-8000-000000000112", "req-reason-update"),
		create.Code,
		update,
	)
	if err != nil {
		t.Fatalf("UpdateReasonCode() error = %v", err)
	}
	if updated.Reason.Active || updated.Reason.Revision != 2 || updated.SettingsRevision != 3 {
		t.Fatalf("updated reason = %+v", updated)
	}

	stale := update
	stale.ExpectedSettingsRevision = 3
	if _, err := fixture.service.UpdateReasonCode(
		context.Background(),
		fixture.mutation("019f0000-0000-7000-8000-000000000113", "req-reason-stale"),
		create.Code,
		stale,
	); !errors.Is(err, ErrRevisionConflict) {
		t.Fatalf("stale reason update error = %v", err)
	}
	protected := UpdateReasonCodeInput{
		ExpectedSettingsRevision: 3, ExpectedReasonRevision: 1, Label: "安全策略调整", Active: false,
		MutationReason: MutationReason{ReasonCode: "reason_catalog_change", Note: "must remain active"},
	}
	if _, err := fixture.service.UpdateReasonCode(
		context.Background(),
		fixture.mutation("019f0000-0000-7000-8000-000000000114", "req-reason-protected"),
		"security_policy_change",
		protected,
	); !errors.Is(err, ErrReasonProtected) {
		t.Fatalf("protected reason update error = %v", err)
	}
	lastActive := UpdateReasonCodeInput{
		ExpectedSettingsRevision: 3, ExpectedReasonRevision: 1, Label: "会话安全清理", Active: false,
		MutationReason: MutationReason{ReasonCode: "reason_catalog_change", Note: "attempt category removal"},
	}
	if _, err := fixture.service.UpdateReasonCode(
		context.Background(),
		fixture.mutation("019f0000-0000-7000-8000-000000000115", "req-reason-last-active"),
		"session_cleanup",
		lastActive,
	); !errors.Is(err, ErrLastActiveReason) {
		t.Fatalf("last-active reason update error = %v", err)
	}
}

func TestServiceRollsBackPolicyWhenAuditAppendFails(t *testing.T) {
	fixture := newSettingsFixture(t, failingAudit{})
	token := bytes.Repeat([]byte{6}, 32)
	fixture.insertSession(t, token)
	input := UpdatePolicyInput{
		ExpectedRevision: 1, SessionIdleMinutes: 15, SessionAbsoluteHours: 4, AuditRetentionDays: 730,
		MutationReason: MutationReason{ReasonCode: "security_policy_change", Note: "approved rollback test"},
	}
	_, err := fixture.service.UpdatePolicy(
		context.Background(),
		fixture.mutation("019f0000-0000-7000-8000-000000000121", "req-policy-audit-failure"),
		input,
	)
	if err == nil {
		t.Fatal("UpdatePolicy() succeeded with failing audit")
	}
	policy, readErr := fixture.store.GetPolicy(context.Background())
	if readErr != nil || policy.Revision != 1 || policy.SessionIdleMinutes != 30 {
		t.Fatalf("rolled-back policy = %+v, %v", policy, readErr)
	}
	var idempotencyCount int
	if err := fixture.postgres.QueryRow(context.Background(), `SELECT count(*) FROM admin_settings_idempotency`).Scan(&idempotencyCount); err != nil || idempotencyCount != 0 {
		t.Fatalf("idempotency count/error = %d/%v", idempotencyCount, err)
	}
	var revokedAt *time.Time
	if err := fixture.postgres.QueryRow(context.Background(), `SELECT revoked_at FROM admin_sessions WHERE token_hmac = $1`, token).Scan(&revokedAt); err != nil || revokedAt != nil {
		t.Fatalf("rolled-back session revoked_at/error = %v/%v", revokedAt, err)
	}
	if len(fixture.invalidator.calls) != 0 {
		t.Fatal("cache invalidator ran before a committed policy update")
	}
}

type settingsFixture struct {
	postgres    *pgxpool.Pool
	store       *Store
	service     *Service
	actorID     uuid.UUID
	invalidator *recordingInvalidator
}

func newSettingsFixture(t *testing.T, recorder audit.TransactionalRecorder) *settingsFixture {
	t.Helper()
	postgres := testkit.Postgres(t)
	store, err := NewStore(postgres)
	if err != nil {
		t.Fatal(err)
	}
	if recorder == nil {
		recorder, err = audit.NewService(postgres)
		if err != nil {
			t.Fatal(err)
		}
	}
	actorID := uuid.New()
	now := settingsClock()
	if _, err := postgres.Exec(context.Background(), `
		INSERT INTO admin_users (id, display_name, role, status, security_version, created_at, updated_at)
		VALUES ($1, 'Settings Test Admin', 'super_admin', 'active', 1, $2, $2)
	`, actorID, now.Add(-time.Hour)); err != nil {
		t.Fatal(err)
	}
	invalidator := &recordingInvalidator{}
	service, err := NewService(ServiceConfig{
		Store: store, Audit: recorder, HMACKey: bytes.Repeat([]byte{9}, 32),
		Clock: settingsClock, LiveSessions: invalidator,
	})
	if err != nil {
		t.Fatal(err)
	}
	return &settingsFixture{
		postgres: postgres, store: store, service: service, actorID: actorID, invalidator: invalidator,
	}
}

func (fixture *settingsFixture) mutation(key, requestID string) MutationContext {
	return MutationContext{
		ActorAdminID: fixture.actorID, ActorRole: rbac.SuperAdmin, IdempotencyKey: key,
		RequestID: requestID, SourceIPHMAC: bytes.Repeat([]byte{8}, 32), UserAgent: "SettingsTest/1.0",
	}
}

func (fixture *settingsFixture) insertSession(t *testing.T, token []byte) {
	t.Helper()
	now := settingsClock()
	if _, err := fixture.postgres.Exec(context.Background(), `
		INSERT INTO admin_sessions (
			id, admin_user_id, token_hmac, csrf_hmac, security_version, role,
			mfa_method, mfa_authenticated_at, totp_authenticated_at,
			created_at, last_seen_at, idle_expires_at, absolute_expires_at
		) VALUES ($1, $2, $3, $4, 1, 'super_admin', 'totp', $5, $5, $5, $5, $6, $7)
	`, uuid.New(), fixture.actorID, token, bytes.Repeat([]byte{7}, 32), now,
		now.Add(30*time.Minute), now.Add(8*time.Hour)); err != nil {
		t.Fatal(err)
	}
}

type recordingInvalidator struct {
	calls [][][]byte
}

func (invalidator *recordingInvalidator) InvalidateLiveSessions(_ context.Context, tokens [][]byte) error {
	cloned := make([][]byte, len(tokens))
	for index := range tokens {
		cloned[index] = append([]byte(nil), tokens[index]...)
	}
	invalidator.calls = append(invalidator.calls, cloned)
	return nil
}

type failingAudit struct{}

func (failingAudit) AppendTx(context.Context, pgx.Tx, audit.Record) (uuid.UUID, error) {
	return uuid.Nil, errors.New("audit unavailable")
}

func settingsClock() time.Time {
	return time.Date(2026, 7, 22, 8, 0, 0, 0, time.UTC)
}
