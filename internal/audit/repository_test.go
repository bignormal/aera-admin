package audit

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/bignormal/aera-admin/internal/rbac"
	"github.com/bignormal/aera-admin/internal/testkit"
	"github.com/google/uuid"
)

func TestAppendTxParticipatesInCallerTransaction(t *testing.T) {
	postgres := testkit.Postgres(t)
	service, err := NewService(postgres)
	if err != nil {
		t.Fatalf("NewService() error = %v", err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()

	rolledBack, err := postgres.Begin(ctx)
	if err != nil {
		t.Fatalf("begin rollback transaction: %v", err)
	}
	if _, err := service.AppendTx(ctx, rolledBack, validRecord("admin_login", "req-rollback")); err != nil {
		t.Fatalf("AppendTx(rollback) error = %v", err)
	}
	if err := rolledBack.Rollback(ctx); err != nil {
		t.Fatalf("rollback transaction: %v", err)
	}

	committed, err := postgres.Begin(ctx)
	if err != nil {
		t.Fatalf("begin commit transaction: %v", err)
	}
	first, err := service.AppendTx(ctx, committed, validRecord("admin_login", "req-commit-1"))
	if err != nil {
		t.Fatalf("first AppendTx(commit) error = %v", err)
	}
	second, err := service.AppendTx(ctx, committed, validRecord("admin_role_changed", "req-commit-2"))
	if err != nil {
		t.Fatalf("second AppendTx(commit) error = %v", err)
	}
	if first == second {
		t.Fatal("AppendTx reused an event ID")
	}
	if err := committed.Commit(ctx); err != nil {
		t.Fatalf("commit transaction: %v", err)
	}

	var count int
	if err := postgres.QueryRow(ctx, `SELECT count(*) FROM admin_audit_events`).Scan(&count); err != nil {
		t.Fatalf("count audit events: %v", err)
	}
	if count != 2 {
		t.Fatalf("stored audit events = %d, want 2", count)
	}
	if err := service.Verify(ctx); err != nil {
		t.Fatalf("Verify() error = %v", err)
	}
}

func TestListAuditEventsUsesStableCursorFiltersAndSafeProjection(t *testing.T) {
	postgres := testkit.Postgres(t)
	service, err := NewService(postgres)
	if err != nil {
		t.Fatalf("NewService() error = %v", err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()

	firstActor := uuid.New()
	secondActor := uuid.New()
	for _, actorID := range []uuid.UUID{firstActor, secondActor} {
		if _, err := postgres.Exec(ctx, `
			INSERT INTO admin_users (id, display_name, role, status, security_version, created_at, updated_at)
			VALUES ($1, 'Audit Query Actor', 'operator', 'active', 1, now(), now())
		`, actorID); err != nil {
			t.Fatalf("insert audit query actor: %v", err)
		}
	}

	base := time.Date(2026, time.July, 22, 8, 0, 0, 0, time.UTC)
	service.clock = func() time.Time { return base }
	firstObject := uuid.New()
	secondObject := uuid.New()
	appendFor := func(actorID, objectID uuid.UUID, eventType, requestID string, outcome Outcome) uuid.UUID {
		record := validRecord(eventType, requestID)
		record.ActorAdminID = &actorID
		record.ActorRole = rbac.Operator
		record.Outcome = outcome
		record.ObjectID = &objectID
		id, appendErr := service.Append(ctx, record)
		if appendErr != nil {
			t.Fatalf("Append(%s) error = %v", eventType, appendErr)
		}
		base = base.Add(time.Minute)
		return id
	}
	oldestID := appendFor(firstActor, firstObject, "admin_login_succeeded", "req-query-1", OutcomeSuccess)
	middleID := appendFor(secondActor, secondObject, "admin_authorization_denied", "req-query-2", OutcomeDenied)
	newestID := appendFor(firstActor, secondObject, "cloud_session_revoked", "req-query-3", OutcomeSuccess)

	firstPage, err := service.List(ctx, Query{Limit: 2})
	if err != nil {
		t.Fatalf("List(first page) error = %v", err)
	}
	if len(firstPage.Items) != 2 || firstPage.Items[0].ID != newestID || firstPage.Items[1].ID != middleID || firstPage.NextCursor == nil {
		t.Fatalf("first page = %#v", firstPage)
	}
	secondPage, err := service.List(ctx, Query{Limit: 2, Cursor: *firstPage.NextCursor})
	if err != nil {
		t.Fatalf("List(second page) error = %v", err)
	}
	if len(secondPage.Items) != 1 || secondPage.Items[0].ID != oldestID || secondPage.NextCursor != nil {
		t.Fatalf("second page = %#v", secondPage)
	}

	filtered, err := service.List(ctx, Query{
		Limit: 10, ActorAdminID: &firstActor, Outcome: OutcomeSuccess,
		From: time.Date(2026, time.July, 22, 7, 59, 0, 0, time.UTC),
		To:   time.Date(2026, time.July, 22, 8, 3, 0, 0, time.UTC),
	})
	if err != nil {
		t.Fatalf("List(filtered) error = %v", err)
	}
	if len(filtered.Items) != 2 || filtered.Items[0].ID != newestID || filtered.Items[1].ID != oldestID {
		t.Fatalf("filtered page = %#v", filtered)
	}
	exact, err := service.List(ctx, Query{
		Limit: 10, EventType: "cloud_session_revoked", ObjectType: "admin_user",
		ObjectID: &secondObject, ReasonCode: "access_review",
	})
	if err != nil {
		t.Fatalf("List(exact filters) error = %v", err)
	}
	if len(exact.Items) != 1 || exact.Items[0].ID != newestID {
		t.Fatalf("exact-filter page = %#v", exact)
	}

	encoded, err := json.Marshal(firstPage)
	if err != nil {
		t.Fatalf("marshal public audit page: %v", err)
	}
	for _, forbidden := range []string{"source_ip_hmac", "user_agent", "previous_hash", "event_hash"} {
		if strings.Contains(string(encoded), forbidden) {
			t.Fatalf("public audit response contains %q: %s", forbidden, encoded)
		}
	}
}
