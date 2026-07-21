package approval

import (
	"errors"
	"testing"
	"time"

	"github.com/bignormal/aera-admin/internal/admin"
	"github.com/bignormal/aera-admin/internal/rbac"
	"github.com/google/uuid"
)

func TestRequestReviewRulesRequireAnotherSuperAdministrator(t *testing.T) {
	requesterID := uuid.New()
	request := Request{
		ID: uuid.New(), RequestedByAdminID: requesterID, RequestedByRole: rbac.Operator,
		Status: PendingReview, ExecutionStatus: NotStarted,
		ExpiresAt: time.Date(2026, 7, 23, 8, 0, 0, 0, time.UTC), Version: 1,
	}
	now := time.Date(2026, 7, 22, 8, 0, 0, 0, time.UTC)
	cases := []struct {
		name  string
		actor admin.Actor
		want  error
	}{
		{"requester", admin.Actor{AdminID: requesterID, Role: rbac.SuperAdmin}, ErrSelfReview},
		{"operator", admin.Actor{AdminID: uuid.New(), Role: rbac.Operator}, ErrPermissionDenied},
		{"different super admin", admin.Actor{AdminID: uuid.New(), Role: rbac.SuperAdmin}, nil},
	}
	for _, item := range cases {
		t.Run(item.name, func(t *testing.T) {
			err := request.CanReview(item.actor, now)
			if !errors.Is(err, item.want) {
				t.Fatalf("CanReview() error = %v, want %v", err, item.want)
			}
		})
	}
}

func TestRequestCannotReviewExpiredOrFinalState(t *testing.T) {
	request := Request{
		ID: uuid.New(), RequestedByAdminID: uuid.New(), RequestedByRole: rbac.Operator,
		Status: PendingReview, ExecutionStatus: NotStarted,
		ExpiresAt: time.Date(2026, 7, 22, 8, 0, 0, 0, time.UTC), Version: 1,
	}
	actor := admin.Actor{AdminID: uuid.New(), Role: rbac.SuperAdmin}
	if err := request.CanReview(actor, request.ExpiresAt); !errors.Is(err, ErrExpired) {
		t.Fatalf("CanReview() error = %v", err)
	}
	request.Status = Rejected
	if err := request.CanReview(actor, request.ExpiresAt.Add(-time.Second)); !errors.Is(err, ErrStateConflict) {
		t.Fatalf("final CanReview() error = %v", err)
	}
}
