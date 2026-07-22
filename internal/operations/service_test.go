package operations

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"testing"

	"github.com/bignormal/aera-admin/internal/admin"
	"github.com/bignormal/aera-admin/internal/audit"
	"github.com/bignormal/aera-admin/internal/cloudadmin"
	"github.com/bignormal/aera-admin/internal/rbac"
	"github.com/bignormal/aera-admin/internal/testkit"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

type cloudStub struct {
	cloudadmin.DisabledClient
	health cloudadmin.Health
	err    error
}

func (stub cloudStub) Health(context.Context) (cloudadmin.Health, error) {
	return stub.health, stub.err
}

func TestEnqueueImmediateDoesNotWriteWhenCloudIsUnavailable(t *testing.T) {
	postgres := testkit.Postgres(t)
	service := newTestService(t, postgres, cloudStub{
		health: cloudadmin.Health{Availability: cloudadmin.Unavailable},
		err:    cloudadmin.ErrUnavailable,
	})
	request := validImmediateRequest(t, postgres, RevokeDevice, rbac.Support)
	if _, err := service.EnqueueImmediate(context.Background(), request); !errors.Is(err, ErrCloudUnavailable) {
		t.Fatalf("EnqueueImmediate() error = %v", err)
	}
	var count int
	if err := postgres.QueryRow(context.Background(), `SELECT count(*) FROM admin_outbox`).Scan(&count); err != nil || count != 0 {
		t.Fatalf("outbox count/error = %d/%v", count, err)
	}
}

func TestEnqueueImmediateQueuesSupportedOperationWhenCloudIsAvailable(t *testing.T) {
	postgres := testkit.Postgres(t)
	service := newTestService(t, postgres, cloudStub{health: cloudadmin.Health{Availability: cloudadmin.Available}})
	request := validImmediateRequest(t, postgres, RevokeSession, rbac.Operator)
	result, err := service.EnqueueImmediate(context.Background(), request)
	if err != nil {
		t.Fatal(err)
	}
	if result.OperationID == uuid.Nil || result.State != StateQueued {
		t.Fatalf("result = %+v", result)
	}
}

func TestEnqueueImmediateRejectsAccountLifecycleWithoutApproval(t *testing.T) {
	postgres := testkit.Postgres(t)
	service := newTestService(t, postgres, cloudStub{health: cloudadmin.Health{Availability: cloudadmin.Available}})
	request := validImmediateRequest(t, postgres, DisableUser, rbac.SuperAdmin)
	if _, err := service.EnqueueImmediate(context.Background(), request); !errors.Is(err, ErrInvalidRequest) {
		t.Fatalf("EnqueueImmediate() error = %v", err)
	}
}

func TestOfficialPayloadCanonicalizationIsStrictAndDeterministic(t *testing.T) {
	first, firstDigest, err := canonicalCommandPayload(OfficialSubmissionReview, json.RawMessage(`{
		"initial_channels":["stable","internal"],"decision":"approve"
	}`))
	if err != nil {
		t.Fatal(err)
	}
	second, secondDigest, err := canonicalCommandPayload(OfficialSubmissionReview, json.RawMessage(`{"decision":"approve","initial_channels":["internal","stable"]}`))
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(first, second) || firstDigest != secondDigest ||
		string(first) != `{"decision":"approve","initial_channels":["internal","stable"]}` {
		t.Fatalf("canonical review payloads = %s / %s", first, second)
	}
	for name, payload := range map[string]json.RawMessage{
		"unknown field":   json.RawMessage(`{"display_name":"Official","shadow":true}`),
		"duplicate field": json.RawMessage(`{"display_name":"Official","display_name":"Shadow"}`),
		"trailing value":  json.RawMessage(`{"display_name":"Official"}{}`),
	} {
		t.Run(name, func(t *testing.T) {
			if _, _, err := canonicalCommandPayload(OfficialDefinitionReserve, payload); !errors.Is(err, ErrInvalidRequest) {
				t.Fatalf("canonicalCommandPayload() error = %v", err)
			}
		})
	}
	legacy, legacyDigest, err := canonicalCommandPayload(RevokeDevice, nil)
	if err != nil || string(legacy) != `{}` || legacyDigest != sha256.Sum256([]byte(`{}`)) {
		t.Fatalf("legacy payload = %s, %x, %v", legacy, legacyDigest, err)
	}
	if _, _, err := canonicalCommandPayload(RevokeDevice, json.RawMessage(`{"unexpected":true}`)); !errors.Is(err, ErrInvalidRequest) {
		t.Fatalf("legacy non-empty payload error = %v", err)
	}
}

func TestEveryOfficialActionHasTypedCanonicalPayloadAndPermission(t *testing.T) {
	manifest, bundle := validOfficialPayloadFixture()
	definitionID, versionID, revisionID, requesterID := uuid.NewString(), uuid.NewString(), uuid.NewString(), uuid.NewString()
	encode := func(value any) json.RawMessage {
		encoded, err := json.Marshal(value)
		if err != nil {
			t.Fatal(err)
		}
		return encoded
	}
	tests := []struct {
		action     Action
		payload    json.RawMessage
		permission rbac.Permission
	}{
		{OfficialDefinitionReserve, encode(OfficialDefinitionReservePayload{DisplayName: "Official Research"}), rbac.ManageOfficialDrafts},
		{OfficialDraftCreate, encode(OfficialDraftCreatePayload{
			DefinitionID: definitionID, Kind: "initial", DisplayName: "Official Research", Manifest: manifest, Bundle: bundle,
		}), rbac.ManageOfficialDrafts},
		{OfficialDraftUpdate, encode(OfficialDraftUpdatePayload{
			BaseVersionID: versionID, Kind: "next", DisplayName: "Official Research v2", Manifest: manifest, Bundle: bundle,
		}), rbac.ManageOfficialDrafts},
		{OfficialDraftSubmit, json.RawMessage(`{}`), rbac.ManageOfficialDrafts},
		{OfficialSubmissionWithdraw, json.RawMessage(`{}`), rbac.ManageOfficialDrafts},
		{OfficialSubmissionReview, encode(OfficialSubmissionReviewPayload{
			Decision: "reject", ReviewReasonCode: "policy_mismatch", SafeNote: "Use the approved policy.",
		}), rbac.ReviewOfficialAgents},
		{OfficialReleaseActivate, encode(OfficialReleaseActivatePayload{
			VersionID: versionID, RolloutBasisPoints: 100, MinimumDesktopVersion: "v1.0.0", AllowlistedUserIDs: []string{},
		}), rbac.ManageOfficialReleases},
		{OfficialReleaseRollout, encode(OfficialReleaseRolloutPayload{
			RolloutBasisPoints: 500, MinimumDesktopVersion: "v1.0.0", AllowlistedUserIDs: []string{},
		}), rbac.ManageOfficialReleases},
		{OfficialReleasePause, json.RawMessage(`{}`), rbac.ManageOfficialReleases},
		{OfficialReleaseResume, json.RawMessage(`{}`), rbac.ManageOfficialReleases},
		{OfficialReleaseRollback, encode(OfficialReleaseRollbackPayload{
			TargetVersionID: versionID, TargetReleaseRevisionID: revisionID, RequesterAdminID: requesterID,
		}), rbac.ApproveOfficialRollback},
	}
	for _, test := range tests {
		t.Run(string(test.action), func(t *testing.T) {
			canonical, digest, err := canonicalCommandPayload(test.action, test.payload)
			if err != nil || len(canonical) < 2 || digest != sha256.Sum256(canonical) {
				t.Fatalf("canonical payload = %s/%x, error=%v", canonical, digest, err)
			}
			if !test.action.Valid() || permissionFor(test.action) != test.permission {
				t.Fatalf("action permission = %q", permissionFor(test.action))
			}
		})
	}
}

func validOfficialPayloadFixture() (OfficialAgentManifestPayload, OfficialAgentBundlePayload) {
	content := "# Approved knowledge"
	digest := sha256.Sum256([]byte(content))
	return OfficialAgentManifestPayload{
		SchemaVersion: 1,
		Identity:      OfficialAgentIdentityPayload{SystemPrompt: "You are an approved research assistant."},
		Assets: []OfficialAgentManifestAssetPayload{{
			Path: "knowledge/intro.md", Kind: "knowledge", MediaType: "text/markdown",
			SHA256: hex.EncodeToString(digest[:]),
		}},
		ModelConstraints: OfficialAgentModelConstraintsPayload{
			AllowedProviders: []string{"openai"}, AllowedModels: []string{"gpt-5"},
		},
		Tools:                OfficialAgentToolPolicyPayload{Allowed: []string{}, Denied: []string{}},
		Dependencies:         []OfficialAgentDependencyPayload{},
		RuntimeCompatibility: OfficialAgentRuntimeCompatibilityPayload{MinimumVersion: "v0.18.0"},
	}, OfficialAgentBundlePayload{Assets: []OfficialAgentBundleAssetPayload{{Path: "knowledge/intro.md", Content: content}}}
}

func newTestService(t *testing.T, postgres *pgxpool.Pool, cloud cloudadmin.Client) *Service {
	t.Helper()
	recorder, err := audit.NewService(postgres)
	if err != nil {
		t.Fatal(err)
	}
	service, err := NewService(ServiceConfig{
		PostgreSQL: postgres,
		HMACKey:    bytes.Repeat([]byte{9}, 32),
		Cloud:      cloud,
		Audit:      recorder,
		Clock:      fixedClock,
	})
	if err != nil {
		t.Fatal(err)
	}
	return service
}

func validImmediateRequest(t *testing.T, postgres *pgxpool.Pool, action Action, role rbac.Role) EnqueueRequest {
	t.Helper()
	actor := seedActor(t, postgres, role)
	return EnqueueRequest{
		Actor: actor, Action: action, TargetID: uuid.New(), ExpectedRevision: 1,
		BrowserIdempotencyKey: uuid.NewString(),
		Reason:                admin.ActionReason{Code: "suspected_compromise", Meta: actor.Meta},
	}
}
