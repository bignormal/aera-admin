package store

import (
	"context"
	"crypto/sha256"
	"crypto/subtle"
	"embed"
	"errors"
	"fmt"
	"io/fs"
	"path"
	"sort"
	"strconv"
	"strings"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

const migrationAdvisoryLockID int64 = 0x4145524141444d

//go:embed migrations/*.sql
var migrationFiles embed.FS

type migration struct {
	version  int64
	name     string
	contents []byte
	checksum [sha256.Size]byte
}

func Migrate(ctx context.Context, postgres *pgxpool.Pool) error {
	if postgres == nil {
		return errors.New("PostgreSQL migration pool is unavailable")
	}
	migrations, err := loadMigrations(migrationFiles)
	if err != nil {
		return err
	}

	tx, err := postgres.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return errors.New("PostgreSQL migration transaction could not start")
	}
	defer func() { _ = tx.Rollback(context.Background()) }()

	if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock($1)`, migrationAdvisoryLockID); err != nil {
		return errors.New("PostgreSQL migration lock could not be acquired")
	}
	if _, err := tx.Exec(ctx, `
		CREATE TABLE IF NOT EXISTS schema_migrations (
			version BIGINT PRIMARY KEY,
			name TEXT NOT NULL UNIQUE,
			checksum BYTEA NOT NULL,
			applied_at TIMESTAMPTZ NOT NULL DEFAULT now(),
			CONSTRAINT schema_migrations_version_check CHECK (version > 0),
			CONSTRAINT schema_migrations_checksum_length_check CHECK (octet_length(checksum) = 32)
		)
	`); err != nil {
		return errors.New("PostgreSQL migration ledger could not be prepared")
	}

	for _, item := range migrations {
		var existingName string
		var existingChecksum []byte
		err := tx.QueryRow(ctx,
			`SELECT name, checksum FROM schema_migrations WHERE version = $1`,
			item.version,
		).Scan(&existingName, &existingChecksum)
		switch {
		case err == nil:
			if existingName != item.name || !equalChecksum(existingChecksum, item.checksum[:]) {
				return fmt.Errorf("database migration %d does not match the applied version", item.version)
			}
			continue
		case !errors.Is(err, pgx.ErrNoRows):
			return errors.New("PostgreSQL migration ledger could not be read")
		}

		if _, err := tx.Exec(ctx, string(item.contents)); err != nil {
			return fmt.Errorf("database migration %s failed: %w", item.name, err)
		}
		if _, err := tx.Exec(ctx,
			`INSERT INTO schema_migrations (version, name, checksum) VALUES ($1, $2, $3)`,
			item.version,
			item.name,
			item.checksum[:],
		); err != nil {
			return errors.New("PostgreSQL migration ledger could not be updated")
		}
	}

	if err := tx.Commit(ctx); err != nil {
		return errors.New("PostgreSQL migrations could not be committed")
	}
	return nil
}

func loadMigrations(source fs.FS) ([]migration, error) {
	names, err := fs.Glob(source, "migrations/*.sql")
	if err != nil {
		return nil, errors.New("embedded PostgreSQL migrations could not be listed")
	}
	if len(names) == 0 {
		return nil, errors.New("no embedded PostgreSQL migrations were found")
	}

	loaded := make([]migration, 0, len(names))
	seenVersions := make(map[int64]struct{}, len(names))
	for _, name := range names {
		base := path.Base(name)
		separator := strings.IndexByte(base, '_')
		if separator <= 0 {
			return nil, fmt.Errorf("database migration %s has no numeric version", base)
		}
		version, err := strconv.ParseInt(base[:separator], 10, 64)
		if err != nil || version <= 0 {
			return nil, fmt.Errorf("database migration %s has an invalid version", base)
		}
		if _, duplicate := seenVersions[version]; duplicate {
			return nil, fmt.Errorf("database migration version %d is duplicated", version)
		}
		contents, err := fs.ReadFile(source, name)
		if err != nil || len(strings.TrimSpace(string(contents))) == 0 {
			return nil, fmt.Errorf("database migration %s could not be read", base)
		}
		seenVersions[version] = struct{}{}
		loaded = append(loaded, migration{
			version:  version,
			name:     base,
			contents: contents,
			checksum: sha256.Sum256(contents),
		})
	}
	sort.Slice(loaded, func(left, right int) bool { return loaded[left].version < loaded[right].version })
	return loaded, nil
}

func equalChecksum(left, right []byte) bool {
	if len(left) != sha256.Size || len(right) != sha256.Size {
		return false
	}
	return subtle.ConstantTimeCompare(left, right) == 1
}
