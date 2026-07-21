package admin

import (
	"bytes"
	"context"
	"errors"
	"testing"
	"time"

	"github.com/bignormal/aera-admin/internal/audit"
	"github.com/bignormal/aera-admin/internal/rbac"
	"github.com/bignormal/aera-admin/internal/secure"
)

func TestInviteRollsBackIdentityWhenAuditRejectsSensitiveNote(t *testing.T) {
	fixture := newAdminFixture(t)
	request := inviteRequest("admin@example.com", "管理员", rbac.SuperAdmin)
	request.Reason.Note = "contact admin@example.com"
	if _, err := fixture.service.BootstrapInvite(context.Background(), request); !errors.Is(err, audit.ErrSensitiveText) {
		t.Fatalf("BootstrapInvite() error = %v, want audit.ErrSensitiveText", err)
	}
	var users, identities, invitations int
	if err := fixture.postgres.QueryRow(context.Background(), `
		SELECT
			(SELECT count(*) FROM admin_users),
			(SELECT count(*) FROM admin_identities),
			(SELECT count(*) FROM admin_invitations)
	`).Scan(&users, &identities, &invitations); err != nil {
		t.Fatalf("count rolled-back records: %v", err)
	}
	if users != 0 || identities != 0 || invitations != 0 {
		t.Fatalf("rolled-back record counts = users:%d identities:%d invitations:%d", users, identities, invitations)
	}
}

func TestInviteRejectsDuplicateEncryptedIdentity(t *testing.T) {
	fixture := newAdminFixture(t)
	first := inviteRequest("Admin@Example.com", "首位管理员", rbac.SuperAdmin)
	if _, err := fixture.service.BootstrapInvite(context.Background(), first); err != nil {
		t.Fatalf("first BootstrapInvite() error = %v", err)
	}
	second := inviteRequest(" admin@example.com ", "重复管理员", rbac.SuperAdmin)
	if _, err := fixture.service.BootstrapInvite(context.Background(), second); !errors.Is(err, ErrIdentityExists) {
		t.Fatalf("duplicate BootstrapInvite() error = %v, want ErrIdentityExists", err)
	}
}

func TestInviteRejectsDuplicateIdentityAcrossLookupKeyRotation(t *testing.T) {
	fixture := newAdminFixture(t)
	if _, err := fixture.service.BootstrapInvite(context.Background(), inviteRequest("admin@example.com", "首位管理员", rbac.SuperAdmin)); err != nil {
		t.Fatalf("first BootstrapInvite() error = %v", err)
	}
	rotatedIdentities, err := secure.NewIdentityCodec(secure.IdentityCodecConfig{
		ActiveEncryptionKeyID: "identity-v1",
		EncryptionKeys:        map[string][]byte{"identity-v1": bytes.Repeat([]byte{1}, 32)},
		ActiveLookupKeyID:     "lookup-v2",
		LookupKeys: map[string][]byte{
			"lookup-v1": bytes.Repeat([]byte{2}, 32),
			"lookup-v2": bytes.Repeat([]byte{8}, 32),
		},
	})
	if err != nil {
		t.Fatalf("NewIdentityCodec(rotated) error = %v", err)
	}
	rotatedService, err := NewService(ServiceConfig{
		PostgreSQL: fixture.postgres, Passwords: fixture.passwords, Identities: rotatedIdentities,
		TOTPSecrets: fixture.secrets, TOTP: fixture.totp, Audit: fixture.audit,
		PublicURL: "https://admin.example.test", Clock: func() time.Time { return fixture.now },
	})
	if err != nil {
		t.Fatalf("NewService(rotated) error = %v", err)
	}
	if _, err := rotatedService.BootstrapInvite(context.Background(), inviteRequest("ADMIN@example.com", "重复管理员", rbac.SuperAdmin)); !errors.Is(err, ErrIdentityExists) {
		t.Fatalf("rotated duplicate BootstrapInvite() error = %v, want ErrIdentityExists", err)
	}
}

func TestExpiredInvitationCanBeReissuedWithoutDuplicatingAdministrator(t *testing.T) {
	fixture := newAdminFixture(t)
	first, err := fixture.service.BootstrapInvite(context.Background(), inviteRequest("admin@example.com", "首位管理员", rbac.SuperAdmin))
	if err != nil {
		t.Fatalf("first BootstrapInvite() error = %v", err)
	}
	fixture.now = fixture.now.Add(25 * time.Hour)
	fixture.service.clock = func() time.Time { return fixture.now }
	reissued, err := fixture.service.BootstrapInvite(context.Background(), inviteRequest("ADMIN@example.com", "首位管理员（重发）", rbac.SuperAdmin))
	if err != nil {
		t.Fatalf("reissued BootstrapInvite() error = %v", err)
	}
	if reissued.AdminID != first.AdminID || reissued.InvitationID == first.InvitationID {
		t.Fatalf("reissued invitation = %+v, first = %+v", reissued, first)
	}
	var users, invitations int
	var firstConsumed, firstSecretCleared bool
	if err := fixture.postgres.QueryRow(context.Background(), `
		SELECT
			(SELECT count(*) FROM admin_users),
			(SELECT count(*) FROM admin_invitations),
			(SELECT consumed_at IS NOT NULL FROM admin_invitations WHERE id = $1),
			(SELECT num_nonnulls(totp_encryption_key_id, totp_nonce, totp_ciphertext) = 0 FROM admin_invitations WHERE id = $1)
	`, first.InvitationID).Scan(&users, &invitations, &firstConsumed, &firstSecretCleared); err != nil {
		t.Fatalf("read reissue state: %v", err)
	}
	if users != 1 || invitations != 2 || !firstConsumed || !firstSecretCleared {
		t.Fatalf("reissue state = users:%d invitations:%d firstConsumed:%v firstSecretCleared:%v", users, invitations, firstConsumed, firstSecretCleared)
	}
}
