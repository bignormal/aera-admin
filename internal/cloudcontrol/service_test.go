package cloudcontrol

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/bignormal/aera-admin/internal/admin"
	"github.com/bignormal/aera-admin/internal/audit"
	"github.com/bignormal/aera-admin/internal/cloudadmin"
	"github.com/bignormal/aera-admin/internal/rbac"
	"github.com/bignormal/aera-admin/internal/testkit"
	"github.com/google/uuid"
)

func TestLookupUserAuditsOnlyTheMaskedCloudUserReference(t *testing.T) {
	postgres := testkit.Postgres(t)
	auditService, err := audit.NewService(postgres)
	if err != nil {
		t.Fatalf("audit.NewService() error = %v", err)
	}
	actorID := uuid.New()
	now := time.Now().UTC().Truncate(time.Microsecond)
	if _, err := postgres.Exec(context.Background(), `
		INSERT INTO admin_users (id, display_name, role, status, created_at, updated_at)
		VALUES ($1, 'Lookup Support', 'support', 'active', $2, $2)
	`, actorID, now); err != nil {
		t.Fatalf("insert lookup actor: %v", err)
	}
	rawIdentity := "lookup.service.canary@example.test"
	cloud := &lookupCloudClient{result: serviceMaskedUser()}
	service := &Service{cloud: cloud, audit: auditService}
	actor := admin.Actor{
		AdminID: actorID,
		Role:    rbac.Support,
		Meta:    admin.RequestMeta{RequestID: "req-service-lookup", UserAgent: "service-test"},
	}

	result, err := service.LookupUser(context.Background(), actor, cloudadmin.LookupRequest{
		Kind: cloudadmin.IdentityEmail, Value: rawIdentity,
	})
	if err != nil {
		t.Fatalf("LookupUser() error = %v", err)
	}
	if result.ID != cloud.result.ID || cloud.observed.Value != rawIdentity {
		t.Fatalf("lookup result/observed = %s/%q", result.ID, cloud.observed.Value)
	}

	var eventType string
	var objectID uuid.UUID
	var serialized string
	if err := postgres.QueryRow(context.Background(), `
		SELECT event_type, object_id, to_jsonb(event)::text
		FROM admin_audit_events AS event
		WHERE request_id = 'req-service-lookup'
	`).Scan(&eventType, &objectID, &serialized); err != nil {
		t.Fatalf("read lookup audit event: %v", err)
	}
	if eventType != "cloud_identity_lookup_email" || objectID != cloud.result.ID {
		t.Fatalf("lookup audit event = %q/%s", eventType, objectID)
	}
	if strings.Contains(serialized, rawIdentity) {
		t.Fatal("raw lookup identity was persisted in the immutable audit event")
	}
}

func TestLookupUserRejectsInvalidExactIdentityBeforeCloudCall(t *testing.T) {
	cloud := &lookupCloudClient{result: serviceMaskedUser()}
	service := &Service{cloud: cloud}
	actor := admin.Actor{AdminID: uuid.New(), Role: rbac.Support}

	_, err := service.LookupUser(context.Background(), actor, cloudadmin.LookupRequest{
		Kind: cloudadmin.IdentityEmail, Value: "a***@example.test",
	})
	if err != ErrInvalidRequest {
		t.Fatalf("LookupUser(masked input) error = %v, want ErrInvalidRequest", err)
	}
	if cloud.calls != 0 {
		t.Fatalf("Cloud lookup calls = %d, want 0", cloud.calls)
	}
}

type lookupCloudClient struct {
	cloudadmin.DisabledClient
	result   cloudadmin.User
	observed cloudadmin.LookupRequest
	calls    int
}

func (client *lookupCloudClient) LookupUser(_ context.Context, input cloudadmin.LookupRequest) (cloudadmin.User, error) {
	client.calls++
	client.observed = input
	return client.result, nil
}

func serviceMaskedUser() cloudadmin.User {
	return cloudadmin.User{
		ID:                     uuid.MustParse("019f0000-0000-7000-8000-000000000051"),
		MaskedEmail:            "l***@example.test",
		Status:                 cloudadmin.UserActive,
		AdministrativeRevision: 7,
		CreatedAt:              time.Date(2026, 7, 22, 8, 0, 0, 0, time.UTC),
	}
}
