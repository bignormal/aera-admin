package rbacadmin

import (
	"context"
	"errors"
	"time"

	"github.com/bignormal/aera-admin/internal/rbac"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
)

// Store persists roles and their permission grants.
type Store struct {
	postgres *pgxpool.Pool
}

func NewStore(postgres *pgxpool.Pool) (*Store, error) {
	if postgres == nil {
		return nil, errors.New("rbac admin PostgreSQL pool is required")
	}
	return &Store{postgres: postgres}, nil
}

// LoadMatrix returns the ordered roles and their permission grants so the caller
// can publish them into the active rbac matrix. System roles are ordered before
// custom ones, both by creation time, for a stable menu/matrix display.
func (store *Store) LoadMatrix(ctx context.Context) ([]rbac.Role, map[rbac.Role][]rbac.Permission, error) {
	if store == nil || store.postgres == nil {
		return nil, nil, ErrUnavailable
	}
	roleRows, err := store.postgres.Query(ctx, `
		SELECT slug FROM admin_roles ORDER BY is_system DESC, created_at ASC, slug ASC
	`)
	if err != nil {
		return nil, nil, ErrUnavailable
	}
	defer roleRows.Close()
	roles := make([]rbac.Role, 0)
	for roleRows.Next() {
		var slug string
		if err := roleRows.Scan(&slug); err != nil {
			return nil, nil, ErrUnavailable
		}
		roles = append(roles, rbac.Role(slug))
	}
	if roleRows.Err() != nil {
		return nil, nil, ErrUnavailable
	}
	permissions := make(map[rbac.Role][]rbac.Permission, len(roles))
	for _, role := range roles {
		permissions[role] = nil
	}
	permRows, err := store.postgres.Query(ctx, `SELECT role_slug, permission FROM admin_role_permissions`)
	if err != nil {
		return nil, nil, ErrUnavailable
	}
	defer permRows.Close()
	for permRows.Next() {
		var slug, permission string
		if err := permRows.Scan(&slug, &permission); err != nil {
			return nil, nil, ErrUnavailable
		}
		role := rbac.Role(slug)
		permissions[role] = append(permissions[role], rbac.Permission(permission))
	}
	if permRows.Err() != nil {
		return nil, nil, ErrUnavailable
	}
	return roles, permissions, nil
}

// List returns every role with its permissions and how many administrators
// currently hold it (used to gate deletion in the console).
func (store *Store) List(ctx context.Context) ([]Role, error) {
	if store == nil || store.postgres == nil {
		return nil, ErrUnavailable
	}
	rows, err := store.postgres.Query(ctx, `
		SELECT r.slug, r.name, r.description, r.is_system, r.created_at, r.updated_at,
			COALESCE(u.user_count, 0)
		FROM admin_roles r
		LEFT JOIN (
			SELECT role, count(*) AS user_count FROM admin_users GROUP BY role
		) u ON u.role = r.slug
		ORDER BY r.is_system DESC, r.created_at ASC, r.slug ASC
	`)
	if err != nil {
		return nil, ErrUnavailable
	}
	defer rows.Close()
	roles := make([]Role, 0)
	index := make(map[string]int)
	for rows.Next() {
		var role Role
		if err := rows.Scan(
			&role.Slug, &role.Name, &role.Description, &role.IsSystem,
			&role.CreatedAt, &role.UpdatedAt, &role.UserCount,
		); err != nil {
			return nil, ErrUnavailable
		}
		role.Permissions = make([]rbac.Permission, 0)
		index[role.Slug] = len(roles)
		roles = append(roles, role)
	}
	if rows.Err() != nil {
		return nil, ErrUnavailable
	}
	permRows, err := store.postgres.Query(ctx, `SELECT role_slug, permission FROM admin_role_permissions`)
	if err != nil {
		return nil, ErrUnavailable
	}
	defer permRows.Close()
	for permRows.Next() {
		var slug, permission string
		if err := permRows.Scan(&slug, &permission); err != nil {
			return nil, ErrUnavailable
		}
		if at, ok := index[slug]; ok {
			roles[at].Permissions = append(roles[at].Permissions, rbac.Permission(permission))
		}
	}
	if permRows.Err() != nil {
		return nil, ErrUnavailable
	}
	for at := range roles {
		roles[at].Permissions = orderPermissions(roles[at].Permissions)
	}
	return roles, nil
}

// Get returns a single role or ErrRoleNotFound.
func (store *Store) Get(ctx context.Context, slug string) (Role, error) {
	if store == nil || store.postgres == nil {
		return Role{}, ErrUnavailable
	}
	var role Role
	if err := store.postgres.QueryRow(ctx, `
		SELECT slug, name, description, is_system, created_at, updated_at
		FROM admin_roles WHERE slug = $1
	`, slug).Scan(
		&role.Slug, &role.Name, &role.Description, &role.IsSystem, &role.CreatedAt, &role.UpdatedAt,
	); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return Role{}, ErrRoleNotFound
		}
		return Role{}, ErrUnavailable
	}
	rows, err := store.postgres.Query(ctx, `SELECT permission FROM admin_role_permissions WHERE role_slug = $1`, slug)
	if err != nil {
		return Role{}, ErrUnavailable
	}
	defer rows.Close()
	role.Permissions = make([]rbac.Permission, 0)
	for rows.Next() {
		var permission string
		if err := rows.Scan(&permission); err != nil {
			return Role{}, ErrUnavailable
		}
		role.Permissions = append(role.Permissions, rbac.Permission(permission))
	}
	if rows.Err() != nil {
		return Role{}, ErrUnavailable
	}
	role.Permissions = orderPermissions(role.Permissions)
	return role, nil
}

// Create inserts a new role and its permissions in one transaction.
func (store *Store) Create(ctx context.Context, slug, name, description string, permissions []rbac.Permission, now time.Time) error {
	if store == nil || store.postgres == nil {
		return ErrUnavailable
	}
	tx, err := store.postgres.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return ErrUnavailable
	}
	defer func() { _ = tx.Rollback(context.Background()) }()
	tag, err := tx.Exec(ctx, `
		INSERT INTO admin_roles (slug, name, description, is_system, created_at, updated_at)
		VALUES ($1, $2, $3, false, $4, $4)
		ON CONFLICT (slug) DO NOTHING
	`, slug, name, description, now)
	if err != nil {
		return ErrUnavailable
	}
	if tag.RowsAffected() != 1 {
		return ErrRoleExists
	}
	if err := insertPermissions(ctx, tx, slug, permissions); err != nil {
		return err
	}
	if err := tx.Commit(ctx); err != nil {
		return ErrUnavailable
	}
	return nil
}

// Update mutates an existing role's name/description/permissions. Nil pointers
// leave the corresponding field untouched.
func (store *Store) Update(ctx context.Context, slug string, name, description *string, permissions *[]rbac.Permission, now time.Time) error {
	if store == nil || store.postgres == nil {
		return ErrUnavailable
	}
	tx, err := store.postgres.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return ErrUnavailable
	}
	defer func() { _ = tx.Rollback(context.Background()) }()
	var isSystem bool
	if err := tx.QueryRow(ctx, `SELECT is_system FROM admin_roles WHERE slug = $1 FOR UPDATE`, slug).Scan(&isSystem); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return ErrRoleNotFound
		}
		return ErrUnavailable
	}
	if _, err := tx.Exec(ctx, `
		UPDATE admin_roles
		SET name = COALESCE($2, name), description = COALESCE($3, description), updated_at = $4
		WHERE slug = $1
	`, slug, name, description, now); err != nil {
		return ErrUnavailable
	}
	if permissions != nil {
		if _, err := tx.Exec(ctx, `DELETE FROM admin_role_permissions WHERE role_slug = $1`, slug); err != nil {
			return ErrUnavailable
		}
		if err := insertPermissions(ctx, tx, slug, *permissions); err != nil {
			return err
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return ErrUnavailable
	}
	return nil
}

// Delete removes a custom role. A role still assigned to an administrator is
// protected by the admin_users foreign key and reported as ErrRoleInUse.
func (store *Store) Delete(ctx context.Context, slug string) error {
	if store == nil || store.postgres == nil {
		return ErrUnavailable
	}
	tag, err := store.postgres.Exec(ctx, `DELETE FROM admin_roles WHERE slug = $1`, slug)
	if err != nil {
		if isForeignKeyViolation(err) {
			return ErrRoleInUse
		}
		return ErrUnavailable
	}
	if tag.RowsAffected() != 1 {
		return ErrRoleNotFound
	}
	return nil
}

func insertPermissions(ctx context.Context, tx pgx.Tx, slug string, permissions []rbac.Permission) error {
	for _, permission := range permissions {
		if _, err := tx.Exec(ctx,
			`INSERT INTO admin_role_permissions (role_slug, permission) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
			slug, string(permission),
		); err != nil {
			return ErrUnavailable
		}
	}
	return nil
}

func orderPermissions(permissions []rbac.Permission) []rbac.Permission {
	present := make(map[rbac.Permission]struct{}, len(permissions))
	for _, permission := range permissions {
		present[permission] = struct{}{}
	}
	ordered := make([]rbac.Permission, 0, len(present))
	for _, permission := range rbac.AllPermissions() {
		if _, ok := present[permission]; ok {
			ordered = append(ordered, permission)
		}
	}
	return ordered
}

func isForeignKeyViolation(err error) bool {
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) {
		return pgErr.Code == "23503"
	}
	return false
}
