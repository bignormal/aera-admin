package admin

import (
	"context"
	"encoding/base64"
	"errors"
	"net/url"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/bignormal/aera-admin/internal/audit"
	"github.com/bignormal/aera-admin/internal/rbac"
	"github.com/bignormal/aera-admin/internal/secure"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

const (
	invitationLifetime = 24 * time.Hour
	recoveryCodeCount  = 8
)

type ServiceConfig struct {
	PostgreSQL  *pgxpool.Pool
	Passwords   *secure.PasswordHasher
	Identities  *secure.IdentityCodec
	TOTPSecrets *secure.SecretCodec
	TOTP        secure.TOTP
	Audit       *audit.Service
	PublicURL   string
	Clock       func() time.Time
}

type Service struct {
	repository  *repository
	passwords   *secure.PasswordHasher
	identities  *secure.IdentityCodec
	totpSecrets *secure.SecretCodec
	totp        secure.TOTP
	audit       *audit.Service
	publicURL   *url.URL
	clock       func() time.Time
}

func NewService(config ServiceConfig) (*Service, error) {
	if config.PostgreSQL == nil || config.Passwords == nil || config.Identities == nil ||
		config.TOTPSecrets == nil || config.Audit == nil {
		return nil, errors.New("administrator service dependencies are required")
	}
	publicURL, err := url.Parse(config.PublicURL)
	if err != nil || publicURL.Scheme == "" || publicURL.Host == "" || publicURL.User != nil ||
		publicURL.RawQuery != "" || publicURL.Fragment != "" || (publicURL.Path != "" && publicURL.Path != "/") {
		return nil, errors.New("administrator public URL is invalid")
	}
	publicURL.Path = ""
	clock := config.Clock
	if clock == nil {
		clock = time.Now
	}
	return &Service{
		repository:  &repository{postgres: config.PostgreSQL},
		passwords:   config.Passwords,
		identities:  config.Identities,
		totpSecrets: config.TOTPSecrets,
		totp:        config.TOTP,
		audit:       config.Audit,
		publicURL:   publicURL,
		clock:       clock,
	}, nil
}

func (service *Service) BootstrapInvite(ctx context.Context, request InviteRequest) (InvitationResult, error) {
	if request.Role != rbac.SuperAdmin {
		return InvitationResult{}, ErrInvalidRequest
	}
	resources, err := service.prepareInvitation(request, InvitationPurposeActivation)
	if err != nil {
		return InvitationResult{}, err
	}
	tx, err := service.repository.begin(ctx)
	if err != nil {
		return InvitationResult{}, err
	}
	defer func() { _ = tx.Rollback(context.Background()) }()
	if err := lockBootstrap(ctx, tx); err != nil {
		return InvitationResult{}, err
	}
	active, err := countActiveSuperAdmins(ctx, tx)
	if err != nil {
		return InvitationResult{}, err
	}
	slots, err := countBootstrapSlots(ctx, tx, service.now())
	if err != nil {
		return InvitationResult{}, err
	}
	if active >= 2 || slots >= 2 {
		return InvitationResult{}, ErrBootstrapComplete
	}
	return service.createAdministratorInvitation(ctx, tx, nil, "", request, resources)
}

func (service *Service) Invite(ctx context.Context, actor Actor, request InviteRequest) (InvitationResult, error) {
	resources, err := service.prepareInvitation(request, InvitationPurposeActivation)
	if err != nil {
		return InvitationResult{}, err
	}
	tx, err := service.repository.begin(ctx)
	if err != nil {
		return InvitationResult{}, err
	}
	defer func() { _ = tx.Rollback(context.Background()) }()
	if err := lockBootstrap(ctx, tx); err != nil {
		return InvitationResult{}, err
	}
	actorRole, err := authorizeActor(ctx, tx, actor, rbac.ManageAdministrators)
	if err != nil {
		return InvitationResult{}, err
	}
	active, err := countActiveSuperAdmins(ctx, tx)
	if err != nil {
		return InvitationResult{}, err
	}
	if active < 2 {
		slots, countErr := countBootstrapSlots(ctx, tx, service.now())
		if countErr != nil {
			return InvitationResult{}, countErr
		}
		if request.Role != rbac.SuperAdmin || slots >= 2 {
			return InvitationResult{}, ErrBootstrapIncomplete
		}
	}
	createdBy := actor.AdminID
	return service.createAdministratorInvitation(ctx, tx, &createdBy, actorRole, request, resources)
}

type invitationResources struct {
	administratorID  uuid.UUID
	invitationID     uuid.UUID
	rawToken         string
	tokenDigest      []byte
	identity         secure.SealedIdentity
	lookupCandidates []secure.LookupIndex
	totpSecret       secure.SealedSecret
	createdAt        time.Time
	expiresAt        time.Time
	purpose          InvitationPurpose
}

func (service *Service) prepareInvitation(request InviteRequest, purpose InvitationPurpose) (invitationResources, error) {
	if service == nil || service.repository == nil || !request.Role.Valid() || !validDisplayName(request.DisplayName) || !validActionReason(request.Reason) {
		return invitationResources{}, ErrInvalidRequest
	}
	identity, err := service.identities.SealEmail(request.Email)
	if err != nil {
		return invitationResources{}, ErrInvalidRequest
	}
	lookupCandidates := service.identities.LookupCandidates(request.Email)
	if len(lookupCandidates) == 0 {
		return invitationResources{}, ErrInvalidRequest
	}
	rawToken, tokenDigest, err := secure.NewOpaqueToken(32)
	if err != nil {
		return invitationResources{}, err
	}
	totpPlaintext, err := service.totp.Generate()
	if err != nil {
		return invitationResources{}, errors.New("administrator TOTP secret could not be generated")
	}
	defer clear(totpPlaintext)
	sealedTOTP, err := service.totpSecrets.Seal(totpPlaintext)
	if err != nil {
		return invitationResources{}, err
	}
	now := service.now()
	return invitationResources{
		administratorID:  uuid.New(),
		invitationID:     uuid.New(),
		rawToken:         rawToken,
		tokenDigest:      append([]byte(nil), tokenDigest[:]...),
		identity:         identity,
		lookupCandidates: lookupCandidates,
		totpSecret:       sealedTOTP,
		createdAt:        now,
		expiresAt:        now.Add(invitationLifetime),
		purpose:          purpose,
	}, nil
}

func (service *Service) createAdministratorInvitation(
	ctx context.Context,
	tx pgx.Tx,
	createdBy *uuid.UUID,
	actorRole rbac.Role,
	request InviteRequest,
	resources invitationResources,
) (InvitationResult, error) {
	existing, found, err := findAdministratorByLookup(ctx, tx, resources.lookupCandidates)
	if err != nil {
		return InvitationResult{}, err
	}
	administratorID := resources.administratorID
	eventType := "admin_invited"
	var beforeState map[string]string
	administrator := administratorRecord{
		ID: administratorID, DisplayName: strings.TrimSpace(request.DisplayName), Role: request.Role,
		Status: StatusInvited, SecurityVersion: 1, Identity: resources.identity,
		CreatedAt: resources.createdAt, UpdatedAt: resources.createdAt,
	}
	if found {
		if existing.Status != StatusInvited {
			return InvitationResult{}, ErrIdentityExists
		}
		live, err := hasLiveActivationInvitation(ctx, tx, existing.ID, resources.createdAt)
		if err != nil {
			return InvitationResult{}, err
		}
		if live {
			return InvitationResult{}, ErrIdentityExists
		}
		administratorID = existing.ID
		administrator.ID = existing.ID
		administrator.CreatedAt = existing.CreatedAt
		invitationBeforeRole := existing.Role
		beforeState = map[string]string{"role": string(invitationBeforeRole), "status": string(existing.Status)}
		eventType = "admin_reinvited"
	}
	invitation := invitationRecord{
		ID: resources.invitationID, AdminID: administratorID, Purpose: resources.purpose,
		TokenDigest: resources.tokenDigest, TOTPSecret: resources.totpSecret, CreatedByAdminID: cloneUUID(createdBy),
		CreatedAt: resources.createdAt, ExpiresAt: resources.expiresAt,
	}
	if found {
		if err := reissueAdministratorInvitation(ctx, tx, administrator, invitation, resources.createdAt); err != nil {
			return InvitationResult{}, err
		}
	} else {
		if err := insertAdministratorInvitation(ctx, tx, administrator, invitation); err != nil {
			return InvitationResult{}, err
		}
	}
	auditRecord := audit.Record{
		EventType: eventType, ObjectType: "admin_user", ObjectID: &administratorID,
		Outcome: audit.OutcomeSuccess, ReasonCode: request.Reason.Code,
		TicketReference: request.Reason.TicketReference, Note: request.Reason.Note,
		RequestID: request.Reason.Meta.RequestID, SourceIPHMAC: request.Reason.Meta.SourceIPHMAC,
		UserAgent: request.Reason.Meta.UserAgent, BeforeState: beforeState,
		AfterState: map[string]string{"role": string(request.Role), "status": string(StatusInvited)},
	}
	if createdBy != nil {
		auditRecord.ActorAdminID = cloneUUID(createdBy)
		auditRecord.ActorRole = actorRole
	}
	if _, err := service.audit.AppendTx(ctx, tx, auditRecord); err != nil {
		return InvitationResult{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return InvitationResult{}, errors.New("administrator invitation could not be committed")
	}
	return InvitationResult{
		InvitationID:  resources.invitationID,
		AdminID:       administratorID,
		ActivationURL: service.activationURL(resources.rawToken),
		ExpiresAt:     resources.expiresAt,
	}, nil
}

func (service *Service) PrepareActivation(ctx context.Context, rawToken string) (ActivationPreparation, error) {
	tokenDigest, err := invitationTokenDigest(rawToken)
	if err != nil {
		return ActivationPreparation{}, ErrInvalidInvitation
	}
	invitation, err := findInvitation(ctx, service.repository.postgres, tokenDigest, false)
	if err != nil || !service.invitationIsUsable(invitation) {
		return ActivationPreparation{}, ErrInvalidInvitation
	}
	email, err := service.identities.OpenEmail(invitation.Identity)
	if err != nil {
		return ActivationPreparation{}, ErrInvalidInvitation
	}
	secret, err := service.totpSecrets.Open(invitation.TOTPSecret)
	if err != nil {
		return ActivationPreparation{}, ErrInvalidInvitation
	}
	defer clear(secret)
	maskedIdentity := maskEmail(email)
	provisioningURI, err := service.totp.ProvisioningURI(secret, maskedIdentity)
	if err != nil {
		return ActivationPreparation{}, ErrInvalidInvitation
	}
	return ActivationPreparation{
		AdminID: invitation.AdminID, DisplayName: invitation.DisplayName, MaskedIdentity: maskedIdentity,
		Purpose: invitation.Purpose, ProvisioningURI: provisioningURI, ExpiresAt: invitation.ExpiresAt,
	}, nil
}

func (service *Service) Activate(ctx context.Context, request ActivateRequest) (ActivationResult, error) {
	tokenDigest, err := invitationTokenDigest(request.Token)
	if err != nil {
		return ActivationResult{}, ErrInvalidInvitation
	}
	initial, err := findInvitation(ctx, service.repository.postgres, tokenDigest, false)
	if err != nil || !service.invitationIsUsable(initial) {
		return ActivationResult{}, ErrInvalidInvitation
	}
	secret, err := service.totpSecrets.Open(initial.TOTPSecret)
	if err != nil {
		return ActivationResult{}, ErrInvalidInvitation
	}
	defer clear(secret)
	acceptedStep, ok := service.totp.Validate(secret, request.TOTPCode, service.now(), -1)
	if !ok {
		return ActivationResult{}, ErrInvalidActivation
	}

	passwordHash, passwordVersion, err := service.prepareActivationPassword(request.Password, initial)
	if err != nil {
		return ActivationResult{}, err
	}
	rawRecoveryCodes, recoveryCredentials, err := generateRecoveryCredentials()
	if err != nil {
		return ActivationResult{}, err
	}

	tx, err := service.repository.begin(ctx)
	if err != nil {
		return ActivationResult{}, err
	}
	defer func() { _ = tx.Rollback(context.Background()) }()
	locked, err := findInvitation(ctx, tx, tokenDigest, true)
	if err != nil || !service.invitationIsUsable(locked) || locked.ID != initial.ID || locked.Purpose != initial.Purpose {
		return ActivationResult{}, ErrInvalidInvitation
	}
	if !activationCredentialUnchanged(initial, locked) {
		return ActivationResult{}, ErrStateConflict
	}
	lockedSecret, err := service.totpSecrets.Open(locked.TOTPSecret)
	if err != nil {
		return ActivationResult{}, ErrInvalidInvitation
	}
	defer clear(lockedSecret)
	lockedStep, ok := service.totp.Validate(lockedSecret, request.TOTPCode, service.now(), -1)
	if !ok || lockedStep != acceptedStep {
		return ActivationResult{}, ErrInvalidActivation
	}
	now := service.now()
	if err := service.persistActivation(ctx, tx, locked, passwordHash, passwordVersion, lockedStep, recoveryCredentials, now); err != nil {
		return ActivationResult{}, err
	}
	eventType := "admin_activated"
	reasonCode := "staff_change"
	beforeState := map[string]string{"status": string(StatusInvited), "mfa_status": "pending"}
	afterState := map[string]string{"status": string(StatusActive), "mfa_status": "active"}
	if locked.Purpose == InvitationPurposeTOTPReset {
		eventType = "admin_totp_rebound"
		reasonCode = "account_recovery"
		beforeState = map[string]string{"status": string(StatusActive), "mfa_status": "reset_pending"}
	}
	if _, err := service.audit.AppendTx(ctx, tx, audit.Record{
		ActorAdminID: &locked.AdminID, ActorRole: locked.Role,
		EventType: eventType, ObjectType: "admin_user", ObjectID: &locked.AdminID,
		Outcome: audit.OutcomeSuccess, ReasonCode: reasonCode,
		RequestID: request.Meta.RequestID, SourceIPHMAC: request.Meta.SourceIPHMAC, UserAgent: request.Meta.UserAgent,
		BeforeState: beforeState, AfterState: afterState,
	}); err != nil {
		return ActivationResult{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return ActivationResult{}, errors.New("administrator activation could not be committed")
	}
	return ActivationResult{AdminID: locked.AdminID, RecoveryCodes: rawRecoveryCodes}, nil
}

func activationCredentialUnchanged(initial invitationRecord, locked invitationRecord) bool {
	return initial.PasswordHash == locked.PasswordHash && initial.PasswordVersion == locked.PasswordVersion
}

func (service *Service) prepareActivationPassword(password string, invitation invitationRecord) (string, int, error) {
	if invitation.Purpose == InvitationPurposeActivation {
		encoded, version, err := service.passwords.Hash(password)
		if err != nil {
			return "", 0, ErrInvalidActivation
		}
		return encoded, version, nil
	}
	if invitation.Purpose != InvitationPurposeTOTPReset || invitation.PasswordHash == "" || invitation.PasswordVersion <= 0 {
		return "", 0, ErrInvalidInvitation
	}
	ok, rehash, err := service.passwords.Verify(password, invitation.PasswordHash)
	if err != nil || !ok {
		return "", 0, ErrInvalidActivation
	}
	if !rehash {
		return invitation.PasswordHash, invitation.PasswordVersion, nil
	}
	encoded, version, err := service.passwords.Hash(password)
	if err != nil {
		return "", 0, ErrInvalidActivation
	}
	return encoded, version, nil
}

func (service *Service) persistActivation(
	ctx context.Context,
	tx pgx.Tx,
	invitation invitationRecord,
	passwordHash string,
	passwordVersion int,
	acceptedStep int64,
	recoveryCredentials []recoveryCredential,
	now time.Time,
) error {
	if invitation.Purpose == InvitationPurposeActivation {
		if _, err := tx.Exec(ctx, `
			INSERT INTO admin_password_credentials (admin_user_id, password_hash, params_version, changed_at)
			VALUES ($1, $2, $3, $4)
		`, invitation.AdminID, passwordHash, passwordVersion, now); err != nil {
			return errors.New("administrator password credential could not be stored")
		}
	} else if passwordHash != invitation.PasswordHash || passwordVersion != invitation.PasswordVersion {
		if _, err := tx.Exec(ctx, `
			UPDATE admin_password_credentials
			SET password_hash = $2, params_version = $3, changed_at = $4
			WHERE admin_user_id = $1
		`, invitation.AdminID, passwordHash, passwordVersion, now); err != nil {
			return errors.New("administrator password credential could not be upgraded")
		}
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO admin_totp_credentials (
			admin_user_id, encryption_key_id, nonce, ciphertext, last_accepted_step, bound_at, updated_at
		) VALUES ($1, $2, $3, $4, $5, $6, $6)
	`, invitation.AdminID, invitation.TOTPSecret.KeyID, invitation.TOTPSecret.Nonce, invitation.TOTPSecret.Ciphertext, acceptedStep, now); err != nil {
		return errors.New("administrator TOTP credential could not be stored")
	}
	for _, recovery := range recoveryCredentials {
		if _, err := tx.Exec(ctx, `
			INSERT INTO admin_recovery_codes (admin_user_id, code_hmac, created_at)
			VALUES ($1, $2, $3)
		`, invitation.AdminID, recovery.Digest, now); err != nil {
			return errors.New("administrator recovery credentials could not be stored")
		}
	}
	if invitation.Purpose == InvitationPurposeActivation {
		command, err := tx.Exec(ctx, `
			UPDATE admin_users
			SET status = 'active', updated_at = $2
			WHERE id = $1 AND status = 'invited'
		`, invitation.AdminID, now)
		if err != nil || command.RowsAffected() != 1 {
			return ErrStateConflict
		}
	} else {
		command, err := tx.Exec(ctx, `
			UPDATE admin_users
			SET security_version = security_version + 1, updated_at = $2
			WHERE id = $1 AND status = 'active'
		`, invitation.AdminID, now)
		if err != nil || command.RowsAffected() != 1 {
			return ErrStateConflict
		}
	}
	command, err := tx.Exec(ctx, `
		UPDATE admin_invitations
		SET consumed_at = $2,
			totp_encryption_key_id = NULL,
			totp_nonce = NULL,
			totp_ciphertext = NULL
		WHERE id = $1 AND consumed_at IS NULL
	`, invitation.ID, now)
	if err != nil || command.RowsAffected() != 1 {
		return ErrInvalidInvitation
	}
	return nil
}

func (service *Service) ChangeRole(ctx context.Context, actor Actor, targetID uuid.UUID, role rbac.Role, reason ActionReason) error {
	if actor.AdminID == targetID && targetID != uuid.Nil {
		return ErrSelfManagement
	}
	if targetID == uuid.Nil || !role.Valid() || !validActionReason(reason) {
		return ErrInvalidRequest
	}
	return service.mutateAdministrator(ctx, actor, targetID, reason, func(tx pgx.Tx, target administratorRecord, now time.Time) (audit.Record, error) {
		if target.Role == role {
			return audit.Record{}, nil
		}
		if target.Role == rbac.SuperAdmin && target.Status == StatusActive && role != rbac.SuperAdmin {
			count, err := countActiveSuperAdmins(ctx, tx)
			if err != nil {
				return audit.Record{}, err
			}
			if count <= 2 {
				return audit.Record{}, ErrMinimumSuperAdmins
			}
		}
		if _, err := tx.Exec(ctx, `
			UPDATE admin_users
			SET role = $2, security_version = security_version + 1, updated_at = $3
			WHERE id = $1
		`, target.ID, role, now); err != nil {
			return audit.Record{}, errors.New("administrator role could not be changed")
		}
		if err := revokeAdministratorSessions(ctx, tx, target.ID, now); err != nil {
			return audit.Record{}, err
		}
		return audit.Record{
			EventType: "admin_role_changed", ObjectType: "admin_user", ObjectID: &target.ID,
			BeforeState: map[string]string{"role": string(target.Role)}, AfterState: map[string]string{"role": string(role)},
		}, nil
	})
}

func (service *Service) Suspend(ctx context.Context, actor Actor, targetID uuid.UUID, reason ActionReason) error {
	if actor.AdminID == targetID && targetID != uuid.Nil {
		return ErrSelfManagement
	}
	if targetID == uuid.Nil || !validActionReason(reason) {
		return ErrInvalidRequest
	}
	return service.mutateAdministrator(ctx, actor, targetID, reason, func(tx pgx.Tx, target administratorRecord, now time.Time) (audit.Record, error) {
		if target.Status == StatusSuspended {
			return audit.Record{}, nil
		}
		if target.Role == rbac.SuperAdmin && target.Status == StatusActive {
			count, err := countActiveSuperAdmins(ctx, tx)
			if err != nil {
				return audit.Record{}, err
			}
			if count <= 2 {
				return audit.Record{}, ErrMinimumSuperAdmins
			}
		}
		if _, err := tx.Exec(ctx, `
			UPDATE admin_users
			SET status = 'suspended', security_version = security_version + 1, updated_at = $2
			WHERE id = $1
		`, target.ID, now); err != nil {
			return audit.Record{}, errors.New("administrator could not be suspended")
		}
		if err := revokeAdministratorSessions(ctx, tx, target.ID, now); err != nil {
			return audit.Record{}, err
		}
		return audit.Record{
			EventType: "admin_suspended", ObjectType: "admin_user", ObjectID: &target.ID,
			BeforeState: map[string]string{"status": string(target.Status)}, AfterState: map[string]string{"status": string(StatusSuspended)},
		}, nil
	})
}

type administratorMutation func(pgx.Tx, administratorRecord, time.Time) (audit.Record, error)

func (service *Service) mutateAdministrator(
	ctx context.Context,
	actor Actor,
	targetID uuid.UUID,
	reason ActionReason,
	mutation administratorMutation,
) error {
	tx, err := service.repository.begin(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(context.Background()) }()
	if err := lockBootstrap(ctx, tx); err != nil {
		return err
	}
	actorRole, err := authorizeActor(ctx, tx, actor, rbac.ManageAdministrators)
	if err != nil {
		return err
	}
	active, err := countActiveSuperAdmins(ctx, tx)
	if err != nil {
		return err
	}
	if active < 2 {
		return ErrBootstrapIncomplete
	}
	target, err := lockAdministrator(ctx, tx, targetID)
	if err != nil {
		return err
	}
	record, err := mutation(tx, target, service.now())
	if err != nil {
		return err
	}
	if record.EventType == "" {
		return tx.Commit(ctx)
	}
	record.ActorAdminID = &actor.AdminID
	record.ActorRole = actorRole
	record.Outcome = audit.OutcomeSuccess
	record.ReasonCode = reason.Code
	record.TicketReference = reason.TicketReference
	record.Note = reason.Note
	record.RequestID = reason.Meta.RequestID
	record.SourceIPHMAC = reason.Meta.SourceIPHMAC
	record.UserAgent = reason.Meta.UserAgent
	if _, err := service.audit.AppendTx(ctx, tx, record); err != nil {
		return err
	}
	if err := tx.Commit(ctx); err != nil {
		return errors.New("administrator change could not be committed")
	}
	return nil
}

func (service *Service) ResetTOTP(ctx context.Context, actor Actor, targetID uuid.UUID, reason ActionReason) (InvitationResult, error) {
	if actor.AdminID == targetID && targetID != uuid.Nil {
		return InvitationResult{}, ErrSelfManagement
	}
	if targetID == uuid.Nil || !validActionReason(reason) {
		return InvitationResult{}, ErrInvalidRequest
	}
	resources, err := service.prepareResetInvitation()
	if err != nil {
		return InvitationResult{}, err
	}
	tx, err := service.repository.begin(ctx)
	if err != nil {
		return InvitationResult{}, err
	}
	defer func() { _ = tx.Rollback(context.Background()) }()
	if err := lockBootstrap(ctx, tx); err != nil {
		return InvitationResult{}, err
	}
	actorRole, err := authorizeActor(ctx, tx, actor, rbac.ManageAdministrators)
	if err != nil {
		return InvitationResult{}, err
	}
	active, err := countActiveSuperAdmins(ctx, tx)
	if err != nil {
		return InvitationResult{}, err
	}
	if active < 2 {
		return InvitationResult{}, ErrBootstrapIncomplete
	}
	target, err := lockAdministrator(ctx, tx, targetID)
	if err != nil {
		return InvitationResult{}, err
	}
	if target.Status != StatusActive {
		return InvitationResult{}, ErrStateConflict
	}
	var hasPassword bool
	if err := tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM admin_password_credentials WHERE admin_user_id = $1)`, target.ID).Scan(&hasPassword); err != nil {
		return InvitationResult{}, errors.New("administrator password state could not be read")
	}
	if !hasPassword {
		return InvitationResult{}, ErrStateConflict
	}
	now := service.now()
	if _, err := tx.Exec(ctx, `
		UPDATE admin_invitations
		SET consumed_at = $2,
			totp_encryption_key_id = NULL,
			totp_nonce = NULL,
			totp_ciphertext = NULL
		WHERE admin_user_id = $1 AND purpose = 'totp_reset' AND consumed_at IS NULL
	`, target.ID, now); err != nil {
		return InvitationResult{}, errors.New("previous TOTP reset invitations could not be invalidated")
	}
	if _, err := tx.Exec(ctx, `DELETE FROM admin_totp_credentials WHERE admin_user_id = $1`, target.ID); err != nil {
		return InvitationResult{}, errors.New("administrator TOTP credential could not be reset")
	}
	if _, err := tx.Exec(ctx, `DELETE FROM admin_recovery_codes WHERE admin_user_id = $1`, target.ID); err != nil {
		return InvitationResult{}, errors.New("administrator recovery credentials could not be reset")
	}
	if _, err := tx.Exec(ctx, `
		UPDATE admin_users
		SET security_version = security_version + 1, updated_at = $2
		WHERE id = $1
	`, target.ID, now); err != nil {
		return InvitationResult{}, errors.New("administrator security version could not be advanced")
	}
	if err := revokeAdministratorSessions(ctx, tx, target.ID, now); err != nil {
		return InvitationResult{}, err
	}
	createdBy := actor.AdminID
	invitation := invitationRecord{
		ID: resources.invitationID, AdminID: target.ID, Purpose: InvitationPurposeTOTPReset,
		TokenDigest: resources.tokenDigest, TOTPSecret: resources.totpSecret, CreatedByAdminID: &createdBy,
		CreatedAt: now, ExpiresAt: now.Add(invitationLifetime),
	}
	if err := insertInvitation(ctx, tx, invitation); err != nil {
		return InvitationResult{}, err
	}
	if _, err := service.audit.AppendTx(ctx, tx, audit.Record{
		ActorAdminID: &actor.AdminID, ActorRole: actorRole,
		EventType: "admin_totp_reset", ObjectType: "admin_user", ObjectID: &target.ID,
		Outcome: audit.OutcomeSuccess, ReasonCode: reason.Code,
		TicketReference: reason.TicketReference, Note: reason.Note,
		RequestID: reason.Meta.RequestID, SourceIPHMAC: reason.Meta.SourceIPHMAC, UserAgent: reason.Meta.UserAgent,
		BeforeState: map[string]string{"mfa_status": "active"}, AfterState: map[string]string{"mfa_status": "reset_pending"},
	}); err != nil {
		return InvitationResult{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return InvitationResult{}, errors.New("administrator TOTP reset could not be committed")
	}
	return InvitationResult{
		InvitationID: invitation.ID, AdminID: target.ID,
		ActivationURL: service.activationURL(resources.rawToken), ExpiresAt: invitation.ExpiresAt,
	}, nil
}

func (service *Service) prepareResetInvitation() (invitationResources, error) {
	rawToken, tokenDigest, err := secure.NewOpaqueToken(32)
	if err != nil {
		return invitationResources{}, err
	}
	secret, err := service.totp.Generate()
	if err != nil {
		return invitationResources{}, errors.New("administrator TOTP secret could not be generated")
	}
	defer clear(secret)
	sealed, err := service.totpSecrets.Seal(secret)
	if err != nil {
		return invitationResources{}, err
	}
	now := service.now()
	return invitationResources{
		invitationID: uuid.New(), rawToken: rawToken, tokenDigest: append([]byte(nil), tokenDigest[:]...),
		totpSecret: sealed, createdAt: now, expiresAt: now.Add(invitationLifetime), purpose: InvitationPurposeTOTPReset,
	}, nil
}

func (service *Service) List(ctx context.Context, actor Actor) ([]Administrator, error) {
	tx, err := service.repository.begin(ctx)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(context.Background()) }()
	actorRole, err := authorizeActor(ctx, tx, actor, rbac.ReadAdministrators)
	if err != nil {
		return nil, err
	}
	records, err := listAdministratorRecords(ctx, tx)
	if err != nil {
		return nil, err
	}
	administrators := make([]Administrator, 0, len(records))
	for _, record := range records {
		email, err := service.identities.OpenEmail(record.Identity)
		if err != nil {
			return nil, errors.New("administrator identity could not be displayed")
		}
		administrators = append(administrators, Administrator{
			ID: record.ID, MaskedIdentity: maskEmail(email), DisplayName: record.DisplayName,
			Role: record.Role, Status: record.Status, MFAEnabled: record.MFAEnabled,
			SecurityVersion: record.SecurityVersion, LastLoginAt: record.LastLoginAt,
			CreatedAt: record.CreatedAt.UTC(), UpdatedAt: record.UpdatedAt.UTC(),
		})
	}
	if _, err := service.audit.AppendTx(ctx, tx, audit.Record{
		ActorAdminID: &actor.AdminID, ActorRole: actorRole,
		EventType: "admin_listed", ObjectType: "admin_user_collection", Outcome: audit.OutcomeSuccess,
		RequestID: actor.Meta.RequestID, SourceIPHMAC: actor.Meta.SourceIPHMAC, UserAgent: actor.Meta.UserAgent,
	}); err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, errors.New("administrator list audit could not be committed")
	}
	return administrators, nil
}

func (service *Service) invitationIsUsable(invitation invitationRecord) bool {
	if invitation.ID == uuid.Nil || invitation.AdminID == uuid.Nil || invitation.ConsumedAt != nil ||
		!invitation.ExpiresAt.After(service.now()) || invitation.TOTPSecret.KeyID == "" ||
		len(invitation.TOTPSecret.Nonce) != 12 || len(invitation.TOTPSecret.Ciphertext) <= 16 {
		return false
	}
	switch invitation.Purpose {
	case InvitationPurposeActivation:
		return invitation.Status == StatusInvited && invitation.PasswordHash == ""
	case InvitationPurposeTOTPReset:
		return invitation.Status == StatusActive && invitation.PasswordHash != "" && invitation.PasswordVersion > 0
	default:
		return false
	}
}

func (service *Service) activationURL(rawToken string) string {
	activation := *service.publicURL
	activation.Path = "/activate"
	activation.Fragment = url.Values{"token": []string{rawToken}}.Encode()
	return activation.String()
}

func (service *Service) now() time.Time {
	return service.clock().UTC().Truncate(time.Microsecond)
}

func invitationTokenDigest(rawToken string) ([]byte, error) {
	if len(rawToken) > 256 {
		return nil, ErrInvalidInvitation
	}
	decoded, err := base64.RawURLEncoding.DecodeString(rawToken)
	if err != nil || len(decoded) != 32 {
		return nil, ErrInvalidInvitation
	}
	digest := secure.DigestOpaqueToken(rawToken)
	return append([]byte(nil), digest[:]...), nil
}

func generateRecoveryCredentials() ([]string, []recoveryCredential, error) {
	rawCodes := make([]string, 0, recoveryCodeCount)
	credentials := make([]recoveryCredential, 0, recoveryCodeCount)
	seen := make(map[string]struct{}, recoveryCodeCount)
	for len(rawCodes) < recoveryCodeCount {
		raw, digest, err := secure.NewOpaqueToken(32)
		if err != nil {
			return nil, nil, err
		}
		if _, duplicate := seen[raw]; duplicate {
			continue
		}
		seen[raw] = struct{}{}
		rawCodes = append(rawCodes, raw)
		credentials = append(credentials, recoveryCredential{Digest: append([]byte(nil), digest[:]...)})
	}
	return rawCodes, credentials, nil
}

func revokeAdministratorSessions(ctx context.Context, tx pgx.Tx, adminID uuid.UUID, now time.Time) error {
	if _, err := tx.Exec(ctx, `
		UPDATE admin_sessions
		SET revoked_at = $2
		WHERE admin_user_id = $1 AND revoked_at IS NULL
	`, adminID, now); err != nil {
		return errors.New("administrator sessions could not be revoked")
	}
	return nil
}

func validDisplayName(value string) bool {
	value = strings.TrimSpace(value)
	if value == "" || !utf8.ValidString(value) || utf8.RuneCountInString(value) > 100 || audit.ContainsSensitiveText(value) {
		return false
	}
	for _, character := range value {
		if unicode.IsControl(character) {
			return false
		}
	}
	return true
}

func validActionReason(reason ActionReason) bool {
	return reason.Code != "" && reason.Meta.RequestID != ""
}

func maskEmail(email string) string {
	local, domain, ok := strings.Cut(email, "@")
	if !ok || local == "" || domain == "" {
		return "***"
	}
	first, _ := utf8.DecodeRuneInString(local)
	if first == utf8.RuneError && len(local) == 1 {
		return "***@" + domain
	}
	return string(first) + "***@" + domain
}

func cloneUUID(value *uuid.UUID) *uuid.UUID {
	if value == nil {
		return nil
	}
	cloned := *value
	return &cloned
}
