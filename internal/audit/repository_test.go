package audit

import (
	"context"
	"testing"
	"time"

	"github.com/bignormal/aera-admin/internal/testkit"
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
