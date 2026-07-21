package store

import (
	"context"
	"errors"

	"github.com/jackc/pgx/v5/pgxpool"
)

func OpenPostgreSQL(ctx context.Context, databaseURL string) (*pgxpool.Pool, error) {
	config, err := pgxpool.ParseConfig(databaseURL)
	if err != nil {
		return nil, errors.New("PostgreSQL configuration is invalid")
	}
	pool, err := pgxpool.NewWithConfig(ctx, config)
	if err != nil {
		return nil, errors.New("PostgreSQL client is unavailable")
	}
	if err := pool.Ping(ctx); err != nil {
		pool.Close()
		return nil, errors.New("PostgreSQL is unavailable")
	}
	return pool, nil
}
