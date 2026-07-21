package operations

import (
	"bytes"
	"context"
	"errors"
	"testing"

	"github.com/bignormal/aera-admin/internal/admin"
	"github.com/bignormal/aera-admin/internal/audit"
	"github.com/bignormal/aera-admin/internal/cloudadmin"
	"github.com/bignormal/aera-admin/internal/rbac"
	"github.com/bignormal/aera-admin/internal/testkit"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

type cloudStub struct {
	cloudadmin.DisabledClient
	health cloudadmin.Health
	err    error
}

func (stub cloudStub) Health(context.Context) (cloudadmin.Health, error) {
	return stub.health, stub.err
}

func TestEnqueueImmediateDoesNotWriteWhenCloudIsUnavailable(t *testing.T) {
	postgres := testkit.Postgres(t)
	service := newTestService(t, postgres, cloudStub{
		health: cloudadmin.Health{Availability: cloudadmin.Unavailable},
		err:    cloudadmin.ErrUnavailable,
	})
	request := validImmediateRequest(t, postgres, RevokeDevice, rbac.Support)
	if _, err := service.EnqueueImmediate(context.Background(), request); !errors.Is(err, ErrCloudUnavailable) {
		t.Fatalf("EnqueueImmediate() error = %v", err)
	}
	var count int
	if err := postgres.QueryRow(context.Background(), `SELECT count(*) FROM admin_outbox`).Scan(&count); err != nil || count != 0 {
		t.Fatalf("outbox count/error = %d/%v", count, err)
	}
}

func TestEnqueueImmediateQueuesSupportedOperationWhenCloudIsAvailable(t *testing.T) {
	postgres := testkit.Postgres(t)
	service := newTestService(t, postgres, cloudStub{health: cloudadmin.Health{Availability: cloudadmin.Available}})
	request := validImmediateRequest(t, postgres, RevokeSession, rbac.Operator)
	result, err := service.EnqueueImmediate(context.Background(), request)
	if err != nil {
		t.Fatal(err)
	}
	if result.OperationID == uuid.Nil || result.State != StateQueued {
		t.Fatalf("result = %+v", result)
	}
}

func TestEnqueueImmediateRejectsAccountLifecycleWithoutApproval(t *testing.T) {
	postgres := testkit.Postgres(t)
	service := newTestService(t, postgres, cloudStub{health: cloudadmin.Health{Availability: cloudadmin.Available}})
	request := validImmediateRequest(t, postgres, DisableUser, rbac.SuperAdmin)
	if _, err := service.EnqueueImmediate(context.Background(), request); !errors.Is(err, ErrInvalidRequest) {
		t.Fatalf("EnqueueImmediate() error = %v", err)
	}
}

func newTestService(t *testing.T, postgres *pgxpool.Pool, cloud cloudadmin.Client) *Service {
	t.Helper()
	recorder, err := audit.NewService(postgres)
	if err != nil {
		t.Fatal(err)
	}
	service, err := NewService(ServiceConfig{
		PostgreSQL: postgres,
		HMACKey:    bytes.Repeat([]byte{9}, 32),
		Cloud:      cloud,
		Audit:      recorder,
		Clock:      fixedClock,
	})
	if err != nil {
		t.Fatal(err)
	}
	return service
}

func validImmediateRequest(t *testing.T, postgres *pgxpool.Pool, action Action, role rbac.Role) EnqueueRequest {
	t.Helper()
	actor := seedActor(t, postgres, role)
	return EnqueueRequest{
		Actor: actor, Action: action, TargetID: uuid.New(), ExpectedRevision: 1,
		BrowserIdempotencyKey: uuid.NewString(),
		Reason:                admin.ActionReason{Code: "suspected_compromise", Meta: actor.Meta},
	}
}
