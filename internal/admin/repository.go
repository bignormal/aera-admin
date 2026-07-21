package admin

import (
	"context"
	"errors"
	"time"

	"github.com/bignormal/aera-admin/internal/rbac"
	"github.com/bignormal/aera-admin/internal/secure"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
)

const bootstrapAdvisoryLockID int64 = 0x41455241424f4f

type repository struct {
	postgres *pgxpool.Pool
}

type administratorRecord struct {
	ID              uuid.UUID
	DisplayName     string
	Role            rbac.Role
	Status          Status
	SecurityVersion int64
	Identity        secure.SealedIdentity
	MFAEnabled      bool
	LastLoginAt     *time.Time
	CreatedAt       time.Time
	UpdatedAt       time.Time
}

type invitationRecord struct {
	ID               uuid.UUID
	AdminID          uuid.UUID
	Purpose          InvitationPurpose
	TokenDigest      []byte
	TOTPSecret       secure.SealedSecret
	CreatedByAdminID *uuid.UUID
	CreatedAt        time.Time
	ExpiresAt        time.Time
	ConsumedAt       *time.Time
	DisplayName      string
	Role             rbac.Role
	Status           Status
	SecurityVersion  int64
	Identity         secure.SealedIdentity
	PasswordHash     string
	PasswordVersion  int
}

type recoveryCredential struct {
	Digest []byte
}

type queryRower interface {
	QueryRow(context.Context, string, ...any) pgx.Row
}

func (repository *repository) begin(ctx context.Context) (pgx.Tx, error) {
	if repository == nil || repository.postgres == nil {
		return nil, errors.New("administrator repository is unavailable")
	}
	tx, err := repository.postgres.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return nil, errors.New("administrator transaction could not start")
	}
	return tx, nil
}

func lockBootstrap(ctx context.Context, tx pgx.Tx) error {
	if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock($1)`, bootstrapAdvisoryLockID); err != nil {
		return errors.New("administrator bootstrap lock could not be acquired")
	}
	return nil
}

func countActiveSuperAdmins(ctx context.Context, tx pgx.Tx) (int, error) {
	var count int
	if err := tx.QueryRow(ctx, `
		SELECT count(*)
		FROM admin_users
		WHERE role = 'super_admin' AND status = 'active'
	`).Scan(&count); err != nil {
		return 0, errors.New("active super administrators could not be counted")
	}
	return count, nil
}

func countBootstrapSlots(ctx context.Context, tx pgx.Tx, now time.Time) (int, error) {
	var count int
	if err := tx.QueryRow(ctx, `
		SELECT count(*)
		FROM admin_users u
		WHERE u.role = 'super_admin'
		  AND (
			u.status = 'active'
			OR (
				u.status = 'invited'
				AND EXISTS (
					SELECT 1
					FROM admin_invitations i
					WHERE i.admin_user_id = u.id
					  AND i.purpose = 'activation'
					  AND i.consumed_at IS NULL
					  AND i.expires_at > $1
				)
			)
		  )
	`, now).Scan(&count); err != nil {
		return 0, errors.New("administrator bootstrap slots could not be counted")
	}
	return count, nil
}

func findAdministratorByLookup(
	ctx context.Context,
	tx pgx.Tx,
	candidates []secure.LookupIndex,
) (administratorRecord, bool, error) {
	var found administratorRecord
	for _, candidate := range candidates {
		var administrator administratorRecord
		err := tx.QueryRow(ctx, `
			SELECT
				u.id,
				u.display_name,
				u.role,
				u.status,
				u.security_version,
				d.encryption_key_id,
				d.nonce,
				d.ciphertext,
				d.lookup_key_id,
				d.lookup_hmac,
				u.created_at,
				u.updated_at
			FROM admin_identities d
			JOIN admin_users u ON u.id = d.admin_user_id
			WHERE d.lookup_key_id = $1 AND d.lookup_hmac = $2
			FOR UPDATE OF u, d
		`, candidate.KeyID, candidate.HMAC).Scan(
			&administrator.ID,
			&administrator.DisplayName,
			&administrator.Role,
			&administrator.Status,
			&administrator.SecurityVersion,
			&administrator.Identity.EncryptionKeyID,
			&administrator.Identity.Nonce,
			&administrator.Identity.Ciphertext,
			&administrator.Identity.LookupKeyID,
			&administrator.Identity.LookupHMAC,
			&administrator.CreatedAt,
			&administrator.UpdatedAt,
		)
		if errors.Is(err, pgx.ErrNoRows) {
			continue
		}
		if err != nil {
			return administratorRecord{}, false, errors.New("administrator identity could not be read")
		}
		if found.ID != uuid.Nil && found.ID != administrator.ID {
			return administratorRecord{}, false, errors.New("administrator identity lookup is ambiguous")
		}
		found = administrator
	}
	return found, found.ID != uuid.Nil, nil
}

func hasLiveActivationInvitation(ctx context.Context, tx pgx.Tx, administratorID uuid.UUID, now time.Time) (bool, error) {
	var live bool
	if err := tx.QueryRow(ctx, `
		SELECT EXISTS (
			SELECT 1
			FROM admin_invitations
			WHERE admin_user_id = $1
			  AND purpose = 'activation'
			  AND consumed_at IS NULL
			  AND expires_at > $2
		)
	`, administratorID, now).Scan(&live); err != nil {
		return false, errors.New("administrator invitation state could not be read")
	}
	return live, nil
}

func authorizeActor(ctx context.Context, tx pgx.Tx, actor Actor, permission rbac.Permission) (rbac.Role, error) {
	if actor.AdminID == uuid.Nil || !actor.Role.Valid() {
		return "", ErrPermissionDenied
	}
	var role rbac.Role
	var status Status
	if err := tx.QueryRow(ctx, `SELECT role, status FROM admin_users WHERE id = $1 FOR UPDATE`, actor.AdminID).Scan(&role, &status); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return "", ErrPermissionDenied
		}
		return "", errors.New("administrator actor could not be read")
	}
	if status != StatusActive || role != actor.Role || !rbac.Allowed(role, permission) {
		return "", ErrPermissionDenied
	}
	return role, nil
}

func insertAdministratorInvitation(
	ctx context.Context,
	tx pgx.Tx,
	administrator administratorRecord,
	invitation invitationRecord,
) error {
	if _, err := tx.Exec(ctx, `
		INSERT INTO admin_users (id, display_name, role, status, security_version, created_at, updated_at)
		VALUES ($1, $2, $3, 'invited', 1, $4, $4)
	`, administrator.ID, administrator.DisplayName, administrator.Role, administrator.CreatedAt); err != nil {
		return translateAdministratorInsertError(err)
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO admin_identities (
			admin_user_id, encryption_key_id, nonce, ciphertext, lookup_key_id, lookup_hmac
		) VALUES ($1, $2, $3, $4, $5, $6)
	`,
		administrator.ID,
		administrator.Identity.EncryptionKeyID,
		administrator.Identity.Nonce,
		administrator.Identity.Ciphertext,
		administrator.Identity.LookupKeyID,
		administrator.Identity.LookupHMAC,
	); err != nil {
		return translateAdministratorInsertError(err)
	}
	return insertInvitation(ctx, tx, invitation)
}

func reissueAdministratorInvitation(
	ctx context.Context,
	tx pgx.Tx,
	administrator administratorRecord,
	invitation invitationRecord,
	now time.Time,
) error {
	if administrator.Status != StatusInvited || administrator.ID != invitation.AdminID {
		return ErrStateConflict
	}
	if _, err := tx.Exec(ctx, `
		UPDATE admin_invitations
		SET consumed_at = $2,
			totp_encryption_key_id = NULL,
			totp_nonce = NULL,
			totp_ciphertext = NULL
		WHERE admin_user_id = $1
		  AND purpose = 'activation'
		  AND consumed_at IS NULL
	`, administrator.ID, now); err != nil {
		return errors.New("previous administrator invitations could not be invalidated")
	}
	command, err := tx.Exec(ctx, `
		UPDATE admin_users
		SET display_name = $2, role = $3, updated_at = $4
		WHERE id = $1 AND status = 'invited'
	`, administrator.ID, administrator.DisplayName, administrator.Role, now)
	if err != nil || command.RowsAffected() != 1 {
		return ErrStateConflict
	}
	if _, err := tx.Exec(ctx, `
		UPDATE admin_identities
		SET encryption_key_id = $2,
			nonce = $3,
			ciphertext = $4,
			lookup_key_id = $5,
			lookup_hmac = $6
		WHERE admin_user_id = $1
	`,
		administrator.ID,
		administrator.Identity.EncryptionKeyID,
		administrator.Identity.Nonce,
		administrator.Identity.Ciphertext,
		administrator.Identity.LookupKeyID,
		administrator.Identity.LookupHMAC,
	); err != nil {
		return translateAdministratorInsertError(err)
	}
	return insertInvitation(ctx, tx, invitation)
}

func insertInvitation(ctx context.Context, tx pgx.Tx, invitation invitationRecord) error {
	if _, err := tx.Exec(ctx, `
		INSERT INTO admin_invitations (
			id, admin_user_id, token_hmac, created_by_admin_id, created_at, expires_at,
			purpose, totp_encryption_key_id, totp_nonce, totp_ciphertext
		) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
	`,
		invitation.ID,
		invitation.AdminID,
		invitation.TokenDigest,
		invitation.CreatedByAdminID,
		invitation.CreatedAt,
		invitation.ExpiresAt,
		invitation.Purpose,
		invitation.TOTPSecret.KeyID,
		invitation.TOTPSecret.Nonce,
		invitation.TOTPSecret.Ciphertext,
	); err != nil {
		return errors.New("administrator invitation could not be created")
	}
	return nil
}

func findInvitation(ctx context.Context, source queryRower, tokenDigest []byte, forUpdate bool) (invitationRecord, error) {
	query := `
		SELECT
			i.id,
			i.admin_user_id,
			i.purpose,
			i.token_hmac,
			COALESCE(i.totp_encryption_key_id, ''),
			i.totp_nonce,
			i.totp_ciphertext,
			i.created_by_admin_id,
			i.created_at,
			i.expires_at,
			i.consumed_at,
			u.display_name,
			u.role,
			u.status,
			u.security_version,
			d.encryption_key_id,
			d.nonce,
			d.ciphertext,
			d.lookup_key_id,
			d.lookup_hmac,
			COALESCE(p.password_hash, ''),
			COALESCE(p.params_version, 0)
		FROM admin_invitations i
		JOIN admin_users u ON u.id = i.admin_user_id
		JOIN admin_identities d ON d.admin_user_id = u.id
		LEFT JOIN admin_password_credentials p ON p.admin_user_id = u.id
		WHERE i.token_hmac = $1
	`
	if forUpdate {
		query += ` FOR UPDATE OF i, u`
	}
	var invitation invitationRecord
	if err := source.QueryRow(ctx, query, tokenDigest).Scan(
		&invitation.ID,
		&invitation.AdminID,
		&invitation.Purpose,
		&invitation.TokenDigest,
		&invitation.TOTPSecret.KeyID,
		&invitation.TOTPSecret.Nonce,
		&invitation.TOTPSecret.Ciphertext,
		&invitation.CreatedByAdminID,
		&invitation.CreatedAt,
		&invitation.ExpiresAt,
		&invitation.ConsumedAt,
		&invitation.DisplayName,
		&invitation.Role,
		&invitation.Status,
		&invitation.SecurityVersion,
		&invitation.Identity.EncryptionKeyID,
		&invitation.Identity.Nonce,
		&invitation.Identity.Ciphertext,
		&invitation.Identity.LookupKeyID,
		&invitation.Identity.LookupHMAC,
		&invitation.PasswordHash,
		&invitation.PasswordVersion,
	); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return invitationRecord{}, ErrInvalidInvitation
		}
		return invitationRecord{}, errors.New("administrator invitation could not be read")
	}
	invitation.CreatedAt = invitation.CreatedAt.UTC()
	invitation.ExpiresAt = invitation.ExpiresAt.UTC()
	return invitation, nil
}

func lockAdministrator(ctx context.Context, tx pgx.Tx, id uuid.UUID) (administratorRecord, error) {
	var administrator administratorRecord
	if err := tx.QueryRow(ctx, `
		SELECT id, display_name, role, status, security_version, created_at, updated_at
		FROM admin_users
		WHERE id = $1
		FOR UPDATE
	`, id).Scan(
		&administrator.ID,
		&administrator.DisplayName,
		&administrator.Role,
		&administrator.Status,
		&administrator.SecurityVersion,
		&administrator.CreatedAt,
		&administrator.UpdatedAt,
	); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return administratorRecord{}, ErrAdministratorNotFound
		}
		return administratorRecord{}, errors.New("administrator could not be read")
	}
	return administrator, nil
}

func listAdministratorRecords(ctx context.Context, tx pgx.Tx) ([]administratorRecord, error) {
	rows, err := tx.Query(ctx, `
		SELECT
			u.id,
			u.display_name,
			u.role,
			u.status,
			u.security_version,
			d.encryption_key_id,
			d.nonce,
			d.ciphertext,
			d.lookup_key_id,
			d.lookup_hmac,
			(t.admin_user_id IS NOT NULL),
			last_session.last_login_at,
			u.created_at,
			u.updated_at
		FROM admin_users u
		JOIN admin_identities d ON d.admin_user_id = u.id
		LEFT JOIN admin_totp_credentials t ON t.admin_user_id = u.id
		LEFT JOIN LATERAL (
			SELECT max(created_at) AS last_login_at
			FROM admin_sessions s
			WHERE s.admin_user_id = u.id
		) last_session ON TRUE
		ORDER BY u.created_at, u.id
	`)
	if err != nil {
		return nil, errors.New("administrators could not be listed")
	}
	defer rows.Close()
	records := make([]administratorRecord, 0)
	for rows.Next() {
		var administrator administratorRecord
		if err := rows.Scan(
			&administrator.ID,
			&administrator.DisplayName,
			&administrator.Role,
			&administrator.Status,
			&administrator.SecurityVersion,
			&administrator.Identity.EncryptionKeyID,
			&administrator.Identity.Nonce,
			&administrator.Identity.Ciphertext,
			&administrator.Identity.LookupKeyID,
			&administrator.Identity.LookupHMAC,
			&administrator.MFAEnabled,
			&administrator.LastLoginAt,
			&administrator.CreatedAt,
			&administrator.UpdatedAt,
		); err != nil {
			return nil, errors.New("administrator list contains an unreadable record")
		}
		records = append(records, administrator)
	}
	if err := rows.Err(); err != nil {
		return nil, errors.New("administrators could not be listed")
	}
	return records, nil
}

func translateAdministratorInsertError(err error) error {
	var postgresError *pgconn.PgError
	if errors.As(err, &postgresError) && postgresError.Code == "23505" &&
		(postgresError.ConstraintName == "admin_identities_lookup_key" || postgresError.ConstraintName == "admin_identities_pkey") {
		return ErrIdentityExists
	}
	return errors.New("administrator could not be created")
}
