package audit

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"sync"
	"testing"
	"time"

	"github.com/bignormal/aera-admin/internal/testkit"
	"github.com/google/uuid"
)

func TestAppendChainsCanonicalEventsWithoutSensitiveFields(t *testing.T) {
	postgres := testkit.Postgres(t)
	service, err := NewService(postgres)
	if err != nil {
		t.Fatalf("NewService() error = %v", err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()

	firstRecord := validRecord("admin_login", "req-login")
	firstRecord.BeforeState = nil
	firstRecord.AfterState = nil
	first, err := service.Append(ctx, firstRecord)
	if err != nil {
		t.Fatalf("first Append() error = %v", err)
	}
	secondRecord := validRecord("admin_role_changed", "req-role-change")
	secondRecord.BeforeState = map[string]string{"role": "support"}
	secondRecord.AfterState = map[string]string{"role": "operator"}
	second, err := service.Append(ctx, secondRecord)
	if err != nil {
		t.Fatalf("second Append() error = %v", err)
	}

	var firstHash []byte
	if err := postgres.QueryRow(ctx, `SELECT event_hash FROM admin_audit_events WHERE id = $1`, first).Scan(&firstHash); err != nil {
		t.Fatalf("read first event hash: %v", err)
	}
	var secondPrevious []byte
	var secondUserAgent string
	if err := postgres.QueryRow(ctx, `SELECT previous_hash, user_agent FROM admin_audit_events WHERE id = $1`, second).Scan(&secondPrevious, &secondUserAgent); err != nil {
		t.Fatalf("read second event: %v", err)
	}
	if !bytes.Equal(firstHash, secondPrevious) {
		t.Fatal("second event does not reference the first event hash")
	}
	if secondUserAgent != "Chrome/150 Injected: true" {
		t.Fatalf("sanitized user agent = %q", secondUserAgent)
	}
	if err := service.Verify(ctx); err != nil {
		t.Fatalf("Verify() error = %v", err)
	}
}

func TestAppendRejectsSensitiveReasonTextBeforeUsingDatabase(t *testing.T) {
	service := &Service{}
	tests := []string{
		"contact admin@example.com",
		"call 13800138000",
		"Bearer abcdefghijklmnopqrstuvwxyz",
		"password=correct-horse-battery-staple",
		"-----BEGIN PRIVATE KEY-----",
		"postgres://admin:secret@database.example/aera",
		"eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJhZG1pbiJ9.abcdefghijklmnopqrstuvwxyz",
	}
	for _, note := range tests {
		record := validRecord("admin_suspended", "req-sensitive")
		record.Note = note
		if _, err := service.Append(context.Background(), record); !errors.Is(err, ErrSensitiveText) {
			t.Errorf("Append(note=%q) error = %v, want ErrSensitiveText", note, err)
		}
	}
}

func TestConcurrentAppendMaintainsOneVerifiableChain(t *testing.T) {
	postgres := testkit.Postgres(t)
	service, err := NewService(postgres)
	if err != nil {
		t.Fatalf("NewService() error = %v", err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()

	const count = 20
	start := make(chan struct{})
	errorsByCall := make(chan error, count)
	var wait sync.WaitGroup
	for index := 0; index < count; index++ {
		wait.Add(1)
		go func(index int) {
			defer wait.Done()
			<-start
			_, appendErr := service.Append(ctx, validRecord("admin_login", fmt.Sprintf("req-concurrent-%02d", index)))
			errorsByCall <- appendErr
		}(index)
	}
	close(start)
	wait.Wait()
	close(errorsByCall)
	for appendErr := range errorsByCall {
		if appendErr != nil {
			t.Fatalf("concurrent Append() error = %v", appendErr)
		}
	}

	var stored int
	if err := postgres.QueryRow(ctx, `SELECT count(*) FROM admin_audit_events`).Scan(&stored); err != nil {
		t.Fatalf("count audit events: %v", err)
	}
	if stored != count {
		t.Fatalf("stored events = %d, want %d", stored, count)
	}
	if err := service.Verify(ctx); err != nil {
		t.Fatalf("Verify() after concurrent append error = %v", err)
	}
}

func TestVerifyDetectsExternalTampering(t *testing.T) {
	postgres := testkit.Postgres(t)
	service, err := NewService(postgres)
	if err != nil {
		t.Fatalf("NewService() error = %v", err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	id, err := service.Append(ctx, validRecord("admin_login", "req-tamper"))
	if err != nil {
		t.Fatalf("Append() error = %v", err)
	}
	if _, err := postgres.Exec(ctx, `ALTER TABLE admin_audit_events DISABLE TRIGGER admin_audit_events_append_only`); err != nil {
		t.Fatalf("disable append-only trigger for tamper simulation: %v", err)
	}
	if _, err := postgres.Exec(ctx, `UPDATE admin_audit_events SET note = 'externally changed' WHERE id = $1`, id); err != nil {
		t.Fatalf("simulate external tampering: %v", err)
	}
	if _, err := postgres.Exec(ctx, `ALTER TABLE admin_audit_events ENABLE TRIGGER admin_audit_events_append_only`); err != nil {
		t.Fatalf("restore append-only trigger: %v", err)
	}
	if err := service.Verify(ctx); !errors.Is(err, ErrIntegrity) {
		t.Fatalf("Verify() error = %v, want ErrIntegrity", err)
	}
}

func TestNewServiceRequiresPostgreSQL(t *testing.T) {
	if _, err := NewService(nil); err == nil {
		t.Fatal("NewService(nil) succeeded")
	}
}

func validRecord(eventType, requestID string) Record {
	objectID := uuid.New()
	return Record{
		EventType:       eventType,
		ObjectType:      "admin_user",
		ObjectID:        &objectID,
		Outcome:         OutcomeSuccess,
		ReasonCode:      "access_review",
		TicketReference: "SUP-42",
		Note:            "approved security review",
		RequestID:       requestID,
		SourceIPHMAC:    bytes.Repeat([]byte{7}, 32),
		UserAgent:       "Chrome/150\nInjected: true",
		BeforeState:     map[string]string{"status": "invited"},
		AfterState:      map[string]string{"status": "active"},
	}
}
