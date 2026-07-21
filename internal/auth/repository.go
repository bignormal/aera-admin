package auth

import (
	"context"
	"errors"
	"time"

	"github.com/bignormal/aera-admin/internal/rbac"
	"github.com/bignormal/aera-admin/internal/secure"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

type repository struct {
	postgres *pgxpool.Pool
}

type loginAdministratorRecord struct {
	ID               uuid.UUID
	DisplayName      string
	Role             rbac.Role
	Status           string
	SecurityVersion  int64
	PasswordHash     string
	PasswordVersion  int
	TOTPSecret       secure.SealedSecret
	LastAcceptedStep int64
}

type sessionRecord struct {
	ID                           uuid.UUID
	AdminID                      uuid.UUID
	TokenHMAC                    []byte
	CSRFHMAC                     []byte
	SecurityVersion              int64
	Role                         rbac.Role
	MFAMethod                    MFAMethod
	MFAAuthenticatedAt           time.Time
	TOTPAuthenticatedAt          *time.Time
	CreatedAt                    time.Time
	LastSeenAt                   time.Time
	IdleExpiresAt                time.Time
	AbsoluteExpiresAt            time.Time
	RevokedAt                    *time.Time
	AdministratorRole            rbac.Role
	AdministratorStatus          string
	AdministratorSecurityVersion int64
	DisplayName                  string
}

type stepUpRecord struct {
	Session          sessionRecord
	TOTPSecret       secure.SealedSecret
	LastAcceptedStep int64
}

func (repository *repository) begin(ctx context.Context) (pgx.Tx, error) {
	if repository == nil || repository.postgres == nil {
		return nil, ErrUnavailable
	}
	tx, err := repository.postgres.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return nil, ErrUnavailable
	}
	return tx, nil
}

func findLoginAdministratorByLookup(
	ctx context.Context,
	postgres *pgxpool.Pool,
	candidates []secure.LookupIndex,
) (loginAdministratorRecord, bool, error) {
	if postgres == nil {
		return loginAdministratorRecord{}, false, ErrUnavailable
	}
	var found loginAdministratorRecord
	for _, candidate := range candidates {
		var administrator loginAdministratorRecord
		err := postgres.QueryRow(ctx, `
			SELECT
				u.id,
				u.display_name,
				u.role,
				u.status,
				u.security_version,
				p.password_hash,
				p.params_version,
				t.encryption_key_id,
				t.nonce,
				t.ciphertext,
				t.last_accepted_step
			FROM admin_identities d
			JOIN admin_users u ON u.id = d.admin_user_id
			JOIN admin_password_credentials p ON p.admin_user_id = u.id
			JOIN admin_totp_credentials t ON t.admin_user_id = u.id
			WHERE d.lookup_key_id = $1 AND d.lookup_hmac = $2
		`, candidate.KeyID, candidate.HMAC).Scan(
			&administrator.ID,
			&administrator.DisplayName,
			&administrator.Role,
			&administrator.Status,
			&administrator.SecurityVersion,
			&administrator.PasswordHash,
			&administrator.PasswordVersion,
			&administrator.TOTPSecret.KeyID,
			&administrator.TOTPSecret.Nonce,
			&administrator.TOTPSecret.Ciphertext,
			&administrator.LastAcceptedStep,
		)
		if errors.Is(err, pgx.ErrNoRows) {
			continue
		}
		if err != nil {
			return loginAdministratorRecord{}, false, ErrUnavailable
		}
		if found.ID != uuid.Nil && found.ID != administrator.ID {
			return loginAdministratorRecord{}, false, ErrUnavailable
		}
		found = administrator
	}
	return found, found.ID != uuid.Nil, nil
}

func lockLoginAdministrator(ctx context.Context, tx pgx.Tx, administratorID uuid.UUID) (loginAdministratorRecord, error) {
	var administrator loginAdministratorRecord
	if err := tx.QueryRow(ctx, `
		SELECT
			u.id,
			u.display_name,
			u.role,
			u.status,
			u.security_version,
			p.password_hash,
			p.params_version,
			t.encryption_key_id,
			t.nonce,
			t.ciphertext,
			t.last_accepted_step
		FROM admin_users u
		JOIN admin_password_credentials p ON p.admin_user_id = u.id
		JOIN admin_totp_credentials t ON t.admin_user_id = u.id
		WHERE u.id = $1
		FOR UPDATE OF u, p, t
	`, administratorID).Scan(
		&administrator.ID,
		&administrator.DisplayName,
		&administrator.Role,
		&administrator.Status,
		&administrator.SecurityVersion,
		&administrator.PasswordHash,
		&administrator.PasswordVersion,
		&administrator.TOTPSecret.KeyID,
		&administrator.TOTPSecret.Nonce,
		&administrator.TOTPSecret.Ciphertext,
		&administrator.LastAcceptedStep,
	); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return loginAdministratorRecord{}, ErrInvalidCredentials
		}
		return loginAdministratorRecord{}, ErrUnavailable
	}
	return administrator, nil
}

func acceptTOTPStep(ctx context.Context, tx pgx.Tx, administratorID uuid.UUID, previousStep, acceptedStep int64, now time.Time) error {
	command, err := tx.Exec(ctx, `
		UPDATE admin_totp_credentials
		SET last_accepted_step = $3, updated_at = $4
		WHERE admin_user_id = $1 AND last_accepted_step = $2 AND $3 > $2
	`, administratorID, previousStep, acceptedStep, now)
	if err != nil || command.RowsAffected() != 1 {
		return ErrInvalidCredentials
	}
	return nil
}

func consumeRecoveryCode(ctx context.Context, tx pgx.Tx, administratorID uuid.UUID, digest []byte, now time.Time) (bool, error) {
	if len(digest) != 32 {
		return false, nil
	}
	command, err := tx.Exec(ctx, `
		UPDATE admin_recovery_codes
		SET consumed_at = $3
		WHERE admin_user_id = $1 AND code_hmac = $2 AND consumed_at IS NULL
	`, administratorID, digest, now)
	if err != nil {
		return false, ErrUnavailable
	}
	return command.RowsAffected() == 1, nil
}

func revokeAdministratorSessionsTx(ctx context.Context, tx pgx.Tx, administratorID uuid.UUID, now time.Time) ([][]byte, error) {
	rows, err := tx.Query(ctx, `
		UPDATE admin_sessions
		SET revoked_at = $2
		WHERE admin_user_id = $1 AND revoked_at IS NULL
		RETURNING token_hmac
	`, administratorID, now)
	if err != nil {
		return nil, ErrUnavailable
	}
	defer rows.Close()
	digests := make([][]byte, 0)
	for rows.Next() {
		var digest []byte
		if err := rows.Scan(&digest); err != nil || len(digest) != 32 {
			return nil, ErrUnavailable
		}
		digests = append(digests, append([]byte(nil), digest...))
	}
	if err := rows.Err(); err != nil {
		return nil, ErrUnavailable
	}
	return digests, nil
}

func insertSession(ctx context.Context, tx pgx.Tx, session sessionRecord) error {
	if _, err := tx.Exec(ctx, `
		INSERT INTO admin_sessions (
			id, admin_user_id, token_hmac, csrf_hmac, security_version, role,
			mfa_method, mfa_authenticated_at, totp_authenticated_at, created_at, last_seen_at,
			idle_expires_at, absolute_expires_at
		) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $10, $11, $12)
	`,
		session.ID,
		session.AdminID,
		session.TokenHMAC,
		session.CSRFHMAC,
		session.SecurityVersion,
		session.Role,
		session.MFAMethod,
		session.MFAAuthenticatedAt,
		session.TOTPAuthenticatedAt,
		session.CreatedAt,
		session.IdleExpiresAt,
		session.AbsoluteExpiresAt,
	); err != nil {
		return ErrUnavailable
	}
	return nil
}

func revokeSession(ctx context.Context, postgres *pgxpool.Pool, sessionID uuid.UUID, now time.Time) error {
	if postgres == nil || sessionID == uuid.Nil {
		return ErrUnavailable
	}
	if _, err := postgres.Exec(ctx, `
		UPDATE admin_sessions
		SET revoked_at = $2
		WHERE id = $1 AND revoked_at IS NULL
	`, sessionID, now); err != nil {
		return ErrUnavailable
	}
	return nil
}

func findSessionByTokenHMAC(ctx context.Context, postgres *pgxpool.Pool, tokenHMAC []byte) (sessionRecord, error) {
	if postgres == nil || len(tokenHMAC) != 32 {
		return sessionRecord{}, ErrInvalidSession
	}
	var session sessionRecord
	if err := postgres.QueryRow(ctx, `
		SELECT
			s.id,
			s.admin_user_id,
			s.token_hmac,
			s.csrf_hmac,
			s.security_version,
			s.role,
			s.mfa_method,
			s.mfa_authenticated_at,
			s.totp_authenticated_at,
			s.created_at,
			s.last_seen_at,
			s.idle_expires_at,
			s.absolute_expires_at,
			s.revoked_at,
			u.role,
			u.status,
			u.security_version,
			u.display_name
		FROM admin_sessions s
		JOIN admin_users u ON u.id = s.admin_user_id
		WHERE s.token_hmac = $1
	`, tokenHMAC).Scan(
		&session.ID,
		&session.AdminID,
		&session.TokenHMAC,
		&session.CSRFHMAC,
		&session.SecurityVersion,
		&session.Role,
		&session.MFAMethod,
		&session.MFAAuthenticatedAt,
		&session.TOTPAuthenticatedAt,
		&session.CreatedAt,
		&session.LastSeenAt,
		&session.IdleExpiresAt,
		&session.AbsoluteExpiresAt,
		&session.RevokedAt,
		&session.AdministratorRole,
		&session.AdministratorStatus,
		&session.AdministratorSecurityVersion,
		&session.DisplayName,
	); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return sessionRecord{}, ErrInvalidSession
		}
		return sessionRecord{}, ErrUnavailable
	}
	session.MFAAuthenticatedAt = session.MFAAuthenticatedAt.UTC()
	session.TOTPAuthenticatedAt = utcTimePointer(session.TOTPAuthenticatedAt)
	session.CreatedAt = session.CreatedAt.UTC()
	session.LastSeenAt = session.LastSeenAt.UTC()
	session.IdleExpiresAt = session.IdleExpiresAt.UTC()
	session.AbsoluteExpiresAt = session.AbsoluteExpiresAt.UTC()
	return session, nil
}

func touchSession(
	ctx context.Context,
	postgres *pgxpool.Pool,
	sessionID uuid.UUID,
	lastSeen, idleExpires time.Time,
	updateLastSeen bool,
) error {
	if postgres == nil || sessionID == uuid.Nil {
		return ErrUnavailable
	}
	command, err := postgres.Exec(ctx, `
		UPDATE admin_sessions
		SET last_seen_at = CASE WHEN $4 THEN GREATEST(last_seen_at, $2) ELSE last_seen_at END,
			idle_expires_at = GREATEST(idle_expires_at, $3)
		WHERE id = $1 AND revoked_at IS NULL AND absolute_expires_at > $2
	`, sessionID, lastSeen, idleExpires, updateLastSeen)
	if err != nil {
		return ErrUnavailable
	}
	if command.RowsAffected() != 1 {
		return ErrInvalidSession
	}
	return nil
}

func lockSessionForStepUp(ctx context.Context, tx pgx.Tx, tokenHMAC []byte) (stepUpRecord, error) {
	var record stepUpRecord
	if len(tokenHMAC) != 32 {
		return stepUpRecord{}, ErrInvalidSession
	}
	if err := tx.QueryRow(ctx, `
		SELECT
			s.id,
			s.admin_user_id,
			s.token_hmac,
			s.csrf_hmac,
			s.security_version,
			s.role,
			s.mfa_method,
			s.mfa_authenticated_at,
			s.totp_authenticated_at,
			s.created_at,
			s.last_seen_at,
			s.idle_expires_at,
			s.absolute_expires_at,
			s.revoked_at,
			u.role,
			u.status,
			u.security_version,
			u.display_name,
			t.encryption_key_id,
			t.nonce,
			t.ciphertext,
			t.last_accepted_step
		FROM admin_sessions s
		JOIN admin_users u ON u.id = s.admin_user_id
		JOIN admin_totp_credentials t ON t.admin_user_id = u.id
		WHERE s.token_hmac = $1
		FOR UPDATE OF s, u, t
	`, tokenHMAC).Scan(
		&record.Session.ID,
		&record.Session.AdminID,
		&record.Session.TokenHMAC,
		&record.Session.CSRFHMAC,
		&record.Session.SecurityVersion,
		&record.Session.Role,
		&record.Session.MFAMethod,
		&record.Session.MFAAuthenticatedAt,
		&record.Session.TOTPAuthenticatedAt,
		&record.Session.CreatedAt,
		&record.Session.LastSeenAt,
		&record.Session.IdleExpiresAt,
		&record.Session.AbsoluteExpiresAt,
		&record.Session.RevokedAt,
		&record.Session.AdministratorRole,
		&record.Session.AdministratorStatus,
		&record.Session.AdministratorSecurityVersion,
		&record.Session.DisplayName,
		&record.TOTPSecret.KeyID,
		&record.TOTPSecret.Nonce,
		&record.TOTPSecret.Ciphertext,
		&record.LastAcceptedStep,
	); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return stepUpRecord{}, ErrInvalidSession
		}
		return stepUpRecord{}, ErrUnavailable
	}
	record.Session.MFAAuthenticatedAt = record.Session.MFAAuthenticatedAt.UTC()
	record.Session.TOTPAuthenticatedAt = utcTimePointer(record.Session.TOTPAuthenticatedAt)
	return record, nil
}

func persistStepUp(ctx context.Context, tx pgx.Tx, sessionID uuid.UUID, at time.Time) error {
	command, err := tx.Exec(ctx, `
		UPDATE admin_sessions
		SET totp_authenticated_at = $2
		WHERE id = $1 AND revoked_at IS NULL
	`, sessionID, at)
	if err != nil {
		return ErrUnavailable
	}
	if command.RowsAffected() != 1 {
		return ErrInvalidSession
	}
	return nil
}

func lockSessionByTokenHMAC(ctx context.Context, tx pgx.Tx, tokenHMAC []byte) (sessionRecord, error) {
	var session sessionRecord
	if len(tokenHMAC) != 32 {
		return sessionRecord{}, ErrInvalidSession
	}
	if err := tx.QueryRow(ctx, `
		SELECT
			s.id,
			s.admin_user_id,
			s.token_hmac,
			s.csrf_hmac,
			s.security_version,
			s.role,
			s.mfa_method,
			s.mfa_authenticated_at,
			s.totp_authenticated_at,
			s.created_at,
			s.last_seen_at,
			s.idle_expires_at,
			s.absolute_expires_at,
			s.revoked_at,
			u.role,
			u.status,
			u.security_version,
			u.display_name
		FROM admin_sessions s
		JOIN admin_users u ON u.id = s.admin_user_id
		WHERE s.token_hmac = $1
		FOR UPDATE OF s, u
	`, tokenHMAC).Scan(
		&session.ID,
		&session.AdminID,
		&session.TokenHMAC,
		&session.CSRFHMAC,
		&session.SecurityVersion,
		&session.Role,
		&session.MFAMethod,
		&session.MFAAuthenticatedAt,
		&session.TOTPAuthenticatedAt,
		&session.CreatedAt,
		&session.LastSeenAt,
		&session.IdleExpiresAt,
		&session.AbsoluteExpiresAt,
		&session.RevokedAt,
		&session.AdministratorRole,
		&session.AdministratorStatus,
		&session.AdministratorSecurityVersion,
		&session.DisplayName,
	); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return sessionRecord{}, ErrInvalidSession
		}
		return sessionRecord{}, ErrUnavailable
	}
	session.MFAAuthenticatedAt = session.MFAAuthenticatedAt.UTC()
	session.TOTPAuthenticatedAt = utcTimePointer(session.TOTPAuthenticatedAt)
	return session, nil
}

func revokeSessionTx(ctx context.Context, tx pgx.Tx, sessionID uuid.UUID, now time.Time) error {
	command, err := tx.Exec(ctx, `
		UPDATE admin_sessions
		SET revoked_at = $2
		WHERE id = $1 AND revoked_at IS NULL
	`, sessionID, now)
	if err != nil {
		return ErrUnavailable
	}
	if command.RowsAffected() != 1 {
		return ErrInvalidSession
	}
	return nil
}

func utcTimePointer(value *time.Time) *time.Time {
	if value == nil {
		return nil
	}
	normalized := value.UTC()
	return &normalized
}
