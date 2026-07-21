package admin

import (
	"bytes"
	"context"
	"encoding/base32"
	"encoding/json"
	"errors"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/bignormal/aera-admin/internal/audit"
	"github.com/bignormal/aera-admin/internal/rbac"
	"github.com/bignormal/aera-admin/internal/secure"
	"github.com/bignormal/aera-admin/internal/testkit"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

func TestActivationConsumesInvitationRequiresTOTPAndReturnsRecoveryCodesOnce(t *testing.T) {
	fixture := newAdminFixture(t)
	ctx := context.Background()
	invitation, err := fixture.service.BootstrapInvite(ctx, inviteRequest("Admin@Example.com", "首位超级管理员", rbac.SuperAdmin))
	if err != nil {
		t.Fatalf("BootstrapInvite() error = %v", err)
	}
	parsed, err := url.Parse(invitation.ActivationURL)
	if err != nil {
		t.Fatalf("parse activation URL: %v", err)
	}
	if parsed.RawQuery != "" || !strings.HasPrefix(parsed.Fragment, "token=") {
		t.Fatalf("activation URL exposes token outside fragment: %q", invitation.ActivationURL)
	}
	rawToken := activationToken(t, invitation.ActivationURL)

	preparation, err := fixture.service.PrepareActivation(ctx, rawToken)
	if err != nil {
		t.Fatalf("PrepareActivation() error = %v", err)
	}
	encodedPreparation, _ := json.Marshal(preparation)
	if bytes.Contains(encodedPreparation, []byte("admin@example.com")) || preparation.MaskedIdentity != "a***@example.com" {
		t.Fatalf("activation preparation leaked identity: %s", encodedPreparation)
	}
	secret := provisioningSecret(t, preparation.ProvisioningURI)
	code := fixture.totp.Code(secret, fixture.now)
	result, err := fixture.service.Activate(ctx, ActivateRequest{
		Token: rawToken, Password: "correct horse battery staple", TOTPCode: code, Meta: requestMeta("req-activate-1"),
	})
	if err != nil {
		t.Fatalf("Activate() error = %v", err)
	}
	if result.AdminID != invitation.AdminID || len(result.RecoveryCodes) != 8 {
		t.Fatalf("Activate() result = %+v", result)
	}
	seenCodes := make(map[string]struct{}, len(result.RecoveryCodes))
	for _, recoveryCode := range result.RecoveryCodes {
		if len(recoveryCode) < 32 {
			t.Fatalf("recovery code is too short: %q", recoveryCode)
		}
		seenCodes[recoveryCode] = struct{}{}
	}
	if len(seenCodes) != 8 {
		t.Fatalf("unique recovery codes = %d, want 8", len(seenCodes))
	}

	var status string
	var recoveryCount int
	var consumedAt *time.Time
	var pendingSecretCleared bool
	if err := fixture.postgres.QueryRow(ctx, `SELECT status FROM admin_users WHERE id = $1`, invitation.AdminID).Scan(&status); err != nil {
		t.Fatalf("read activated administrator: %v", err)
	}
	if err := fixture.postgres.QueryRow(ctx, `SELECT count(*) FROM admin_recovery_codes WHERE admin_user_id = $1`, invitation.AdminID).Scan(&recoveryCount); err != nil {
		t.Fatalf("count recovery codes: %v", err)
	}
	if err := fixture.postgres.QueryRow(ctx, `
		SELECT consumed_at, num_nonnulls(totp_encryption_key_id, totp_nonce, totp_ciphertext) = 0
		FROM admin_invitations
		WHERE id = $1
	`, invitation.InvitationID).Scan(&consumedAt, &pendingSecretCleared); err != nil {
		t.Fatalf("read invitation consumption: %v", err)
	}
	if status != "active" || recoveryCount != 8 || consumedAt == nil || !pendingSecretCleared {
		t.Fatalf("activation state = status:%q recovery:%d consumed:%v pendingSecretCleared:%v", status, recoveryCount, consumedAt, pendingSecretCleared)
	}
	if _, err := fixture.service.Activate(ctx, ActivateRequest{
		Token: rawToken, Password: "correct horse battery staple", TOTPCode: code, Meta: requestMeta("req-activate-replay"),
	}); !errors.Is(err, ErrInvalidInvitation) {
		t.Fatalf("replayed Activate() error = %v, want ErrInvalidInvitation", err)
	}
	if err := fixture.audit.Verify(ctx); err != nil {
		t.Fatalf("audit Verify() error = %v", err)
	}
}

func TestCannotReduceActiveSuperAdminsBelowTwoOrManageSelf(t *testing.T) {
	fixture := newAdminFixture(t)
	ctx := context.Background()
	first := fixture.bootstrapAndActivate(t, "first@example.com", "第一管理员", "correct horse battery staple")
	second := fixture.bootstrapAndActivate(t, "second@example.com", "第二管理员", "correct horse battery staple")
	firstActor := actor(first.AdminID, rbac.SuperAdmin, "req-first-actor")

	if err := fixture.service.ChangeRole(ctx, firstActor, second.AdminID, rbac.Operator, actionReason("req-demote-second")); !errors.Is(err, ErrMinimumSuperAdmins) {
		t.Fatalf("ChangeRole() error = %v, want ErrMinimumSuperAdmins", err)
	}
	if err := fixture.service.Suspend(ctx, firstActor, second.AdminID, actionReason("req-suspend-second")); !errors.Is(err, ErrMinimumSuperAdmins) {
		t.Fatalf("Suspend() error = %v, want ErrMinimumSuperAdmins", err)
	}
	if _, err := fixture.service.BootstrapInvite(ctx, inviteRequest("extra-bootstrap@example.com", "额外引导管理员", rbac.SuperAdmin)); !errors.Is(err, ErrBootstrapComplete) {
		t.Fatalf("third BootstrapInvite() error = %v, want ErrBootstrapComplete", err)
	}
	thirdInvitation, err := fixture.service.Invite(ctx, firstActor, inviteRequest("third@example.com", "第三管理员", rbac.SuperAdmin))
	if err != nil {
		t.Fatalf("Invite(third super admin) error = %v", err)
	}
	third := fixture.activate(t, thirdInvitation, "correct horse battery staple")
	if err := fixture.service.ChangeRole(ctx, firstActor, second.AdminID, rbac.Operator, actionReason("req-demote-with-three")); err != nil {
		t.Fatalf("ChangeRole() with three active super admins error = %v", err)
	}
	if third.AdminID == uuid.Nil {
		t.Fatal("third administrator did not activate")
	}

	if err := fixture.service.ChangeRole(ctx, firstActor, first.AdminID, rbac.Operator, actionReason("req-self-role")); !errors.Is(err, ErrSelfManagement) {
		t.Fatalf("self ChangeRole() error = %v", err)
	}
	if err := fixture.service.Suspend(ctx, firstActor, first.AdminID, actionReason("req-self-suspend")); !errors.Is(err, ErrSelfManagement) {
		t.Fatalf("self Suspend() error = %v", err)
	}
	if _, err := fixture.service.ResetTOTP(ctx, firstActor, first.AdminID, actionReason("req-self-totp")); !errors.Is(err, ErrSelfManagement) {
		t.Fatalf("self ResetTOTP() error = %v", err)
	}
}

func TestActivationCredentialSnapshotDetectsConcurrentPasswordChange(t *testing.T) {
	initial := invitationRecord{
		Purpose: InvitationPurposeTOTPReset, PasswordHash: "hash-before", PasswordVersion: 1,
	}
	if !activationCredentialUnchanged(initial, initial) {
		t.Fatal("activationCredentialUnchanged() rejected identical credentials")
	}
	changedHash := initial
	changedHash.PasswordHash = "hash-after"
	if activationCredentialUnchanged(initial, changedHash) {
		t.Fatal("activationCredentialUnchanged() accepted a changed password hash")
	}
	changedVersion := initial
	changedVersion.PasswordVersion = 2
	if activationCredentialUnchanged(initial, changedVersion) {
		t.Fatal("activationCredentialUnchanged() accepted a changed password version")
	}
}

func TestDisplayNameRejectsSensitiveIdentityText(t *testing.T) {
	for _, value := range []string{
		"admin@example.com",
		"管理员 admin@example.com",
		"客服 13800138000",
	} {
		if validDisplayName(value) {
			t.Errorf("validDisplayName(%q) accepted sensitive identity text", value)
		}
	}
	for _, value := range []string{"张三", "Alice Chen", "运营值班一组"} {
		if !validDisplayName(value) {
			t.Errorf("validDisplayName(%q) rejected an ordinary display name", value)
		}
	}
}

func TestBootstrapLocksNonInitializationManagementUntilSecondSuperAdmin(t *testing.T) {
	fixture := newAdminFixture(t)
	ctx := context.Background()
	first := fixture.bootstrapAndActivate(t, "first@example.com", "第一管理员", "correct horse battery staple")
	firstActor := actor(first.AdminID, rbac.SuperAdmin, "req-first")
	if _, err := fixture.service.Invite(ctx, firstActor, inviteRequest("operator@example.com", "运营人员", rbac.Operator)); !errors.Is(err, ErrBootstrapIncomplete) {
		t.Fatalf("Invite(operator before second super) error = %v", err)
	}
	secondInvitation, err := fixture.service.Invite(ctx, firstActor, inviteRequest("second@example.com", "第二管理员", rbac.SuperAdmin))
	if err != nil {
		t.Fatalf("Invite(second super) error = %v", err)
	}
	fixture.activate(t, secondInvitation, "correct horse battery staple")
	if _, err := fixture.service.Invite(ctx, Actor{AdminID: first.AdminID, Role: rbac.Operator, Meta: requestMeta("req-forged-role")}, inviteRequest("support@example.com", "客服人员", rbac.Support)); !errors.Is(err, ErrPermissionDenied) {
		t.Fatalf("Invite() with stale/forged actor role error = %v", err)
	}
}

func TestSuspendMasksListAndRevokesAdministratorSessions(t *testing.T) {
	fixture := newAdminFixture(t)
	ctx := context.Background()
	first := fixture.bootstrapAndActivate(t, "first@example.com", "第一管理员", "correct horse battery staple")
	fixture.bootstrapAndActivate(t, "second@example.com", "第二管理员", "correct horse battery staple")
	firstActor := actor(first.AdminID, rbac.SuperAdmin, "req-first")
	operatorInvitation, err := fixture.service.Invite(ctx, firstActor, inviteRequest("operator@example.com", "运营人员", rbac.Operator))
	if err != nil {
		t.Fatalf("Invite(operator) error = %v", err)
	}
	operator := fixture.activate(t, operatorInvitation, "correct horse battery staple")
	fixture.insertSession(t, operator.AdminID, rbac.Operator)

	if err := fixture.service.Suspend(ctx, firstActor, operator.AdminID, actionReason("req-suspend-operator")); err != nil {
		t.Fatalf("Suspend() error = %v", err)
	}
	var status string
	var securityVersion int64
	var revokedAt *time.Time
	if err := fixture.postgres.QueryRow(ctx, `SELECT status, security_version FROM admin_users WHERE id = $1`, operator.AdminID).Scan(&status, &securityVersion); err != nil {
		t.Fatalf("read suspended user: %v", err)
	}
	if err := fixture.postgres.QueryRow(ctx, `SELECT revoked_at FROM admin_sessions WHERE admin_user_id = $1`, operator.AdminID).Scan(&revokedAt); err != nil {
		t.Fatalf("read revoked session: %v", err)
	}
	if status != "suspended" || securityVersion != 2 || revokedAt == nil {
		t.Fatalf("suspension state = status:%q version:%d revoked:%v", status, securityVersion, revokedAt)
	}

	administrators, err := fixture.service.List(ctx, firstActor)
	if err != nil {
		t.Fatalf("List() error = %v", err)
	}
	encoded, _ := json.Marshal(administrators)
	if bytes.Contains(encoded, []byte("operator@example.com")) || !bytes.Contains(encoded, []byte("o***@example.com")) {
		t.Fatalf("List() identity output = %s", encoded)
	}
}

func TestTOTPResetRevokesSessionsAndUsesPasswordProtectedRebinding(t *testing.T) {
	fixture := newAdminFixture(t)
	ctx := context.Background()
	first := fixture.bootstrapAndActivate(t, "first@example.com", "第一管理员", "correct horse battery staple")
	second := fixture.bootstrapAndActivate(t, "second@example.com", "第二管理员", "second correct horse battery")
	fixture.insertSession(t, second.AdminID, rbac.SuperAdmin)
	var passwordHashBefore string
	if err := fixture.postgres.QueryRow(ctx, `SELECT password_hash FROM admin_password_credentials WHERE admin_user_id = $1`, second.AdminID).Scan(&passwordHashBefore); err != nil {
		t.Fatalf("read password before reset: %v", err)
	}

	resetInvitation, err := fixture.service.ResetTOTP(ctx, actor(first.AdminID, rbac.SuperAdmin, "req-reset-actor"), second.AdminID, actionReason("req-reset-totp"))
	if err != nil {
		t.Fatalf("ResetTOTP() error = %v", err)
	}
	var totpCount, recoveryCount int
	var revokedAt *time.Time
	if err := fixture.postgres.QueryRow(ctx, `SELECT count(*) FROM admin_totp_credentials WHERE admin_user_id = $1`, second.AdminID).Scan(&totpCount); err != nil {
		t.Fatalf("count TOTP after reset: %v", err)
	}
	if err := fixture.postgres.QueryRow(ctx, `SELECT count(*) FROM admin_recovery_codes WHERE admin_user_id = $1`, second.AdminID).Scan(&recoveryCount); err != nil {
		t.Fatalf("count recovery after reset: %v", err)
	}
	if err := fixture.postgres.QueryRow(ctx, `SELECT revoked_at FROM admin_sessions WHERE admin_user_id = $1`, second.AdminID).Scan(&revokedAt); err != nil {
		t.Fatalf("read session after reset: %v", err)
	}
	if totpCount != 0 || recoveryCount != 0 || revokedAt == nil {
		t.Fatalf("reset state = totp:%d recovery:%d revoked:%v", totpCount, recoveryCount, revokedAt)
	}

	preparation, err := fixture.service.PrepareActivation(ctx, activationToken(t, resetInvitation.ActivationURL))
	if err != nil || preparation.Purpose != InvitationPurposeTOTPReset {
		t.Fatalf("PrepareActivation(reset) = %+v, %v", preparation, err)
	}
	resetResult := fixture.activate(t, resetInvitation, "second correct horse battery")
	if len(resetResult.RecoveryCodes) != 8 {
		t.Fatalf("reset activation recovery codes = %d", len(resetResult.RecoveryCodes))
	}
	var passwordHashAfter string
	if err := fixture.postgres.QueryRow(ctx, `SELECT password_hash FROM admin_password_credentials WHERE admin_user_id = $1`, second.AdminID).Scan(&passwordHashAfter); err != nil {
		t.Fatalf("read password after reset: %v", err)
	}
	if passwordHashAfter != passwordHashBefore {
		t.Fatal("TOTP reset changed the password hash")
	}
	var resetSecretCleared bool
	if err := fixture.postgres.QueryRow(ctx, `
		SELECT num_nonnulls(totp_encryption_key_id, totp_nonce, totp_ciphertext) = 0
		FROM admin_invitations
		WHERE id = $1
	`, resetInvitation.InvitationID).Scan(&resetSecretCleared); err != nil {
		t.Fatalf("read reset invitation secret state: %v", err)
	}
	if !resetSecretCleared {
		t.Fatal("consumed TOTP reset invitation retained its encrypted pending secret")
	}
}

type adminFixture struct {
	postgres  *pgxpool.Pool
	service   *Service
	audit     *audit.Service
	passwords *secure.PasswordHasher
	secrets   *secure.SecretCodec
	totp      secure.TOTP
	now       time.Time
}

func newAdminFixture(t *testing.T) *adminFixture {
	t.Helper()
	postgres := testkit.Postgres(t)
	passwords, err := secure.NewPasswordHasher(secure.PasswordHasherConfig{
		CurrentVersion: 1,
		Versions: map[int]secure.Argon2Params{
			1: {MemoryKiB: 64, Iterations: 1, Parallelism: 1, SaltLength: 16, KeyLength: 32},
		},
	})
	if err != nil {
		t.Fatalf("NewPasswordHasher() error = %v", err)
	}
	identities, err := secure.NewIdentityCodec(secure.IdentityCodecConfig{
		ActiveEncryptionKeyID: "identity-v1",
		EncryptionKeys:        map[string][]byte{"identity-v1": bytes.Repeat([]byte{1}, 32)},
		ActiveLookupKeyID:     "lookup-v1",
		LookupKeys:            map[string][]byte{"lookup-v1": bytes.Repeat([]byte{2}, 32)},
	})
	if err != nil {
		t.Fatalf("NewIdentityCodec() error = %v", err)
	}
	secrets, err := secure.NewSecretCodec(secure.SecretCodecConfig{
		ActiveKeyID: "totp-v1",
		Keys:        map[string][]byte{"totp-v1": bytes.Repeat([]byte{3}, 32)},
	})
	if err != nil {
		t.Fatalf("NewSecretCodec() error = %v", err)
	}
	auditService, err := audit.NewService(postgres)
	if err != nil {
		t.Fatalf("audit.NewService() error = %v", err)
	}
	now := time.Date(2026, 7, 21, 15, 0, 0, 0, time.UTC)
	totp := secure.DefaultTOTP()
	service, err := NewService(ServiceConfig{
		PostgreSQL:  postgres,
		Passwords:   passwords,
		Identities:  identities,
		TOTPSecrets: secrets,
		TOTP:        totp,
		Audit:       auditService,
		PublicURL:   "https://admin.example.test",
		Clock:       func() time.Time { return now },
	})
	if err != nil {
		t.Fatalf("NewService() error = %v", err)
	}
	return &adminFixture{
		postgres: postgres, service: service, audit: auditService,
		passwords: passwords, secrets: secrets, totp: totp, now: now,
	}
}

func (fixture *adminFixture) bootstrapAndActivate(t *testing.T, email, displayName, password string) ActivationResult {
	t.Helper()
	invitation, err := fixture.service.BootstrapInvite(context.Background(), inviteRequest(email, displayName, rbac.SuperAdmin))
	if err != nil {
		t.Fatalf("BootstrapInvite(%s) error = %v", displayName, err)
	}
	return fixture.activate(t, invitation, password)
}

func (fixture *adminFixture) activate(t *testing.T, invitation InvitationResult, password string) ActivationResult {
	t.Helper()
	rawToken := activationToken(t, invitation.ActivationURL)
	preparation, err := fixture.service.PrepareActivation(context.Background(), rawToken)
	if err != nil {
		t.Fatalf("PrepareActivation() error = %v", err)
	}
	secret := provisioningSecret(t, preparation.ProvisioningURI)
	result, err := fixture.service.Activate(context.Background(), ActivateRequest{
		Token:    rawToken,
		Password: password,
		TOTPCode: fixture.totp.Code(secret, fixture.now),
		Meta:     requestMeta("req-activate-" + invitation.AdminID.String()),
	})
	if err != nil {
		t.Fatalf("Activate() error = %v", err)
	}
	return result
}

func (fixture *adminFixture) insertSession(t *testing.T, adminID uuid.UUID, role rbac.Role) {
	t.Helper()
	createdAt := fixture.now.Add(-time.Minute)
	if _, err := fixture.postgres.Exec(context.Background(), `
		INSERT INTO admin_sessions (
			id, admin_user_id, token_hmac, csrf_hmac, security_version, role,
			mfa_method, mfa_authenticated_at, created_at, last_seen_at, idle_expires_at, absolute_expires_at
		) VALUES ($1, $2, $3, $4, 1, $5, 'totp', $6, $6, $6, $7, $8)
	`, uuid.New(), adminID, bytes.Repeat([]byte{4}, 32), bytes.Repeat([]byte{5}, 32), role,
		createdAt, fixture.now.Add(30*time.Minute), fixture.now.Add(8*time.Hour)); err != nil {
		t.Fatalf("insert administrator session: %v", err)
	}
}

func inviteRequest(email, displayName string, role rbac.Role) InviteRequest {
	return InviteRequest{
		Email: email, DisplayName: displayName, Role: role,
		Reason: actionReason("req-invite-" + uuid.NewString()),
	}
}

func requestMeta(requestID string) RequestMeta {
	return RequestMeta{RequestID: requestID, SourceIPHMAC: bytes.Repeat([]byte{6}, 32), UserAgent: "AdminBrowser/1.0"}
}

func actionReason(requestID string) ActionReason {
	return ActionReason{Code: "staff_change", TicketReference: "SUP-42", Note: "approved staffing change", Meta: requestMeta(requestID)}
}

func actor(adminID uuid.UUID, role rbac.Role, requestID string) Actor {
	return Actor{AdminID: adminID, Role: role, Meta: requestMeta(requestID)}
}

func activationToken(t *testing.T, activationURL string) string {
	t.Helper()
	parsed, err := url.Parse(activationURL)
	if err != nil {
		t.Fatalf("parse activation URL: %v", err)
	}
	values, err := url.ParseQuery(parsed.Fragment)
	if err != nil || values.Get("token") == "" {
		t.Fatalf("parse activation URL fragment %q: %v", parsed.Fragment, err)
	}
	return values.Get("token")
}

func provisioningSecret(t *testing.T, rawURI string) []byte {
	t.Helper()
	parsed, err := url.Parse(rawURI)
	if err != nil {
		t.Fatalf("parse provisioning URI: %v", err)
	}
	secret, err := base32.StdEncoding.WithPadding(base32.NoPadding).DecodeString(parsed.Query().Get("secret"))
	if err != nil || len(secret) != 20 {
		t.Fatalf("decode provisioning secret length/error = %d/%v", len(secret), err)
	}
	return secret
}
