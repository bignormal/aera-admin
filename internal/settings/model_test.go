package settings

import (
	"bytes"
	"testing"
	"time"
)

func TestPolicyValidationAndLifetimes(t *testing.T) {
	valid := Policy{SessionIdleMinutes: 30, SessionAbsoluteHours: 8, AuditRetentionDays: 730, Revision: 1}
	if err := valid.Validate(); err != nil {
		t.Fatalf("valid Policy.Validate() error = %v", err)
	}
	idle, absolute, err := valid.SessionLifetimes()
	if err != nil || idle != 30*time.Minute || absolute != 8*time.Hour {
		t.Fatalf("SessionLifetimes() = %s, %s, %v", idle, absolute, err)
	}

	invalid := []Policy{
		{SessionIdleMinutes: 4, SessionAbsoluteHours: 8, AuditRetentionDays: 730, Revision: 1},
		{SessionIdleMinutes: 121, SessionAbsoluteHours: 8, AuditRetentionDays: 730, Revision: 1},
		{SessionIdleMinutes: 60, SessionAbsoluteHours: 1, AuditRetentionDays: 730, Revision: 1},
		{SessionIdleMinutes: 30, SessionAbsoluteHours: 25, AuditRetentionDays: 730, Revision: 1},
		{SessionIdleMinutes: 30, SessionAbsoluteHours: 8, AuditRetentionDays: 364, Revision: 1},
		{SessionIdleMinutes: 30, SessionAbsoluteHours: 8, AuditRetentionDays: 3651, Revision: 1},
		{SessionIdleMinutes: 30, SessionAbsoluteHours: 8, AuditRetentionDays: 730, Revision: 0},
	}
	for index, policy := range invalid {
		if err := policy.Validate(); err == nil {
			t.Errorf("invalid policy %d passed validation: %+v", index, policy)
		}
	}
}

func TestReasonCodeValidationCompatibilityAndProtection(t *testing.T) {
	now := time.Date(2026, 7, 22, 8, 0, 0, 0, time.UTC)
	valid := ReasonCode{
		Code: "security_review", Category: CategorySecurity, Label: "安全复核", Active: true,
		Revision: 1, CreatedAt: now, UpdatedAt: now,
	}
	if err := valid.Validate(); err != nil {
		t.Fatalf("valid ReasonCode.Validate() error = %v", err)
	}

	invalid := []ReasonCode{
		{Code: "UPPER", Category: CategorySecurity, Label: "安全复核", Active: true, Revision: 1, CreatedAt: now, UpdatedAt: now},
		{Code: "security_review", Category: ReasonCategory("unknown"), Label: "安全复核", Active: true, Revision: 1, CreatedAt: now, UpdatedAt: now},
		{Code: "security_review", Category: CategorySecurity, Label: "", Active: true, Revision: 1, CreatedAt: now, UpdatedAt: now},
		{Code: "security_review", Category: CategorySecurity, Label: "联系 admin@example.test", Active: true, Revision: 1, CreatedAt: now, UpdatedAt: now},
		{Code: "security_review", Category: CategorySecurity, Label: "安全复核", Active: true, Revision: 0, CreatedAt: now, UpdatedAt: now},
	}
	for index, reason := range invalid {
		if err := reason.Validate(); err == nil {
			t.Errorf("invalid reason %d passed validation: %+v", index, reason)
		}
	}

	compatible := []struct {
		usage    ReasonUsage
		category ReasonCategory
	}{
		{UsageAdministrator, CategoryAdministrator}, {UsageAdministrator, CategorySecurity},
		{UsageAccount, CategoryAccount}, {UsageAccount, CategorySecurity},
		{UsageDevice, CategoryDevice}, {UsageDevice, CategorySecurity},
		{UsageSession, CategorySession}, {UsageSession, CategorySecurity},
		{UsageSettings, CategorySecurity},
	}
	for _, item := range compatible {
		if !CompatibleReason(item.usage, item.category) {
			t.Errorf("CompatibleReason(%q, %q) = false", item.usage, item.category)
		}
	}
	if CompatibleReason(UsageSettings, CategoryAccount) || CompatibleReason(UsageAccount, CategoryDevice) {
		t.Fatal("incompatible reason category was accepted")
	}
	if !ProtectedReasonCode("security_policy_change") || !ProtectedReasonCode("reason_catalog_change") || ProtectedReasonCode("security_review") {
		t.Fatal("protected reason-code set is incorrect")
	}
}

func TestMutationValidationAndCanonicalRequestDigests(t *testing.T) {
	policy := UpdatePolicyInput{
		ExpectedRevision: 1, SessionIdleMinutes: 30, SessionAbsoluteHours: 8, AuditRetentionDays: 730,
		MutationReason: MutationReason{ReasonCode: "security_policy_change", TicketReference: "SEC-42", Note: "approved policy update"},
	}
	if err := policy.Validate(); err != nil {
		t.Fatalf("UpdatePolicyInput.Validate() error = %v", err)
	}
	first := policyRequestDigest(policy)
	second := policyRequestDigest(policy)
	if !bytes.Equal(first[:], second[:]) {
		t.Fatal("same policy request produced different digests")
	}
	policy.AuditRetentionDays++
	changed := policyRequestDigest(policy)
	if bytes.Equal(first[:], changed[:]) {
		t.Fatal("different policy request produced the same digest")
	}

	invalidReason := policy
	invalidReason.MutationReason.Note = "Bearer abcdefghijklmnopqrstuvwxyz"
	if err := invalidReason.Validate(); err == nil {
		t.Fatal("credential-shaped mutation note passed validation")
	}
}
