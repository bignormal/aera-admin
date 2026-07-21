package audit

import (
	"context"
	"crypto/sha256"
	"crypto/subtle"
	"errors"
	"reflect"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

type Recorder interface {
	Append(context.Context, Record) (uuid.UUID, error)
}

type TransactionalRecorder interface {
	AppendTx(context.Context, pgx.Tx, Record) (uuid.UUID, error)
}

type Service struct {
	postgres *pgxpool.Pool
	clock    func() time.Time
}

func NewService(postgres *pgxpool.Pool) (*Service, error) {
	if postgres == nil {
		return nil, errors.New("administrator audit PostgreSQL pool is required")
	}
	return &Service{postgres: postgres, clock: time.Now}, nil
}

func (service *Service) Append(ctx context.Context, record Record) (uuid.UUID, error) {
	prepared, err := prepareRecord(record)
	if err != nil {
		return uuid.Nil, err
	}
	if service == nil || service.postgres == nil {
		return uuid.Nil, errors.New("administrator audit service is unavailable")
	}
	tx, err := service.postgres.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return uuid.Nil, errors.New("administrator audit transaction could not start")
	}
	defer func() { _ = tx.Rollback(context.Background()) }()
	id, err := service.appendPreparedTx(ctx, tx, prepared)
	if err != nil {
		return uuid.Nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return uuid.Nil, errors.New("administrator audit transaction could not be committed")
	}
	return id, nil
}

func (service *Service) AppendTx(ctx context.Context, tx pgx.Tx, record Record) (uuid.UUID, error) {
	prepared, err := prepareRecord(record)
	if err != nil {
		return uuid.Nil, err
	}
	if service == nil || tx == nil {
		return uuid.Nil, errors.New("administrator audit transaction is unavailable")
	}
	return service.appendPreparedTx(ctx, tx, prepared)
}

func (service *Service) appendPreparedTx(ctx context.Context, tx pgx.Tx, record Record) (uuid.UUID, error) {
	if err := lockAuditChain(ctx, tx); err != nil {
		return uuid.Nil, err
	}
	previousHash, previousCreatedAt, err := latestAuditHash(ctx, tx)
	if err != nil {
		return uuid.Nil, err
	}
	id, err := uuid.NewRandom()
	if err != nil {
		return uuid.Nil, errors.New("administrator audit event identifier could not be generated")
	}
	clock := service.clock
	if clock == nil {
		clock = time.Now
	}
	createdAt := clock().UTC().Truncate(time.Microsecond)
	if !previousCreatedAt.IsZero() && !createdAt.After(previousCreatedAt) {
		createdAt = previousCreatedAt.Add(time.Microsecond)
	}
	event := auditEvent{ID: id, Record: record, PreviousHash: previousHash, CreatedAt: createdAt}
	canonical := canonicalBytes(event)
	hasher := sha256.New()
	_, _ = hasher.Write(previousHash)
	_, _ = hasher.Write(canonical)
	event.EventHash = hasher.Sum(nil)
	if err := insertAuditEvent(ctx, tx, event); err != nil {
		return uuid.Nil, err
	}
	return id, nil
}

func (service *Service) Verify(ctx context.Context) error {
	if service == nil || service.postgres == nil {
		return errors.New("administrator audit service is unavailable")
	}
	tx, err := service.postgres.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead})
	if err != nil {
		return errors.New("administrator audit verification could not start")
	}
	defer func() { _ = tx.Rollback(context.Background()) }()
	if err := lockAuditChain(ctx, tx); err != nil {
		return err
	}
	events, err := loadAuditEvents(ctx, tx)
	if err != nil {
		return err
	}
	expectedPrevious := make([]byte, sha256.Size)
	var previousCreatedAt time.Time
	for _, event := range events {
		if event.ID == uuid.Nil || len(event.PreviousHash) != sha256.Size || len(event.EventHash) != sha256.Size ||
			(!previousCreatedAt.IsZero() && !event.CreatedAt.After(previousCreatedAt)) {
			return ErrIntegrity
		}
		prepared, err := prepareRecord(event.Record)
		if err != nil || !reflect.DeepEqual(prepared, event.Record) {
			return ErrIntegrity
		}
		if subtle.ConstantTimeCompare(event.PreviousHash, expectedPrevious) != 1 {
			return ErrIntegrity
		}
		hasher := sha256.New()
		_, _ = hasher.Write(expectedPrevious)
		_, _ = hasher.Write(canonicalBytes(event))
		expectedHash := hasher.Sum(nil)
		if subtle.ConstantTimeCompare(event.EventHash, expectedHash) != 1 {
			return ErrIntegrity
		}
		expectedPrevious = append(expectedPrevious[:0], event.EventHash...)
		previousCreatedAt = event.CreatedAt
	}
	if err := tx.Commit(ctx); err != nil {
		return errors.New("administrator audit verification could not finish")
	}
	return nil
}

var _ Recorder = (*Service)(nil)
var _ TransactionalRecorder = (*Service)(nil)
