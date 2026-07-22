package settings

import (
	"context"
	"errors"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

type Store struct {
	postgres *pgxpool.Pool
}

func NewStore(postgres *pgxpool.Pool) (*Store, error) {
	if postgres == nil {
		return nil, errors.New("settings PostgreSQL pool is required")
	}
	return &Store{postgres: postgres}, nil
}

func (store *Store) GetPolicy(ctx context.Context) (Policy, error) {
	if store == nil || store.postgres == nil {
		return Policy{}, ErrUnavailable
	}
	policy, err := readPolicy(ctx, store.postgres, false)
	if err != nil {
		return Policy{}, ErrUnavailable
	}
	if err := policy.Validate(); err != nil {
		return Policy{}, ErrUnavailable
	}
	return policy, nil
}

func (store *Store) SessionLifetimes(ctx context.Context) (time.Duration, time.Duration, error) {
	policy, err := store.GetPolicy(ctx)
	if err != nil {
		return 0, 0, ErrUnavailable
	}
	idle, absolute, err := policy.SessionLifetimes()
	if err != nil {
		return 0, 0, ErrUnavailable
	}
	return idle, absolute, nil
}

func (store *Store) ListReasonCodes(ctx context.Context, query ReasonQuery) (Page, error) {
	if store == nil || store.postgres == nil {
		return Page{}, ErrUnavailable
	}
	if err := query.Validate(); err != nil {
		return Page{}, err
	}
	tx, err := store.postgres.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly})
	if err != nil {
		return Page{}, ErrUnavailable
	}
	defer func() { _ = tx.Rollback(context.Background()) }()
	var settingsRevision int64
	if err := tx.QueryRow(ctx, `SELECT revision FROM admin_security_settings WHERE settings_key = 'global'`).Scan(&settingsRevision); err != nil || settingsRevision <= 0 {
		return Page{}, ErrUnavailable
	}
	statement := `
		SELECT code, category, label, active, revision, created_at, updated_at
		FROM reason_codes
		WHERE 1 = 1
	`
	arguments := make([]any, 0, 2)
	if query.Usage != "" {
		arguments = append(arguments, string(query.Usage), string(CategorySecurity))
		statement += ` AND active = TRUE AND (category = $1 OR category = $2)`
	} else if query.Category != "" {
		arguments = append(arguments, string(query.Category))
		statement += ` AND category = $1`
		if !query.IncludeInactive {
			statement += ` AND active = TRUE`
		}
	} else if !query.IncludeInactive {
		statement += ` AND active = TRUE`
	}
	statement += ` ORDER BY category ASC, code ASC`
	rows, err := tx.Query(ctx, statement, arguments...)
	if err != nil {
		return Page{}, ErrUnavailable
	}
	defer rows.Close()
	items := make([]ReasonCode, 0)
	for rows.Next() {
		var reason ReasonCode
		if err := rows.Scan(
			&reason.Code, &reason.Category, &reason.Label, &reason.Active,
			&reason.Revision, &reason.CreatedAt, &reason.UpdatedAt,
		); err != nil || reason.Validate() != nil || query.Usage != "" && !CompatibleReason(query.Usage, reason.Category) {
			return Page{}, ErrUnavailable
		}
		items = append(items, reason)
	}
	if rows.Err() != nil {
		return Page{}, ErrUnavailable
	}
	if err := tx.Commit(ctx); err != nil {
		return Page{}, ErrUnavailable
	}
	return Page{Items: items, SettingsRevision: settingsRevision}, nil
}

func (store *Store) ValidateReason(ctx context.Context, usage ReasonUsage, code string) error {
	if store == nil || store.postgres == nil {
		return ErrUnavailable
	}
	return validateReason(ctx, store.postgres, usage, code)
}

type queryRower interface {
	QueryRow(context.Context, string, ...any) pgx.Row
}

func readPolicy(ctx context.Context, queryer queryRower, lock bool) (Policy, error) {
	statement := `
		SELECT session_idle_minutes, session_absolute_hours, audit_retention_days,
			revision, updated_by_admin_id, updated_at
		FROM admin_security_settings
		WHERE settings_key = 'global'
	`
	if lock {
		statement += ` FOR UPDATE`
	}
	var policy Policy
	if err := queryer.QueryRow(ctx, statement).Scan(
		&policy.SessionIdleMinutes, &policy.SessionAbsoluteHours, &policy.AuditRetentionDays,
		&policy.Revision, &policy.UpdatedByAdminID, &policy.UpdatedAt,
	); err != nil {
		return Policy{}, err
	}
	return policy, nil
}

func validateReason(ctx context.Context, queryer queryRower, usage ReasonUsage, code string) error {
	if !usage.Valid() || !reasonCodePattern.MatchString(code) {
		return ErrInvalidRequest
	}
	var category ReasonCategory
	var active bool
	if err := queryer.QueryRow(ctx, `SELECT category, active FROM reason_codes WHERE code = $1`, code).Scan(&category, &active); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return ErrReasonNotFound
		}
		return ErrUnavailable
	}
	if !category.Valid() {
		return ErrUnavailable
	}
	if !active {
		return ErrReasonInactive
	}
	if !CompatibleReason(usage, category) {
		return ErrReasonIncompatible
	}
	return nil
}

func cloneUUID(value *uuid.UUID) *uuid.UUID {
	if value == nil {
		return nil
	}
	cloned := *value
	return &cloned
}
