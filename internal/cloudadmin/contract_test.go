package cloudadmin

import (
	"errors"
	"testing"
	"time"

	"github.com/google/uuid"
)

func TestValidateUserAcceptsOnlyMaskedIdentity(t *testing.T) {
	valid := User{
		ID:                     uuid.New(),
		MaskedEmail:            "a***@example.test",
		Status:                 UserActive,
		AdministrativeRevision: 7,
		CreatedAt:              time.Now().UTC(),
	}
	if err := valid.Validate(); err != nil {
		t.Fatalf("valid user rejected: %v", err)
	}
	for _, identity := range []string{"alice@example.test", "a**@example.test", "a***@", ""} {
		candidate := valid
		candidate.MaskedEmail = identity
		if identity == "" {
			candidate.MaskedPhone = "138****1234"
		}
		if identity != "" {
			if err := candidate.Validate(); err == nil {
				t.Fatalf("unmasked or malformed identity %q accepted", identity)
			}
		} else if err := candidate.Validate(); err != nil {
			t.Fatalf("masked phone rejected: %v", err)
		}
	}
}

func TestValidateUserRejectsSensitiveOrUnknownState(t *testing.T) {
	user := User{
		ID:                     uuid.New(),
		MaskedEmail:            "a***@example.test",
		Status:                 UserStatus("owner@example.test"),
		AdministrativeRevision: 1,
		CreatedAt:              time.Now().UTC(),
	}
	if err := user.Validate(); !errors.Is(err, ErrContractViolation) {
		t.Fatalf("Validate() error = %v", err)
	}
}

func TestValidateDeviceRejectsIdentityLikeLabels(t *testing.T) {
	device := Device{
		ID: uuid.New(), UserID: uuid.New(), DisplayName: "alice@example.test",
		Platform: "macos", ClientVersion: "1.0.0", Status: DeviceActive,
	}
	if err := device.Validate(); !errors.Is(err, ErrContractViolation) {
		t.Fatalf("Validate() error = %v", err)
	}
}
