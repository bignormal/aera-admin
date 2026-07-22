package cloudadmin

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/bignormal/aera-admin/internal/rbac"
	"github.com/google/uuid"
)

func TestOfficialCommandPayloadRejectsUnsafeSemanticValues(t *testing.T) {
	manifest, bundle := validOfficialPackageFixture()
	definitionID := uuid.MustParse("019f0000-0000-7000-8000-000000000301")
	versionID := uuid.MustParse("019f0000-0000-7000-8000-000000000302")

	invalidKind, err := json.Marshal(struct {
		DefinitionID uuid.UUID        `json:"definition_id"`
		Kind         string           `json:"kind"`
		DisplayName  string           `json:"display_name"`
		Manifest     OfficialManifest `json:"manifest"`
		Bundle       OfficialBundle   `json:"bundle"`
	}{definitionID, "unexpected", "Official Research", manifest, bundle})
	if err != nil {
		t.Fatal(err)
	}

	cases := []struct {
		name    string
		action  OfficialAction
		payload json.RawMessage
	}{
		{"invalid draft kind", OfficialDraftCreate, invalidKind},
		{"noncanonical UUID", OfficialReleaseActivate, json.RawMessage(`{"version_id":"019F0000-0000-7000-8000-000000000302","rollout_basis_points":100,"minimum_desktop_version":"v0.18.0","allowlisted_user_ids":[]}`)},
		{"rollout over 100 percent", OfficialReleaseActivate, json.RawMessage(`{"version_id":"` + versionID.String() + `","rollout_basis_points":10001,"minimum_desktop_version":"v0.18.0","allowlisted_user_ids":[]}`)},
		{"duplicate allowlist", OfficialReleaseRollout, json.RawMessage(`{"rollout_basis_points":100,"minimum_desktop_version":"v0.18.0","allowlisted_user_ids":["019f0000-0000-7000-8000-000000000303","019f0000-0000-7000-8000-000000000303"]}`)},
	}
	for _, test := range cases {
		t.Run(test.name, func(t *testing.T) {
			if err := validateOfficialCommandPayload(test.action, test.payload); err == nil {
				t.Fatal("unsafe official payload was accepted")
			}
		})
	}
}

func TestOfficialPackageRejectsDigestPathAndPolicyInconsistency(t *testing.T) {
	manifest, bundle := validOfficialPackageFixture()
	manifest.ModelConstraints.AllowedProviders = []string{"openai", "openai"}
	if err := validateOfficialPackage(manifest, bundle); err == nil {
		t.Fatal("duplicate provider was accepted")
	}

	manifest, bundle = validOfficialPackageFixture()
	manifest.Assets[0].Path = "../memory.md"
	if err := validateOfficialPackage(manifest, bundle); err == nil {
		t.Fatal("unsafe asset path was accepted")
	}

	manifest, bundle = validOfficialPackageFixture()
	manifest.Assets[0].SHA256 = strings.Repeat("0", 64)
	if err := validateOfficialPackage(manifest, bundle); err == nil {
		t.Fatal("bundle digest mismatch was accepted")
	}
}

func TestOfficialResponseStateBindsRoleAndLifecycle(t *testing.T) {
	release := validOfficialReleaseFixture()
	release.ActorAdminRole = rbac.Finance
	if err := validateOfficialRelease(release); err == nil {
		t.Fatal("Finance actor was accepted for a release mutation")
	}

	manifest, bundle := validOfficialPackageFixture()
	submission := OfficialSubmission{
		ID: uuid.New(), PlatformID: uuid.New(), DraftID: uuid.New(), DraftRevision: 1,
		DefinitionID: uuid.New(), Kind: "initial", DisplayName: "Official Research",
		Manifest: manifest, Bundle: bundle, ManifestDigest: strings.Repeat("1", 64),
		BundleDigest: strings.Repeat("2", 64), ContentDigest: strings.Repeat("3", 64),
		SubmittedByAdminID: uuid.New(), SubmittedByRole: rbac.Developer, Status: "pending", Revision: 1,
		SubmittedAt: time.Date(2026, 7, 22, 8, 0, 0, 0, time.UTC),
		UpdatedAt:   time.Date(2026, 7, 22, 8, 0, 0, 0, time.UTC),
		Review: &OfficialReview{
			ID: uuid.New(), ReviewerAdminID: uuid.New(), ReviewerRole: rbac.SuperAdmin,
			Decision: "approve", PlatformPolicySnapshotID: uuid.New(), PlatformPolicyVersion: 1,
			ReviewedContentDigest: strings.Repeat("3", 64), ReviewedAt: time.Date(2026, 7, 22, 8, 1, 0, 0, time.UTC),
		},
	}
	if err := validateOfficialSubmission(submission); err == nil {
		t.Fatal("pending submission with a terminal review was accepted")
	}
}

func TestOfficialRemoteStatusMappingPreservesSafeDomainFailures(t *testing.T) {
	cases := []struct {
		status int
		want   error
	}{
		{http.StatusBadRequest, ErrContractViolation},
		{http.StatusUnauthorized, ErrUnavailable},
		{http.StatusForbidden, ErrPermissionDenied},
		{http.StatusNotFound, ErrNotFound},
		{http.StatusConflict, ErrConflict},
		{http.StatusUnprocessableEntity, ErrPublicationDLPBlocked},
		{http.StatusInternalServerError, ErrUnavailable},
	}
	for _, test := range cases {
		if got := mapRemoteStatus(test.status); !errors.Is(got, test.want) {
			t.Errorf("mapRemoteStatus(%d) = %v, want %v", test.status, got, test.want)
		}
	}
}

func validOfficialPackageFixture() (OfficialManifest, OfficialBundle) {
	content := "approved public knowledge"
	digest := sha256.Sum256([]byte(content))
	return OfficialManifest{
		SchemaVersion: 1,
		Identity:      OfficialManifestIdentity{SystemPrompt: "You are an approved research assistant."},
		Assets: []OfficialManifestAsset{{
			Path: "knowledge/intro.md", Kind: "knowledge", MediaType: "text/markdown",
			SHA256: hex.EncodeToString(digest[:]),
		}},
		ModelConstraints: OfficialModelConstraints{AllowedProviders: []string{"openai"}, AllowedModels: []string{"gpt-5"}},
		Tools:            OfficialToolPolicy{Allowed: []string{}, Denied: []string{}},
		Dependencies:     []OfficialManifestDependency{},
		RuntimeCompatibility: OfficialRuntimeCompatibility{
			MinimumVersion: "v0.18.0",
		},
	}, OfficialBundle{Assets: []OfficialBundleAsset{{Path: "knowledge/intro.md", Content: content}}}
}

func validOfficialReleaseFixture() OfficialRelease {
	now := time.Date(2026, 7, 22, 8, 0, 0, 0, time.UTC)
	return OfficialRelease{
		ID: uuid.New(), PlatformID: uuid.New(), DefinitionID: uuid.New(), Channel: "stable",
		CurrentRevisionID: uuid.New(), HeadRevision: 2, AgentVersionID: uuid.New(), State: "active",
		RolloutBasisPoints: 1000, MinimumDesktopVersion: "v0.18.0", Action: "rollout_update",
		ActorAdminID: uuid.New(), ActorAdminRole: rbac.Operator, ReasonCode: "rollout_update",
		AudienceCount: 0, CreatedAt: now, UpdatedAt: now,
	}
}
