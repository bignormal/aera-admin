package settings

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/bignormal/aera-admin/internal/testkit"
)

func TestStoreReadsPolicyAndFiltersReasonCatalogByUsage(t *testing.T) {
	postgres := testkit.Postgres(t)
	store, err := NewStore(postgres)
	if err != nil {
		t.Fatalf("NewStore() error = %v", err)
	}
	ctx := context.Background()
	policy, err := store.GetPolicy(ctx)
	if err != nil {
		t.Fatalf("GetPolicy() error = %v", err)
	}
	if policy.SessionIdleMinutes != 30 || policy.SessionAbsoluteHours != 8 ||
		policy.AuditRetentionDays != 730 || policy.Revision != 1 {
		t.Fatalf("default policy = %+v", policy)
	}
	idle, absolute, err := store.SessionLifetimes(ctx)
	if err != nil || idle != 30*time.Minute || absolute != 8*time.Hour {
		t.Fatalf("SessionLifetimes() = %s, %s, %v", idle, absolute, err)
	}

	page, err := store.ListReasonCodes(ctx, ReasonQuery{Usage: UsageAccount})
	if err != nil {
		t.Fatalf("ListReasonCodes(account) error = %v", err)
	}
	if page.SettingsRevision != 1 || len(page.Items) == 0 {
		t.Fatalf("account reason page = %+v", page)
	}
	for _, item := range page.Items {
		if !item.Active || !CompatibleReason(UsageAccount, item.Category) {
			t.Fatalf("usage page contains incompatible reason: %+v", item)
		}
	}

	all, err := store.ListReasonCodes(ctx, ReasonQuery{IncludeInactive: true})
	if err != nil || len(all.Items) <= len(page.Items) {
		t.Fatalf("all reason page = %+v, %v", all, err)
	}
}

func TestStoreValidatesActiveCompatibleReasons(t *testing.T) {
	postgres := testkit.Postgres(t)
	store, err := NewStore(postgres)
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	if err := store.ValidateReason(ctx, UsageAccount, "customer_request"); err != nil {
		t.Fatalf("ValidateReason(account) error = %v", err)
	}
	if err := store.ValidateReason(ctx, UsageSettings, "security_policy_change"); err != nil {
		t.Fatalf("ValidateReason(settings) error = %v", err)
	}
	if err := store.ValidateReason(ctx, UsageSettings, "customer_request"); !errors.Is(err, ErrReasonIncompatible) {
		t.Fatalf("incompatible ValidateReason() error = %v", err)
	}
	if err := store.ValidateReason(ctx, UsageAccount, "does_not_exist"); !errors.Is(err, ErrReasonNotFound) {
		t.Fatalf("unknown ValidateReason() error = %v", err)
	}
	if _, err := postgres.Exec(ctx, `UPDATE reason_codes SET active = FALSE WHERE code = 'customer_request'`); err != nil {
		t.Fatal(err)
	}
	if err := store.ValidateReason(ctx, UsageAccount, "customer_request"); !errors.Is(err, ErrReasonInactive) {
		t.Fatalf("inactive ValidateReason() error = %v", err)
	}
}
