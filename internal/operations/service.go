package operations

import (
	"context"
	"errors"
	"time"

	"github.com/bignormal/aera-admin/internal/admin"
	"github.com/bignormal/aera-admin/internal/audit"
	"github.com/bignormal/aera-admin/internal/cloudadmin"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

type Service struct {
	repository *repository
	cloud      cloudadmin.Client
}

type ServiceConfig struct {
	PostgreSQL *pgxpool.Pool
	HMACKey    []byte
	Cloud      cloudadmin.Client
	Audit      *audit.Service
	Clock      func() time.Time
}

func NewService(settings ServiceConfig) (*Service, error) {
	repository, err := newRepository(settings.PostgreSQL, settings.HMACKey, settings.Audit, settings.Clock)
	if err != nil {
		return nil, err
	}
	if settings.Cloud == nil {
		return nil, errors.New("Cloud client is required")
	}
	return &Service{repository: repository, cloud: settings.Cloud}, nil
}

func (service *Service) EnqueueTx(ctx context.Context, tx pgx.Tx, request EnqueueRequest) (Result, error) {
	if service == nil || service.repository == nil {
		return Result{}, errors.New("operation service is unavailable")
	}
	return service.repository.EnqueueTx(ctx, tx, request)
}

func (service *Service) EnqueueImmediate(ctx context.Context, request EnqueueRequest) (Result, error) {
	if service == nil || service.repository == nil || service.cloud == nil {
		return Result{}, errors.New("operation service is unavailable")
	}
	if request.Action != RevokeDevice && request.Action != RevokeSession {
		return Result{}, ErrInvalidRequest
	}
	health, err := service.cloud.Health(ctx)
	if err != nil || health.Availability != cloudadmin.Available {
		return Result{}, ErrCloudUnavailable
	}
	return service.repository.Enqueue(ctx, request)
}

func (service *Service) Get(ctx context.Context, actor admin.Actor, operationID uuid.UUID) (Result, error) {
	if service == nil || service.repository == nil {
		return Result{}, errors.New("operation service is unavailable")
	}
	if actor.AdminID == uuid.Nil || !actor.Role.Valid() || operationID == uuid.Nil {
		return Result{}, ErrInvalidRequest
	}
	return service.repository.Get(ctx, actor, operationID)
}

var _ TransactionalEnqueuer = (*Service)(nil)
