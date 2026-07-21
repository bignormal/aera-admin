package approval

import (
	"context"
	"errors"
	"testing"

	"github.com/bignormal/aera-admin/internal/admin"
	"github.com/bignormal/aera-admin/internal/operations"
	"github.com/bignormal/aera-admin/internal/rbac"
	"github.com/bignormal/aera-admin/internal/testkit"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

func TestCreateRequiresOperatorAndAllowedTargetState(t *testing.T) {
	postgres := testkit.Postgres(t)
	fixture := newApprovalFixture(t, postgres)

	_, err := fixture.service.Create(context.Background(), CreateRequest{
		Actor: fixture.firstSuperAdmin, Action: DisableUser, TargetUserID: fixture.user.ID,
		Reason: admin.ActionReason{Code: "policy_violation", Meta: fixture.firstSuperAdmin.Meta},
	})
	if !errors.Is(err, ErrPermissionDenied) {
		t.Fatalf("super-admin Create() error = %v", err)
	}

	request, err := fixture.service.Create(context.Background(), CreateRequest{
		Actor: fixture.operator, Action: EnableUser, TargetUserID: fixture.user.ID,
		Reason: admin.ActionReason{Code: "account_recovery", Meta: fixture.operator.Meta},
	})
	if !errors.Is(err, ErrTargetState) || request.ID != uuid.Nil {
		t.Fatalf("invalid target Create() = %+v, %v", request, err)
	}
}

func TestRejectAndCancelNeverEnqueueOperations(t *testing.T) {
	t.Run("reject", func(t *testing.T) {
		postgres := testkit.Postgres(t)
		fixture := newApprovalFixture(t, postgres)
		pending := fixture.createPending(t)
		rejected, err := fixture.service.Reject(context.Background(), fixture.firstSuperAdmin, pending.ID)
		if err != nil {
			t.Fatal(err)
		}
		if rejected.Status != Rejected || rejected.ExecutionStatus != NotStarted {
			t.Fatalf("rejected = %+v", rejected)
		}
		assertNoApprovalOutbox(t, postgres, pending.ID)
	})

	t.Run("cancel", func(t *testing.T) {
		postgres := testkit.Postgres(t)
		fixture := newApprovalFixture(t, postgres)
		pending := fixture.createPending(t)
		cancelled, err := fixture.service.Cancel(context.Background(), fixture.operator, pending.ID)
		if err != nil {
			t.Fatal(err)
		}
		if cancelled.Status != Cancelled || cancelled.ExecutionStatus != NotStarted {
			t.Fatalf("cancelled = %+v", cancelled)
		}
		assertNoApprovalOutbox(t, postgres, pending.ID)
	})
}

func TestOperatorCanOnlyListOwnApprovalRequests(t *testing.T) {
	postgres := testkit.Postgres(t)
	fixture := newApprovalFixture(t, postgres)
	fixture.createPending(t)
	otherOperator := seedApprovalActor(t, postgres, rbac.Operator, "req-other-operator")

	page, err := fixture.service.List(context.Background(), otherOperator, ListFilter{View: "all", Limit: 20})
	if err != nil {
		t.Fatal(err)
	}
	if len(page.Items) != 0 {
		t.Fatalf("other operator saw %d approval requests", len(page.Items))
	}
	page, err = fixture.service.List(context.Background(), fixture.operator, ListFilter{View: "all", Limit: 20})
	if err != nil {
		t.Fatal(err)
	}
	if len(page.Items) != 1 || page.Items[0].RequestedByAdminID != fixture.operator.AdminID {
		t.Fatalf("operator page = %+v", page)
	}
}

func TestApplyExecutionTxAdvancesApprovedRequestAtomically(t *testing.T) {
	postgres := testkit.Postgres(t)
	fixture := newApprovalFixture(t, postgres)
	pending := fixture.createPending(t)
	approved, err := fixture.service.Approve(
		context.Background(), fixture.firstSuperAdmin, pending.ID, "019f0000-0000-7000-8000-000000000099",
	)
	if err != nil {
		t.Fatal(err)
	}
	if approved.OperationID == nil || approved.ExecutionStatus != Queued {
		t.Fatalf("approved = %+v", approved)
	}

	apply := func(state operations.State, resultCode string) error {
		tx, err := postgres.Begin(context.Background())
		if err != nil {
			return err
		}
		defer func() { _ = tx.Rollback(context.Background()) }()
		if err := fixture.service.ApplyExecutionTx(
			context.Background(), tx, *approved.OperationID, state, resultCode,
			fixture.firstSuperAdmin.Meta.RequestID, approvalClock(),
		); err != nil {
			return err
		}
		return tx.Commit(context.Background())
	}
	if err := apply(operations.StateExecuting, ""); err != nil {
		t.Fatal(err)
	}
	if err := apply(operations.StateSucceeded, ""); err != nil {
		t.Fatal(err)
	}
	final, err := fixture.service.Get(context.Background(), fixture.firstSuperAdmin, pending.ID)
	if err != nil {
		t.Fatal(err)
	}
	if final.ExecutionStatus != Succeeded {
		t.Fatalf("final execution status = %s", final.ExecutionStatus)
	}
	if err := apply(operations.StateExecuting, ""); !errors.Is(err, ErrStateConflict) {
		t.Fatalf("terminal execution transition error = %v", err)
	}
}

func assertNoApprovalOutbox(t *testing.T, postgres *pgxpool.Pool, approvalID uuid.UUID) {
	t.Helper()
	var count int
	if err := postgres.QueryRow(context.Background(), `SELECT count(*) FROM admin_outbox WHERE approval_id = $1`, approvalID).Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != 0 {
		t.Fatalf("approval outbox count = %d", count)
	}
}
