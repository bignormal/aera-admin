package audit

import (
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
)

func TestQueryValidation(t *testing.T) {
	now := time.Date(2026, time.July, 22, 7, 30, 0, 123456000, time.UTC)
	actorID := uuid.MustParse("019f0000-0000-7000-8000-000000000001")
	objectID := uuid.MustParse("019f0000-0000-7000-8000-000000000002")
	valid := Query{
		Limit: 20, ActorAdminID: &actorID, EventType: "admin_login_succeeded",
		ObjectType: "admin_user", ObjectID: &objectID, Outcome: OutcomeSuccess,
		ReasonCode: "access_review", From: now.Add(-time.Hour), To: now,
	}
	if err := valid.Validate(); err != nil {
		t.Fatalf("Validate() error = %v", err)
	}

	tests := []struct {
		name  string
		query Query
	}{
		{"zero limit", Query{Limit: 0}},
		{"large limit", Query{Limit: 101}},
		{"nil actor", Query{Limit: 20, ActorAdminID: uuidPointer(uuid.Nil)}},
		{"invalid event", Query{Limit: 20, EventType: "ADMIN LOGIN"}},
		{"invalid object", Query{Limit: 20, ObjectType: "admin/user"}},
		{"invalid outcome", Query{Limit: 20, Outcome: Outcome("maybe")}},
		{"invalid reason", Query{Limit: 20, ReasonCode: "Policy Violation"}},
		{"reversed time", Query{Limit: 20, From: now, To: now.Add(-time.Minute)}},
		{"equal time", Query{Limit: 20, From: now, To: now}},
		{"invalid cursor", Query{Limit: 20, Cursor: "not-base64!"}},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if err := test.query.Validate(); err != ErrInvalidQuery {
				t.Fatalf("Validate() error = %v, want ErrInvalidQuery", err)
			}
		})
	}
}

func TestCursorRoundTripAndStrictDecoding(t *testing.T) {
	createdAt := time.Date(2026, time.July, 22, 7, 30, 0, 123456789, time.FixedZone("offset", 8*60*60))
	id := uuid.MustParse("019f0000-0000-7000-8000-000000000001")
	cursor := EncodeCursor(createdAt, id)
	decodedAt, decodedID, err := DecodeCursor(cursor)
	if err != nil {
		t.Fatalf("DecodeCursor() error = %v", err)
	}
	wantTime := createdAt.UTC().Truncate(time.Microsecond)
	if !decodedAt.Equal(wantTime) || decodedAt.Location() != time.UTC || decodedID != id {
		t.Fatalf("decoded cursor = %s/%s, want %s/%s", decodedAt, decodedID, wantTime, id)
	}

	for _, malformed := range []string{
		"",
		"not-base64!",
		EncodeCursor(createdAt, uuid.Nil),
		strings.Repeat("a", 1024),
	} {
		if _, _, err := DecodeCursor(malformed); err != ErrInvalidQuery {
			t.Errorf("DecodeCursor(%q) error = %v, want ErrInvalidQuery", malformed, err)
		}
	}
}

func uuidPointer(value uuid.UUID) *uuid.UUID {
	return &value
}
