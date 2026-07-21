package approval

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"sync"
	"testing"
	"time"

	"github.com/bignormal/aera-admin/internal/admin"
	"github.com/bignormal/aera-admin/internal/audit"
	"github.com/bignormal/aera-admin/internal/cloudadmin"
	"github.com/bignormal/aera-admin/internal/operations"
	"github.com/bignormal/aera-admin/internal/rbac"
	"github.com/bignormal/aera-admin/internal/testkit"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

func TestConcurrentApproveHasOneStateTransitionAndOneOutbox(t *testing.T) {
	postgres := testkit.Postgres(t)
	fixture := newApprovalFixture(t, postgres)
	request := fixture.createPending(t)
	reviewers := []admin.Actor{fixture.firstSuperAdmin, fixture.secondSuperAdmin}
	results := make(chan error, len(reviewers))
	var wait sync.WaitGroup
	for index, reviewer := range reviewers {
		wait.Add(1)
		go func(index int, reviewer admin.Actor) {
			defer wait.Done()
			_, err := fixture.service.Approve(
				context.Background(), reviewer, request.ID,
				fmt.Sprintf("019f0000-0000-7000-8000-%012d", index+31),
			)
			results <- err
		}(index, reviewer)
	}
	wait.Wait()
	close(results)
	successes, conflicts := 0, 0
	for err := range results {
		switch {
		case err == nil:
			successes++
		case errors.Is(err, ErrStateConflict):
			conflicts++
		default:
			t.Fatalf("unexpected approval error: %v", err)
		}
	}
	if successes != 1 || conflicts != 1 {
		t.Fatalf("success/conflict = %d/%d", successes, conflicts)
	}
	var approved, outbox, events int
	if err := postgres.QueryRow(context.Background(), `
		SELECT count(*) FROM approval_requests
		WHERE id = $1 AND approval_status = 'approved' AND execution_status = 'queued'
	`, request.ID).Scan(&approved); err != nil {
		t.Fatal(err)
	}
	if err := postgres.QueryRow(context.Background(), `SELECT count(*) FROM admin_outbox WHERE approval_id = $1`, request.ID).Scan(&outbox); err != nil {
		t.Fatal(err)
	}
	if err := postgres.QueryRow(context.Background(), `
		SELECT count(*) FROM approval_events
		WHERE approval_request_id = $1 AND event_type = 'approved'
	`, request.ID).Scan(&events); err != nil {
		t.Fatal(err)
	}
	if approved != 1 || outbox != 1 || events != 1 {
		t.Fatalf("approved/outbox/events = %d/%d/%d", approved, outbox, events)
	}
}

type approvalCloudStub struct {
	cloudadmin.DisabledClient
	user cloudadmin.User
}

func (stub approvalCloudStub) Health(context.Context) (cloudadmin.Health, error) {
	return cloudadmin.Health{Configured: true, Availability: cloudadmin.Available, CheckedAt: approvalClock()}, nil
}

func (stub approvalCloudStub) GetUser(context.Context, uuid.UUID) (cloudadmin.User, error) {
	return stub.user, nil
}

type approvalFixture struct {
	service          *Service
	operator         admin.Actor
	firstSuperAdmin  admin.Actor
	secondSuperAdmin admin.Actor
	user             cloudadmin.User
}

func approvalClock() time.Time {
	return time.Date(2026, 7, 22, 8, 0, 0, 0, time.UTC)
}

func seedApprovalActor(t *testing.T, postgres *pgxpool.Pool, role rbac.Role, requestID string) admin.Actor {
	t.Helper()
	id := uuid.New()
	_, err := postgres.Exec(context.Background(), `
		INSERT INTO admin_users (id, display_name, role, status, security_version, created_at, updated_at)
		VALUES ($1, 'Approval Test Actor', $2, 'active', 1, now(), now())
	`, id, role)
	if err != nil {
		t.Fatal(err)
	}
	return admin.Actor{AdminID: id, Role: role, Meta: admin.RequestMeta{RequestID: requestID, UserAgent: "approval-test"}}
}

func newApprovalFixture(t *testing.T, postgres *pgxpool.Pool) *approvalFixture {
	t.Helper()
	recorder, err := audit.NewService(postgres)
	if err != nil {
		t.Fatal(err)
	}
	user := cloudadmin.User{
		ID: uuid.New(), MaskedEmail: "a***@example.test", Status: cloudadmin.UserActive,
		AdministrativeRevision: 7, CreatedAt: approvalClock(),
	}
	cloud := approvalCloudStub{user: user}
	operationService, err := operations.NewService(operations.ServiceConfig{
		PostgreSQL: postgres, HMACKey: bytes.Repeat([]byte{8}, 32), Cloud: cloud,
		Audit: recorder, Clock: approvalClock,
	})
	if err != nil {
		t.Fatal(err)
	}
	service, err := NewService(ServiceConfig{
		PostgreSQL: postgres, Cloud: cloud, Operations: operationService, Audit: recorder, Clock: approvalClock,
	})
	if err != nil {
		t.Fatal(err)
	}
	return &approvalFixture{
		service: service, user: user,
		operator:         seedApprovalActor(t, postgres, rbac.Operator, "req-approval-create"),
		firstSuperAdmin:  seedApprovalActor(t, postgres, rbac.SuperAdmin, "req-approval-review-1"),
		secondSuperAdmin: seedApprovalActor(t, postgres, rbac.SuperAdmin, "req-approval-review-2"),
	}
}

func (fixture *approvalFixture) createPending(t *testing.T) Request {
	t.Helper()
	request, err := fixture.service.Create(context.Background(), CreateRequest{
		Actor: fixture.operator, Action: DisableUser, TargetUserID: fixture.user.ID,
		Reason: admin.ActionReason{Code: "policy_violation", Meta: fixture.operator.Meta},
	})
	if err != nil {
		t.Fatal(err)
	}
	return request
}
