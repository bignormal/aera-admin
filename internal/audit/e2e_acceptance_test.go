package audit_test

import (
	"context"
	"encoding/json"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/bignormal/aera-admin/internal/audit"
	"github.com/jackc/pgx/v5/pgxpool"
)

func TestE2EAcceptance(t *testing.T) {
	databaseURL := os.Getenv("AERA_ADMIN_E2E_DATABASE_URL")
	fixturePath := os.Getenv("AERA_ADMIN_E2E_FIXTURE_FILE")
	if databaseURL == "" && fixturePath == "" {
		t.Skip("Aera Admin E2E acceptance environment is not configured")
	}
	if databaseURL == "" || fixturePath == "" {
		t.Fatal("Aera Admin E2E acceptance environment is incomplete")
	}

	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	postgres, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		t.Fatal("open E2E audit database")
	}
	defer postgres.Close()
	service, err := audit.NewService(postgres)
	if err != nil {
		t.Fatal("create E2E audit verifier")
	}
	if err := service.Verify(ctx); err != nil {
		t.Fatal("E2E audit hash chain is invalid")
	}

	var count int
	var auditText string
	if err := postgres.QueryRow(ctx, `
		SELECT count(*), COALESCE(string_agg(concat_ws(E'\x1f',
			COALESCE(actor_role, ''), event_type, object_type, outcome,
			COALESCE(reason_code, ''), COALESCE(ticket_reference, ''), COALESCE(note, ''),
			COALESCE(error_code, ''), COALESCE(before_state::text, ''), COALESCE(after_state::text, ''),
			request_id, COALESCE(approval_id::text, ''), COALESCE(operation_id::text, ''),
			COALESCE(user_agent, '')
		), E'\n'), '')
		FROM admin_audit_events
	`).Scan(&count, &auditText); err != nil {
		t.Fatal("read E2E audit text")
	}
	if count < 10 {
		t.Fatalf("E2E audit event count = %d, want at least 10", count)
	}

	encoded, err := os.ReadFile(fixturePath)
	if err != nil {
		t.Fatal("read E2E sensitive canary fixture")
	}
	var fixture struct {
		SensitiveCanaries []struct {
			Kind  string `json:"kind"`
			Value string `json:"value"`
		} `json:"sensitiveCanaries"`
	}
	if err := json.Unmarshal(encoded, &fixture); err != nil {
		t.Fatal("decode E2E sensitive canary fixture")
	}
	if len(fixture.SensitiveCanaries) < 20 {
		t.Fatal("E2E sensitive canary fixture is incomplete")
	}
	for index, canary := range fixture.SensitiveCanaries {
		if canary.Value != "" && strings.Contains(auditText, canary.Value) {
			t.Fatalf("audit text contains sensitive canary %d (%s)", index, canary.Kind)
		}
	}

	var requestID, approvalID, operationID string
	if err := postgres.QueryRow(ctx, `
		SELECT request_id, approval_id::text, operation_id::text
		FROM admin_audit_events
		WHERE event_type = 'account_lifecycle_approved'
		  AND approval_id IS NOT NULL AND operation_id IS NOT NULL
		ORDER BY created_at DESC, id DESC
		LIMIT 1
	`).Scan(&requestID, &approvalID, &operationID); err != nil {
		t.Fatal("successful lifecycle audit identifiers are missing")
	}
	if requestID == "" || approvalID == "" || operationID == "" {
		t.Fatal("successful lifecycle audit identifiers are empty")
	}
	var requestedCount, succeededCount int
	if err := postgres.QueryRow(ctx, `
		SELECT count(*) FROM admin_audit_events
		WHERE event_type = 'account_lifecycle_requested' AND approval_id = $1
	`, approvalID).Scan(&requestedCount); err != nil {
		t.Fatal("read lifecycle request audit linkage")
	}
	if err := postgres.QueryRow(ctx, `
		SELECT count(*) FROM admin_audit_events
		WHERE event_type = 'cloud_operation_succeeded' AND approval_id = $1 AND operation_id = $2
	`, approvalID, operationID).Scan(&succeededCount); err != nil {
		t.Fatal("read lifecycle execution audit linkage")
	}
	if requestedCount < 1 || succeededCount < 1 {
		t.Fatalf("lifecycle audit linkage requested=%d succeeded=%d", requestedCount, succeededCount)
	}
}
