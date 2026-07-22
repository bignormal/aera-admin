package operations

import (
	"context"
	"crypto/rand"
	"encoding/json"
	"errors"
	"math/big"
	"time"

	"github.com/bignormal/aera-admin/internal/cloudadmin"
	"github.com/google/uuid"
)

type WorkerConfig struct {
	Operations    *Service
	Cloud         cloudadmin.Client
	ExecutionSink ExecutionSink
	Clock         func() time.Time
	PollInterval  time.Duration
	BatchSize     int
	Lease         time.Duration
	Jitter        func() time.Duration
}

type Worker struct {
	repository   *repository
	cloud        cloudadmin.Client
	sink         ExecutionSink
	clock        func() time.Time
	pollInterval time.Duration
	batchSize    int
	lease        time.Duration
	jitter       func() time.Duration
	lastCleanup  time.Time
}

func NewWorker(settings WorkerConfig) (*Worker, error) {
	if settings.Operations == nil || settings.Operations.repository == nil || settings.Cloud == nil ||
		settings.ExecutionSink == nil || settings.Clock == nil || settings.PollInterval <= 0 ||
		settings.BatchSize < 1 || settings.BatchSize > 32 || settings.Lease < 5*time.Second ||
		settings.Lease > 5*time.Minute {
		return nil, errors.New("Outbox Worker dependencies are invalid")
	}
	jitter := settings.Jitter
	if jitter == nil {
		jitter = secureJitter
	}
	return &Worker{
		repository:   settings.Operations.repository,
		cloud:        settings.Cloud,
		sink:         settings.ExecutionSink,
		clock:        settings.Clock,
		pollInterval: settings.PollInterval,
		batchSize:    settings.BatchSize,
		lease:        settings.Lease,
		jitter:       jitter,
	}, nil
}

func (worker *Worker) RunOnce(ctx context.Context) error {
	if worker == nil || worker.repository == nil {
		return errors.New("Outbox Worker is unavailable")
	}
	now := worker.clock().UTC()
	if worker.lastCleanup.IsZero() || now.Sub(worker.lastCleanup) >= time.Hour {
		if _, err := worker.repository.CleanupExpired(ctx, now, 128); err != nil {
			return err
		}
		worker.lastCleanup = now
	}
	jobs, err := worker.repository.Claim(ctx, worker.batchSize, worker.lease, worker.sink)
	if err != nil {
		return err
	}
	var firstError error
	for _, job := range jobs {
		if err := worker.process(ctx, job); err != nil && !errors.Is(err, context.Canceled) && firstError == nil {
			firstError = err
		}
		if ctx.Err() != nil {
			return ctx.Err()
		}
	}
	return firstError
}

func (worker *Worker) Run(ctx context.Context) error {
	if worker == nil {
		return errors.New("Outbox Worker is unavailable")
	}
	ticker := time.NewTicker(worker.pollInterval)
	defer ticker.Stop()
	for {
		if err := worker.RunOnce(ctx); err != nil && ctx.Err() == nil {
			return err
		}
		select {
		case <-ctx.Done():
			return nil
		case <-ticker.C:
		}
	}
}

func (worker *Worker) process(ctx context.Context, job Job) error {
	if job.State == StateReconciling {
		operation, err := worker.cloud.GetOperation(ctx, job.OperationID)
		return worker.applyRemoteResult(ctx, job, operation, err)
	}
	meta := cloudadmin.CommandMeta{
		OperationID:      job.OperationID,
		ActorAdminID:     job.ActorAdminID,
		ApprovalID:       job.ApprovalID,
		RequestID:        job.RequestID,
		ReasonCode:       job.ReasonCode,
		TicketReference:  job.TicketReference,
		Note:             job.Note,
		ExpectedRevision: job.ExpectedRevision,
	}
	var operation cloudadmin.Operation
	var err error
	switch job.Action {
	case RevokeDevice:
		operation, err = worker.cloud.RevokeDevice(ctx, job.TargetID, meta)
	case RevokeSession:
		operation, err = worker.cloud.RevokeSession(ctx, job.TargetID, meta)
	case DisableUser:
		operation, err = worker.cloud.DisableUser(ctx, job.TargetID, meta)
	case EnableUser:
		operation, err = worker.cloud.EnableUser(ctx, job.TargetID, meta)
	case OfficialDefinitionReserve, OfficialDraftCreate, OfficialDraftUpdate,
		OfficialDraftSubmit, OfficialSubmissionWithdraw, OfficialSubmissionReview,
		OfficialReleaseActivate, OfficialReleaseRollout, OfficialReleasePause,
		OfficialReleaseResume:
		operation, err = worker.cloud.ExecuteOfficialCommand(ctx, cloudadmin.ActorContext{
			AdminID: job.ActorAdminID, Role: job.ActorRole, OperationID: &job.OperationID,
		}, cloudadmin.OfficialCommand{
			Action: cloudadmin.OfficialAction(job.Action), TargetID: job.TargetID,
			ExpectedRevision: job.ExpectedRevision, ReasonCode: job.ReasonCode,
			TicketReference: job.TicketReference, Payload: job.Payload,
		})
	case OfficialReleaseRollback:
		var payload OfficialReleaseRollbackPayload
		if decodeStrictCommandJSON(job.Payload, &payload) != nil {
			err = cloudadmin.ErrContractViolation
			break
		}
		requesterID, parseErr := uuid.Parse(payload.RequesterAdminID)
		if parseErr != nil || requesterID == uuid.Nil || requesterID == job.ActorAdminID || job.OfficialRollbackRequestID == nil {
			err = cloudadmin.ErrContractViolation
			break
		}
		cloudPayload, marshalErr := json.Marshal(struct {
			TargetVersionID         string `json:"target_version_id"`
			TargetReleaseRevisionID string `json:"target_release_revision_id"`
		}{payload.TargetVersionID, payload.TargetReleaseRevisionID})
		if marshalErr != nil {
			err = cloudadmin.ErrContractViolation
			break
		}
		operation, err = worker.cloud.ExecuteOfficialCommand(ctx, cloudadmin.ActorContext{
			AdminID: job.ActorAdminID, Role: job.ActorRole, OperationID: &job.OperationID,
			ApprovalID: job.OfficialRollbackRequestID, RequesterAdminID: &requesterID,
		}, cloudadmin.OfficialCommand{
			Action: cloudadmin.OfficialReleaseRollback, TargetID: job.TargetID,
			ExpectedRevision: job.ExpectedRevision, ReasonCode: job.ReasonCode,
			TicketReference: job.TicketReference, Payload: cloudPayload,
		})
	default:
		err = cloudadmin.ErrContractViolation
	}
	return worker.applyRemoteResult(ctx, job, operation, err)
}

func (worker *Worker) applyRemoteResult(ctx context.Context, job Job, operation cloudadmin.Operation, remoteErr error) error {
	now := worker.clock().UTC()
	if ctx.Err() != nil {
		return ctx.Err()
	}
	switch {
	case errors.Is(remoteErr, cloudadmin.ErrUnavailable):
		return worker.repository.Transition(
			ctx, job, StateReconciling, "OPERATION_STATUS_UNKNOWN",
			now.Add(backoff(job.Attempts, worker.jitter)), worker.sink,
		)
	case errors.Is(remoteErr, cloudadmin.ErrConflict):
		return worker.repository.Transition(ctx, job, StateConflict, "USER_STATE_CONFLICT", time.Time{}, worker.sink)
	case errors.Is(remoteErr, cloudadmin.ErrNotFound) && job.State == StateReconciling:
		return worker.repository.Transition(
			ctx, job, StateQueued, "", now.Add(backoff(job.Attempts, worker.jitter)), worker.sink,
		)
	case remoteErr != nil:
		return worker.repository.Transition(
			ctx, job, StateFailed, stableExecutionError(remoteErr), time.Time{}, worker.sink,
		)
	case operation.ID != job.OperationID:
		return worker.repository.Transition(
			ctx, job, StateFailed, "CLOUD_CONTRACT_VIOLATION", time.Time{}, worker.sink,
		)
	case operation.Status == cloudadmin.OperationSucceeded:
		return worker.repository.Transition(ctx, job, StateSucceeded, "", time.Time{}, worker.sink)
	case operation.Status == cloudadmin.OperationConflict:
		return worker.repository.Transition(
			ctx, job, StateConflict, stableRemoteCode(operation.ErrorCode, "USER_STATE_CONFLICT"),
			time.Time{}, worker.sink,
		)
	case operation.Status == cloudadmin.OperationFailed:
		return worker.repository.Transition(
			ctx, job, StateFailed, stableRemoteCode(operation.ErrorCode, "CLOUD_OPERATION_FAILED"),
			time.Time{}, worker.sink,
		)
	default:
		return worker.repository.Transition(
			ctx, job, StateReconciling, "OPERATION_STATUS_UNKNOWN",
			now.Add(backoff(job.Attempts, worker.jitter)), worker.sink,
		)
	}
}

func stableExecutionError(err error) string {
	switch {
	case errors.Is(err, cloudadmin.ErrNotConfigured):
		return "CLOUD_NOT_CONFIGURED"
	case errors.Is(err, cloudadmin.ErrContractViolation):
		return "CLOUD_CONTRACT_VIOLATION"
	case errors.Is(err, cloudadmin.ErrPermissionDenied):
		return "CLOUD_PERMISSION_DENIED"
	case errors.Is(err, cloudadmin.ErrPublicationDLPBlocked):
		return "PUBLICATION_DLP_BLOCKED"
	case errors.Is(err, context.DeadlineExceeded):
		return "CLOUD_TIMEOUT"
	default:
		return "CLOUD_OPERATION_FAILED"
	}
}

func stableRemoteCode(value, fallback string) string {
	if operationErrorCodePattern.MatchString(value) {
		return value
	}
	return fallback
}

func secureJitter() time.Duration {
	maximum := big.NewInt(251)
	value, err := rand.Int(rand.Reader, maximum)
	if err != nil {
		return 0
	}
	return time.Duration(value.Int64()) * time.Millisecond
}

func backoff(attempt int, jitter func() time.Duration) time.Duration {
	if attempt < 1 {
		attempt = 1
	}
	if attempt > 8 {
		attempt = 8
	}
	bounded := jitter()
	if bounded < 0 || bounded > 250*time.Millisecond {
		bounded = 0
	}
	return time.Duration(1<<uint(attempt-1))*time.Second + bounded
}
