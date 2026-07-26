package operations

import (
	"bytes"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"path"
	"regexp"
	"sort"
	"strings"
	"unicode/utf8"

	"github.com/google/uuid"
)

const maximumCommandPayloadBytes = 131072

var officialSemanticVersionPattern = regexp.MustCompile(
	`^(?:v)?(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-([0-9A-Za-z.-]+))?(?:\+([0-9A-Za-z.-]+))?$`,
)

type OfficialDefinitionReservePayload struct {
	DisplayName   string `json:"display_name"`
	IconMediaType string `json:"icon_media_type,omitempty"`
	IconData      string `json:"icon_data,omitempty"`
}

type OfficialDraftCreatePayload struct {
	DefinitionID  string                       `json:"definition_id"`
	BaseVersionID string                       `json:"base_version_id,omitempty"`
	Kind          string                       `json:"kind"`
	DisplayName   string                       `json:"display_name"`
	IconMediaType string                       `json:"icon_media_type,omitempty"`
	IconData      string                       `json:"icon_data,omitempty"`
	Manifest      OfficialAgentManifestPayload `json:"manifest"`
	Bundle        OfficialAgentBundlePayload   `json:"bundle"`
}

type OfficialDraftUpdatePayload struct {
	BaseVersionID string                       `json:"base_version_id,omitempty"`
	Kind          string                       `json:"kind"`
	DisplayName   string                       `json:"display_name"`
	IconMediaType string                       `json:"icon_media_type,omitempty"`
	IconData      string                       `json:"icon_data,omitempty"`
	Manifest      OfficialAgentManifestPayload `json:"manifest"`
	Bundle        OfficialAgentBundlePayload   `json:"bundle"`
}

type OfficialAgentManifestPayload struct {
	SchemaVersion        int                                      `json:"schema_version"`
	Identity             OfficialAgentIdentityPayload             `json:"identity"`
	Assets               []OfficialAgentManifestAssetPayload      `json:"assets"`
	ModelConstraints     OfficialAgentModelConstraintsPayload     `json:"model_constraints"`
	Tools                OfficialAgentToolPolicyPayload           `json:"tools"`
	Dependencies         []OfficialAgentDependencyPayload         `json:"dependencies"`
	RuntimeCompatibility OfficialAgentRuntimeCompatibilityPayload `json:"runtime_compatibility"`
}

type OfficialAgentIdentityPayload struct {
	SystemPrompt string `json:"system_prompt"`
}

type OfficialAgentManifestAssetPayload struct {
	Path      string `json:"path"`
	Kind      string `json:"kind"`
	MediaType string `json:"media_type"`
	SHA256    string `json:"sha256"`
}

type OfficialAgentModelConstraintsPayload struct {
	AllowedProviders []string `json:"allowed_providers"`
	AllowedModels    []string `json:"allowed_models"`
}

type OfficialAgentToolPolicyPayload struct {
	Allowed []string `json:"allowed"`
	Denied  []string `json:"denied"`
}

type OfficialAgentDependencyPayload struct {
	AgentDefinitionID string `json:"agent_definition_id"`
	AgentVersionID    string `json:"agent_version_id"`
}

type OfficialAgentRuntimeCompatibilityPayload struct {
	MinimumVersion          string `json:"minimum_version"`
	MaximumVersionExclusive string `json:"maximum_version_exclusive,omitempty"`
}

type OfficialAgentBundlePayload struct {
	Assets []OfficialAgentBundleAssetPayload `json:"assets"`
}

type OfficialAgentBundleAssetPayload struct {
	Path    string `json:"path"`
	Content string `json:"content"`
}

type OfficialSubmissionReviewPayload struct {
	Decision         string   `json:"decision"`
	ReviewReasonCode string   `json:"review_reason_code,omitempty"`
	SafeNote         string   `json:"safe_note,omitempty"`
	InitialChannels  []string `json:"initial_channels,omitempty"`
}

type OfficialReleaseActivatePayload struct {
	VersionID             string   `json:"version_id"`
	RolloutBasisPoints    int      `json:"rollout_basis_points"`
	MinimumDesktopVersion string   `json:"minimum_desktop_version"`
	AllowlistedUserIDs    []string `json:"allowlisted_user_ids,omitempty"`
}

type OfficialReleaseRolloutPayload struct {
	RolloutBasisPoints    int      `json:"rollout_basis_points"`
	MinimumDesktopVersion string   `json:"minimum_desktop_version"`
	AllowlistedUserIDs    []string `json:"allowlisted_user_ids,omitempty"`
}

type OfficialReleaseRollbackPayload struct {
	TargetVersionID         string `json:"target_version_id"`
	TargetReleaseRevisionID string `json:"target_release_revision_id"`
	RequesterAdminID        string `json:"requester_admin_id"`
}

func canonicalCommandPayload(action Action, input json.RawMessage) ([]byte, [sha256.Size]byte, error) {
	if len(input) == 0 {
		if action == RevokeDevice || action == RevokeSession || action == DisableUser || action == EnableUser || action == RevokeAllSessions || action == ForcePasswordReset {
			input = json.RawMessage(`{}`)
		} else {
			return nil, [sha256.Size]byte{}, ErrInvalidRequest
		}
	}
	if len(input) < 2 || len(input) > maximumCommandPayloadBytes || !utf8.Valid(input) || rejectDuplicateCommandKeys(input) != nil {
		return nil, [sha256.Size]byte{}, ErrInvalidRequest
	}

	var target any
	switch action {
	case RevokeDevice, RevokeSession, DisableUser, EnableUser, RevokeAllSessions, ForcePasswordReset,
		OfficialDraftSubmit, OfficialSubmissionWithdraw, OfficialReleasePause, OfficialReleaseResume:
		target = &struct{}{}
	case OfficialDefinitionReserve:
		target = &OfficialDefinitionReservePayload{}
	case OfficialDraftCreate:
		target = &OfficialDraftCreatePayload{}
	case OfficialDraftUpdate:
		target = &OfficialDraftUpdatePayload{}
	case OfficialSubmissionReview:
		target = &OfficialSubmissionReviewPayload{}
	case OfficialReleaseActivate:
		target = &OfficialReleaseActivatePayload{}
	case OfficialReleaseRollout:
		target = &OfficialReleaseRolloutPayload{}
	case OfficialReleaseRollback:
		target = &OfficialReleaseRollbackPayload{}
	default:
		return nil, [sha256.Size]byte{}, ErrInvalidRequest
	}
	if decodeStrictCommandJSON(input, target) != nil || validateAndCanonicalizeOfficialPayload(action, target) != nil {
		return nil, [sha256.Size]byte{}, ErrInvalidRequest
	}
	canonical, err := json.Marshal(target)
	if err != nil || len(canonical) < 2 || len(canonical) > maximumCommandPayloadBytes {
		return nil, [sha256.Size]byte{}, ErrInvalidRequest
	}
	return canonical, sha256.Sum256(canonical), nil
}

func validateAndCanonicalizeOfficialPayload(action Action, target any) error {
	switch action {
	case RevokeDevice, RevokeSession, DisableUser, EnableUser, RevokeAllSessions, ForcePasswordReset,
		OfficialDraftSubmit, OfficialSubmissionWithdraw, OfficialReleasePause, OfficialReleaseResume:
		return nil
	case OfficialDefinitionReserve:
		payload := target.(*OfficialDefinitionReservePayload)
		return validateOfficialPresentation(payload.DisplayName, payload.IconMediaType, payload.IconData)
	case OfficialDraftCreate:
		payload := target.(*OfficialDraftCreatePayload)
		if !canonicalUUID(payload.DefinitionID) {
			return ErrInvalidRequest
		}
		return validateOfficialDraftPayload(
			payload.Kind, payload.BaseVersionID, payload.DisplayName, payload.IconMediaType, payload.IconData,
			&payload.Manifest, &payload.Bundle,
		)
	case OfficialDraftUpdate:
		payload := target.(*OfficialDraftUpdatePayload)
		return validateOfficialDraftPayload(
			payload.Kind, payload.BaseVersionID, payload.DisplayName, payload.IconMediaType, payload.IconData,
			&payload.Manifest, &payload.Bundle,
		)
	case OfficialSubmissionReview:
		return validateOfficialReviewPayload(target.(*OfficialSubmissionReviewPayload))
	case OfficialReleaseActivate:
		payload := target.(*OfficialReleaseActivatePayload)
		if !canonicalUUID(payload.VersionID) {
			return ErrInvalidRequest
		}
		return validateOfficialRolloutPayload(
			payload.RolloutBasisPoints, payload.MinimumDesktopVersion, &payload.AllowlistedUserIDs,
		)
	case OfficialReleaseRollout:
		payload := target.(*OfficialReleaseRolloutPayload)
		return validateOfficialRolloutPayload(
			payload.RolloutBasisPoints, payload.MinimumDesktopVersion, &payload.AllowlistedUserIDs,
		)
	case OfficialReleaseRollback:
		payload := target.(*OfficialReleaseRollbackPayload)
		if !canonicalUUID(payload.TargetVersionID) || !canonicalUUID(payload.TargetReleaseRevisionID) ||
			!canonicalUUID(payload.RequesterAdminID) {
			return ErrInvalidRequest
		}
		return nil
	default:
		return ErrInvalidRequest
	}
}

func validateOfficialPresentation(displayName, iconMediaType, iconData string) error {
	if !validOfficialText(displayName, 1, 100) || strings.TrimSpace(displayName) != displayName ||
		(iconMediaType == "") != (iconData == "") {
		return ErrInvalidRequest
	}
	if iconMediaType == "" {
		return nil
	}
	if iconMediaType != "image/png" && iconMediaType != "image/webp" {
		return ErrInvalidRequest
	}
	decoded, err := base64.StdEncoding.DecodeString(iconData)
	if err != nil || len(decoded) == 0 || len(decoded) > 524288 {
		return ErrInvalidRequest
	}
	return nil
}

func validateOfficialDraftPayload(
	kind, baseVersionID, displayName, iconMediaType, iconData string,
	manifest *OfficialAgentManifestPayload,
	bundle *OfficialAgentBundlePayload,
) error {
	if (kind == "initial" && baseVersionID != "") ||
		(kind == "next" && !canonicalUUID(baseVersionID)) ||
		(kind != "initial" && kind != "next") ||
		validateOfficialPresentation(displayName, iconMediaType, iconData) != nil {
		return ErrInvalidRequest
	}
	return canonicalizeOfficialManifestBundle(manifest, bundle)
}

func canonicalizeOfficialManifestBundle(manifest *OfficialAgentManifestPayload, bundle *OfficialAgentBundlePayload) error {
	if manifest == nil || bundle == nil || manifest.SchemaVersion != 1 ||
		!validOfficialText(manifest.Identity.SystemPrompt, 1, 262144) ||
		manifest.Assets == nil || len(manifest.Assets) > 128 ||
		manifest.Dependencies == nil || len(manifest.Dependencies) > 128 ||
		bundle.Assets == nil || len(bundle.Assets) > 128 {
		return ErrInvalidRequest
	}
	bundleByPath := make(map[string]string, len(bundle.Assets))
	for index := range bundle.Assets {
		asset := &bundle.Assets[index]
		if !validOfficialAssetPath(asset.Path) || !utf8.ValidString(asset.Content) || len([]byte(asset.Content)) > 262144 {
			return ErrInvalidRequest
		}
		if _, duplicate := bundleByPath[asset.Path]; duplicate {
			return ErrInvalidRequest
		}
		bundleByPath[asset.Path] = asset.Content
	}
	seenManifestPath := make(map[string]struct{}, len(manifest.Assets))
	for index := range manifest.Assets {
		asset := &manifest.Assets[index]
		if !validOfficialAssetPath(asset.Path) ||
			(asset.Kind != "skill" && asset.Kind != "sop" && asset.Kind != "knowledge") ||
			(asset.MediaType != "text/markdown" && asset.MediaType != "text/plain") ||
			len(asset.SHA256) != 64 || strings.ToLower(asset.SHA256) != asset.SHA256 {
			return ErrInvalidRequest
		}
		if _, err := hex.DecodeString(asset.SHA256); err != nil {
			return ErrInvalidRequest
		}
		if _, duplicate := seenManifestPath[asset.Path]; duplicate {
			return ErrInvalidRequest
		}
		content, exists := bundleByPath[asset.Path]
		contentDigest := sha256.Sum256([]byte(content))
		if !exists || hex.EncodeToString(contentDigest[:]) != asset.SHA256 {
			return ErrInvalidRequest
		}
		seenManifestPath[asset.Path] = struct{}{}
	}
	if len(seenManifestPath) != len(bundleByPath) {
		return ErrInvalidRequest
	}
	if canonicalizeOfficialStringSet(&manifest.ModelConstraints.AllowedProviders, 1, 128) != nil ||
		canonicalizeOfficialStringSet(&manifest.ModelConstraints.AllowedModels, 1, 256) != nil ||
		canonicalizeOfficialStringSet(&manifest.Tools.Allowed, 0, 256) != nil ||
		canonicalizeOfficialStringSet(&manifest.Tools.Denied, 0, 256) != nil {
		return ErrInvalidRequest
	}
	allowedTools := make(map[string]struct{}, len(manifest.Tools.Allowed))
	for _, tool := range manifest.Tools.Allowed {
		allowedTools[tool] = struct{}{}
	}
	for _, tool := range manifest.Tools.Denied {
		if _, conflict := allowedTools[tool]; conflict {
			return ErrInvalidRequest
		}
	}
	seenDependencies := make(map[string]struct{}, len(manifest.Dependencies))
	for _, dependency := range manifest.Dependencies {
		if !canonicalUUID(dependency.AgentDefinitionID) || !canonicalUUID(dependency.AgentVersionID) {
			return ErrInvalidRequest
		}
		key := dependency.AgentDefinitionID + "\x00" + dependency.AgentVersionID
		if _, duplicate := seenDependencies[key]; duplicate {
			return ErrInvalidRequest
		}
		seenDependencies[key] = struct{}{}
	}
	if !officialSemanticVersionPattern.MatchString(manifest.RuntimeCompatibility.MinimumVersion) ||
		(manifest.RuntimeCompatibility.MaximumVersionExclusive != "" &&
			!officialSemanticVersionPattern.MatchString(manifest.RuntimeCompatibility.MaximumVersionExclusive)) {
		return ErrInvalidRequest
	}
	sort.Slice(manifest.Assets, func(left, right int) bool { return manifest.Assets[left].Path < manifest.Assets[right].Path })
	sort.Slice(bundle.Assets, func(left, right int) bool { return bundle.Assets[left].Path < bundle.Assets[right].Path })
	sort.Slice(manifest.Dependencies, func(left, right int) bool {
		if manifest.Dependencies[left].AgentDefinitionID == manifest.Dependencies[right].AgentDefinitionID {
			return manifest.Dependencies[left].AgentVersionID < manifest.Dependencies[right].AgentVersionID
		}
		return manifest.Dependencies[left].AgentDefinitionID < manifest.Dependencies[right].AgentDefinitionID
	})
	return nil
}

func validateOfficialReviewPayload(payload *OfficialSubmissionReviewPayload) error {
	if payload == nil {
		return ErrInvalidRequest
	}
	switch payload.Decision {
	case "approve":
		if payload.ReviewReasonCode != "" || payload.SafeNote != "" ||
			len(payload.InitialChannels) < 1 || len(payload.InitialChannels) > 2 {
			return ErrInvalidRequest
		}
		seen := make(map[string]struct{}, len(payload.InitialChannels))
		for _, channel := range payload.InitialChannels {
			if channel != "internal" && channel != "stable" {
				return ErrInvalidRequest
			}
			if _, duplicate := seen[channel]; duplicate {
				return ErrInvalidRequest
			}
			seen[channel] = struct{}{}
		}
		sort.Strings(payload.InitialChannels)
	case "reject":
		if !reasonCodePattern.MatchString(payload.ReviewReasonCode) || len(payload.InitialChannels) != 0 ||
			!validOfficialText(payload.SafeNote, 0, 500) {
			return ErrInvalidRequest
		}
	default:
		return ErrInvalidRequest
	}
	return nil
}

func validateOfficialRolloutPayload(basisPoints int, minimumVersion string, allowlist *[]string) error {
	if basisPoints < 0 || basisPoints > 10000 || !officialSemanticVersionPattern.MatchString(minimumVersion) ||
		allowlist == nil || len(*allowlist) > 10000 {
		return ErrInvalidRequest
	}
	seen := make(map[string]struct{}, len(*allowlist))
	for _, userID := range *allowlist {
		if !canonicalUUID(userID) {
			return ErrInvalidRequest
		}
		if _, duplicate := seen[userID]; duplicate {
			return ErrInvalidRequest
		}
		seen[userID] = struct{}{}
	}
	sort.Strings(*allowlist)
	return nil
}

func canonicalizeOfficialStringSet(values *[]string, minimum int, maximumLength int) error {
	if values == nil || *values == nil || len(*values) < minimum {
		return ErrInvalidRequest
	}
	seen := make(map[string]struct{}, len(*values))
	for _, value := range *values {
		if !validOfficialText(value, 1, maximumLength) || strings.TrimSpace(value) != value || strings.Contains(value, "://") {
			return ErrInvalidRequest
		}
		if _, duplicate := seen[value]; duplicate {
			return ErrInvalidRequest
		}
		seen[value] = struct{}{}
	}
	sort.Strings(*values)
	return nil
}

func canonicalUUID(value string) bool {
	parsed, err := uuid.Parse(value)
	return err == nil && parsed != uuid.Nil && parsed.String() == value
}

func validOfficialText(value string, minimum, maximum int) bool {
	if !utf8.ValidString(value) {
		return false
	}
	length := utf8.RuneCountInString(value)
	return length >= minimum && length <= maximum && !strings.ContainsRune(value, '\x00')
}

func validOfficialAssetPath(value string) bool {
	if !validOfficialText(value, 1, 512) || strings.TrimSpace(value) != value || strings.Contains(value, `\`) ||
		strings.Contains(value, "://") || strings.HasPrefix(value, "/") || path.Clean(value) != value ||
		value == "." || strings.HasPrefix(value, "../") {
		return false
	}
	for _, segment := range strings.Split(strings.ToLower(value), "/") {
		switch segment {
		case ".env", "auth.json", "memory.md", "user.md", "credentials", "sessions", "curator", "archives":
			return false
		}
	}
	return true
}

func decodeStrictCommandJSON(raw []byte, target any) error {
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(target); err != nil {
		return err
	}
	if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		return ErrInvalidRequest
	}
	return nil
}

func rejectDuplicateCommandKeys(raw []byte) error {
	decoder := json.NewDecoder(bytes.NewReader(raw))
	if err := scanUniqueCommandJSONValue(decoder); err != nil {
		return err
	}
	if _, err := decoder.Token(); !errors.Is(err, io.EOF) {
		return ErrInvalidRequest
	}
	return nil
}

func scanUniqueCommandJSONValue(decoder *json.Decoder) error {
	token, err := decoder.Token()
	if err != nil {
		return err
	}
	delimiter, compound := token.(json.Delim)
	if !compound {
		return nil
	}
	switch delimiter {
	case '{':
		keys := make(map[string]struct{})
		for decoder.More() {
			keyToken, err := decoder.Token()
			if err != nil {
				return err
			}
			key, ok := keyToken.(string)
			if !ok {
				return ErrInvalidRequest
			}
			if _, duplicate := keys[key]; duplicate {
				return ErrInvalidRequest
			}
			keys[key] = struct{}{}
			if err := scanUniqueCommandJSONValue(decoder); err != nil {
				return err
			}
		}
		closing, err := decoder.Token()
		if err != nil || closing != json.Delim('}') {
			return ErrInvalidRequest
		}
	case '[':
		for decoder.More() {
			if err := scanUniqueCommandJSONValue(decoder); err != nil {
				return err
			}
		}
		closing, err := decoder.Token()
		if err != nil || closing != json.Delim(']') {
			return ErrInvalidRequest
		}
	default:
		return ErrInvalidRequest
	}
	return nil
}
