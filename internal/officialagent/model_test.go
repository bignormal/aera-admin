package officialagent

import (
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/bignormal/aera-admin/internal/admin"
	"github.com/bignormal/aera-admin/internal/operations"
	"github.com/bignormal/aera-admin/internal/rbac"
	"github.com/google/uuid"
)

func TestOfficialMutationRoleMatrixAndRollbackSeparation(t *testing.T) {
	actions := []operations.Action{
		operations.OfficialDefinitionReserve, operations.OfficialDraftCreate, operations.OfficialDraftUpdate,
		operations.OfficialDraftSubmit, operations.OfficialSubmissionWithdraw, operations.OfficialSubmissionReview,
		operations.OfficialReleaseActivate, operations.OfficialReleaseRollout, operations.OfficialReleasePause,
		operations.OfficialReleaseResume, operations.OfficialReleaseRollback,
	}
	want := map[rbac.Role]map[operations.Action]bool{
		rbac.Developer: {
			operations.OfficialDefinitionReserve: true, operations.OfficialDraftCreate: true,
			operations.OfficialDraftUpdate: true, operations.OfficialDraftSubmit: true,
			operations.OfficialSubmissionWithdraw: true,
		},
		rbac.SuperAdmin: {operations.OfficialSubmissionReview: true},
		rbac.Operator: {
			operations.OfficialReleaseActivate: true, operations.OfficialReleaseRollout: true,
			operations.OfficialReleasePause: true, operations.OfficialReleaseResume: true,
		},
	}
	for _, role := range rbac.Roles() {
		for _, action := range actions {
			if got := mutationAllowed(role, action); got != want[role][action] {
				t.Errorf("mutationAllowed(%s, %s) = %t", role, action, got)
			}
		}
	}
}

func TestRollbackApprovalEnforcesDifferentReviewerAndExpiry(t *testing.T) {
	now := time.Date(2026, 7, 22, 8, 0, 0, 0, time.UTC)
	requester := admin.Actor{AdminID: uuid.New(), Role: rbac.Operator}
	approval := RollbackApproval{
		ID: uuid.New(), ReleaseID: uuid.New(), TargetVersionID: uuid.New(),
		TargetReleaseRevisionID: uuid.New(), ExpectedHeadRevision: 4,
		TargetDigest: strings.Repeat("a", 64), RequestedByAdminID: requester.AdminID,
		ReasonCode: "official_release_rollback", ApprovalStatus: PendingReview,
		ExecutionStatus: NotStarted, ExpiresAt: now.Add(time.Hour), CreatedAt: now, UpdatedAt: now, Version: 1,
	}
	if err := approval.CanReview(admin.Actor{AdminID: requester.AdminID, Role: rbac.SuperAdmin}, now); !errors.Is(err, ErrSelfReview) {
		t.Fatalf("same-admin review error = %v", err)
	}
	if err := approval.CanReview(admin.Actor{AdminID: uuid.New(), Role: rbac.SuperAdmin}, now.Add(2*time.Hour)); !errors.Is(err, ErrExpired) {
		t.Fatalf("expired review error = %v", err)
	}
	if err := approval.CanReview(admin.Actor{AdminID: uuid.New(), Role: rbac.SuperAdmin}, now); err != nil {
		t.Fatalf("different Super Admin review error = %v", err)
	}
	if err := approval.CanCancel(requester, now); err != nil {
		t.Fatalf("requester cancel error = %v", err)
	}
	if err := approval.CanCancel(admin.Actor{AdminID: uuid.New(), Role: rbac.Operator}, now); !errors.Is(err, ErrPermissionDenied) {
		t.Fatalf("foreign cancel error = %v", err)
	}
}
