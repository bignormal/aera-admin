package operations

import (
	"context"
	"errors"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

type compositeExecutionSink struct {
	sinks []ExecutionSink
}

func CombineExecutionSinks(sinks ...ExecutionSink) (ExecutionSink, error) {
	if len(sinks) == 0 {
		return nil, errors.New("at least one operation execution sink is required")
	}
	cloned := make([]ExecutionSink, len(sinks))
	for index, sink := range sinks {
		if sink == nil {
			return nil, errors.New("operation execution sink is required")
		}
		cloned[index] = sink
	}
	return &compositeExecutionSink{sinks: cloned}, nil
}

func (sink *compositeExecutionSink) ApplyExecutionTx(
	ctx context.Context,
	tx pgx.Tx,
	operationID uuid.UUID,
	next State,
	errorCode string,
	requestID string,
	now time.Time,
) error {
	owners := 0
	for _, candidate := range sink.sinks {
		err := candidate.ApplyExecutionTx(ctx, tx, operationID, next, errorCode, requestID, now)
		switch {
		case err == nil:
			owners++
		case errors.Is(err, ErrExecutionTargetNotFound):
			continue
		default:
			return err
		}
	}
	if owners == 0 {
		return ErrExecutionTargetNotFound
	}
	if owners != 1 {
		return ErrStateConflict
	}
	return nil
}

var _ ExecutionSink = (*compositeExecutionSink)(nil)
