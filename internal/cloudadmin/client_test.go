package cloudadmin

import (
	"context"
	"errors"
	"testing"

	"github.com/google/uuid"
)

func TestDisabledClientFailsEveryCloudCapabilityClosed(t *testing.T) {
	client := DisabledClient{}
	if health, err := client.Health(context.Background()); !errors.Is(err, ErrNotConfigured) || health.Availability != NotConfigured {
		t.Fatalf("Health() = %+v, %v", health, err)
	}
	if _, err := client.GetUser(context.Background(), uuid.New()); !errors.Is(err, ErrNotConfigured) {
		t.Fatalf("GetUser() error = %v", err)
	}
	if _, err := client.RevokeSession(context.Background(), uuid.New(), CommandMeta{}); !errors.Is(err, ErrNotConfigured) {
		t.Fatalf("RevokeSession() error = %v", err)
	}
}

var _ Client = DisabledClient{}
