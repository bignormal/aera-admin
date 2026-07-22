package cloudadmin

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/url"
	"path"
	"regexp"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/bignormal/aera-admin/internal/rbac"
	"github.com/google/uuid"
)

var (
	officialReasonCodePattern = regexp.MustCompile(`^[a-z][a-z0-9_]{2,63}$`)
	officialDigestPattern     = regexp.MustCompile(`^[0-9a-f]{64}$`)
	officialSemverPattern     = regexp.MustCompile(`^(?:v)?(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-([0-9A-Za-z.-]+))?(?:\+([0-9A-Za-z.-]+))?$`)
)

type OfficialAgentClient interface {
	ListOfficialDefinitions(context.Context, ActorContext, PageRequest) (Page[OfficialDefinition], error)
	GetOfficialDefinition(context.Context, ActorContext, uuid.UUID) (OfficialDefinitionDetail, error)
	ListOfficialDrafts(context.Context, ActorContext, PageRequest) (Page[OfficialDraft], error)
	GetOfficialDraft(context.Context, ActorContext, uuid.UUID) (OfficialDraft, error)
	ValidateOfficialDraft(context.Context, ActorContext, uuid.UUID) (OfficialDraftValidation, error)
	ListOfficialSubmissions(context.Context, ActorContext, OfficialSubmissionFilter) (Page[OfficialSubmission], error)
	GetOfficialSubmission(context.Context, ActorContext, uuid.UUID) (OfficialSubmission, error)
	ListOfficialVersions(context.Context, ActorContext, PageRequest) (Page[OfficialVersion], error)
	GetOfficialVersion(context.Context, ActorContext, uuid.UUID) (OfficialVersion, error)
	ListOfficialReleases(context.Context, ActorContext, PageRequest) (Page[OfficialRelease], error)
	GetOfficialRelease(context.Context, ActorContext, uuid.UUID) (OfficialReleaseDetail, error)
	ListOfficialAudit(context.Context, ActorContext, PageRequest) (Page[OfficialAuditEvent], error)
	ExecuteOfficialCommand(context.Context, ActorContext, OfficialCommand) (Operation, error)
}

type OfficialAction string

const (
	OfficialDefinitionReserve  OfficialAction = "official_definition_reserve"
	OfficialDraftCreate        OfficialAction = "official_draft_create"
	OfficialDraftUpdate        OfficialAction = "official_draft_update"
	OfficialDraftSubmit        OfficialAction = "official_draft_submit"
	OfficialSubmissionWithdraw OfficialAction = "official_submission_withdraw"
	OfficialSubmissionReview   OfficialAction = "official_submission_review"
	OfficialReleaseActivate    OfficialAction = "official_release_activate"
	OfficialReleaseRollout     OfficialAction = "official_release_rollout"
	OfficialReleasePause       OfficialAction = "official_release_pause"
	OfficialReleaseResume      OfficialAction = "official_release_resume"
	OfficialReleaseRollback    OfficialAction = "official_release_rollback"
)

type OfficialCommand struct {
	Action           OfficialAction
	TargetID         uuid.UUID
	ExpectedRevision int64
	ReasonCode       string
	TicketReference  string
	Payload          json.RawMessage
}

type OfficialDefinition struct {
	ID               uuid.UUID  `json:"definition_id"`
	PlatformID       uuid.UUID  `json:"platform_id"`
	DisplayName      string     `json:"display_name"`
	IconMediaType    string     `json:"icon_media_type,omitempty"`
	IconData         []byte     `json:"icon_data,omitempty"`
	Status           string     `json:"status"`
	LatestVersionID  *uuid.UUID `json:"latest_version_id,omitempty"`
	CreatedByAdminID uuid.UUID  `json:"created_by_admin_id"`
	CreatedAt        time.Time  `json:"created_at"`
	UpdatedAt        time.Time  `json:"updated_at"`
	Replayed         bool       `json:"replayed,omitempty"`
}

type OfficialDefinitionDetail = OfficialDefinition

type OfficialManifest struct {
	SchemaVersion        int                          `json:"schema_version"`
	Identity             OfficialManifestIdentity     `json:"identity"`
	Assets               []OfficialManifestAsset      `json:"assets"`
	ModelConstraints     OfficialModelConstraints     `json:"model_constraints"`
	Tools                OfficialToolPolicy           `json:"tools"`
	Dependencies         []OfficialManifestDependency `json:"dependencies"`
	RuntimeCompatibility OfficialRuntimeCompatibility `json:"runtime_compatibility"`
}

type OfficialManifestIdentity struct {
	SystemPrompt string `json:"system_prompt"`
}

type OfficialManifestAsset struct {
	Path      string `json:"path"`
	Kind      string `json:"kind"`
	MediaType string `json:"media_type"`
	SHA256    string `json:"sha256"`
}

type OfficialModelConstraints struct {
	AllowedProviders []string `json:"allowed_providers"`
	AllowedModels    []string `json:"allowed_models"`
}

type OfficialToolPolicy struct {
	Allowed []string `json:"allowed"`
	Denied  []string `json:"denied"`
}

type OfficialManifestDependency struct {
	DefinitionID uuid.UUID `json:"agent_definition_id"`
	VersionID    uuid.UUID `json:"agent_version_id"`
}

type OfficialRuntimeCompatibility struct {
	MinimumVersion          string `json:"minimum_version"`
	MaximumVersionExclusive string `json:"maximum_version_exclusive,omitempty"`
}

type OfficialBundle struct {
	Assets []OfficialBundleAsset `json:"assets"`
}

type OfficialBundleAsset struct {
	Path    string `json:"path"`
	Content string `json:"content"`
}

type OfficialDraft struct {
	ID                uuid.UUID        `json:"draft_id"`
	PlatformID        uuid.UUID        `json:"platform_id"`
	DefinitionID      uuid.UUID        `json:"definition_id"`
	BaseVersionID     *uuid.UUID       `json:"base_version_id,omitempty"`
	Kind              string           `json:"kind"`
	DisplayName       string           `json:"display_name"`
	IconMediaType     string           `json:"icon_media_type,omitempty"`
	IconData          []byte           `json:"icon_data,omitempty"`
	Manifest          OfficialManifest `json:"manifest"`
	Bundle            OfficialBundle   `json:"bundle"`
	ManifestDigest    string           `json:"manifest_digest"`
	BundleDigest      string           `json:"bundle_digest"`
	ContentDigest     string           `json:"content_digest"`
	Revision          int64            `json:"revision"`
	Status            string           `json:"status"`
	LastEditorAdminID uuid.UUID        `json:"last_editor_admin_id"`
	LastEditorRole    rbac.Role        `json:"last_editor_role"`
	CreatedAt         time.Time        `json:"created_at"`
	UpdatedAt         time.Time        `json:"updated_at"`
	Replayed          bool             `json:"replayed,omitempty"`
}

type OfficialDraftValidation struct {
	DraftID       uuid.UUID                   `json:"draft_id"`
	DraftRevision int64                       `json:"draft_revision"`
	ContentDigest string                      `json:"content_digest"`
	DLPVersion    string                      `json:"dlp_version"`
	Valid         bool                        `json:"valid"`
	Findings      []OfficialValidationFinding `json:"findings"`
}

type OfficialValidationFinding struct {
	Code string `json:"code"`
	Path string `json:"path"`
	Line int    `json:"line,omitempty"`
}

type OfficialReview struct {
	ID                       uuid.UUID `json:"review_id"`
	ReviewerAdminID          uuid.UUID `json:"reviewer_admin_id"`
	ReviewerRole             rbac.Role `json:"reviewer_role"`
	Decision                 string    `json:"decision"`
	ReasonCode               string    `json:"reason_code,omitempty"`
	SafeNote                 string    `json:"safe_note,omitempty"`
	PlatformPolicySnapshotID uuid.UUID `json:"platform_policy_snapshot_id"`
	PlatformPolicyVersion    int64     `json:"platform_policy_version"`
	ReviewedContentDigest    string    `json:"reviewed_content_digest"`
	ReviewedAt               time.Time `json:"reviewed_at"`
}

type OfficialSubmission struct {
	ID                 uuid.UUID        `json:"submission_id"`
	PlatformID         uuid.UUID        `json:"platform_id"`
	DraftID            uuid.UUID        `json:"draft_id"`
	DraftRevision      int64            `json:"draft_revision"`
	DefinitionID       uuid.UUID        `json:"definition_id"`
	BaseVersionID      *uuid.UUID       `json:"base_version_id,omitempty"`
	Kind               string           `json:"kind"`
	DisplayName        string           `json:"display_name"`
	IconMediaType      string           `json:"icon_media_type,omitempty"`
	IconData           []byte           `json:"icon_data,omitempty"`
	Manifest           OfficialManifest `json:"manifest"`
	Bundle             OfficialBundle   `json:"bundle"`
	ManifestDigest     string           `json:"manifest_digest"`
	BundleDigest       string           `json:"bundle_digest"`
	ContentDigest      string           `json:"content_digest"`
	SubmittedByAdminID uuid.UUID        `json:"submitted_by_admin_id"`
	SubmittedByRole    rbac.Role        `json:"submitted_by_role"`
	Status             string           `json:"status"`
	Revision           int64            `json:"revision"`
	SubmittedAt        time.Time        `json:"submitted_at"`
	TerminalAt         *time.Time       `json:"terminal_at,omitempty"`
	UpdatedAt          time.Time        `json:"updated_at"`
	Review             *OfficialReview  `json:"review,omitempty"`
	Replayed           bool             `json:"replayed,omitempty"`
}

type OfficialSubmissionFilter struct {
	PageRequest
	Status string
}

type OfficialVersion struct {
	ID                             uuid.UUID        `json:"version_id"`
	DefinitionID                   uuid.UUID        `json:"definition_id"`
	VersionNumber                  int64            `json:"version_number"`
	Manifest                       OfficialManifest `json:"manifest"`
	Bundle                         OfficialBundle   `json:"bundle"`
	ContentDigest                  string           `json:"content_digest"`
	RuntimeMinimumVersion          string           `json:"runtime_minimum_version"`
	RuntimeMaximumVersionExclusive string           `json:"runtime_maximum_version_exclusive,omitempty"`
	PublishedAt                    time.Time        `json:"published_at"`
}

type OfficialRelease struct {
	ID                       uuid.UUID  `json:"release_id"`
	PlatformID               uuid.UUID  `json:"platform_id"`
	DefinitionID             uuid.UUID  `json:"definition_id"`
	Channel                  string     `json:"channel"`
	CurrentRevisionID        uuid.UUID  `json:"current_revision_id"`
	HeadRevision             int64      `json:"head_revision"`
	AgentVersionID           uuid.UUID  `json:"agent_version_id"`
	State                    string     `json:"state"`
	RolloutBasisPoints       int        `json:"rollout_basis_points"`
	MinimumDesktopVersion    string     `json:"minimum_desktop_version"`
	Action                   string     `json:"action"`
	PreviousRevisionID       *uuid.UUID `json:"previous_revision_id,omitempty"`
	RollbackTargetRevisionID *uuid.UUID `json:"rollback_target_revision_id,omitempty"`
	ActorAdminID             uuid.UUID  `json:"actor_admin_id"`
	ActorAdminRole           rbac.Role  `json:"actor_admin_role"`
	ReasonCode               string     `json:"reason_code"`
	TicketReference          string     `json:"ticket_reference,omitempty"`
	AudienceCount            int        `json:"audience_count"`
	CreatedAt                time.Time  `json:"created_at"`
	UpdatedAt                time.Time  `json:"updated_at"`
	Replayed                 bool       `json:"replayed,omitempty"`
}

type OfficialReleaseDetail = OfficialRelease

type OfficialAuditEvent struct {
	ID             uuid.UUID `json:"event_id"`
	EventType      string    `json:"event_type"`
	ObjectType     string    `json:"object_type"`
	ObjectID       uuid.UUID `json:"object_id"`
	Outcome        string    `json:"outcome"`
	ReasonCode     string    `json:"reason_code,omitempty"`
	RequestID      string    `json:"request_id"`
	ActorAdminID   uuid.UUID `json:"actor_admin_id"`
	ActorAdminRole rbac.Role `json:"actor_admin_role"`
	CreatedAt      time.Time `json:"created_at"`
}

type officialMutationEnvelope struct {
	OperationID      uuid.UUID       `json:"operation_id"`
	ActorAdminID     uuid.UUID       `json:"actor_admin_id"`
	ActorAdminRole   rbac.Role       `json:"actor_admin_role"`
	ApprovalID       *uuid.UUID      `json:"approval_id,omitempty"`
	RequesterAdminID *uuid.UUID      `json:"requester_admin_id,omitempty"`
	ExpectedRevision int64           `json:"expected_revision"`
	ReasonCode       string          `json:"reason_code"`
	TicketReference  string          `json:"ticket_reference,omitempty"`
	Payload          json.RawMessage `json:"payload"`
}

func (client *httpClient) ListOfficialDefinitions(ctx context.Context, actor ActorContext, page PageRequest) (Page[OfficialDefinition], error) {
	var result Page[OfficialDefinition]
	if err := client.officialPage(ctx, actor, "/internal/admin/v1/official-agent-definitions", page, &result); err != nil ||
		len(result.Items) > page.Limit || validateOfficialDefinitions(result) != nil {
		return Page[OfficialDefinition]{}, officialResultError(err)
	}
	return result, nil
}

func (client *httpClient) GetOfficialDefinition(ctx context.Context, actor ActorContext, id uuid.UUID) (OfficialDefinitionDetail, error) {
	var result OfficialDefinition
	if !validOfficialReadActor(actor, rbac.ReadOfficialAgents) || id == uuid.Nil {
		return OfficialDefinition{}, ErrContractViolation
	}
	if err := client.doJSONAs(ctx, &actor, http.MethodGet, "/internal/admin/v1/official-agent-definitions/"+id.String(), nil, nil, nil, &result); err != nil {
		return OfficialDefinition{}, err
	}
	if result.ID != id || validateOfficialDefinition(result) != nil {
		return OfficialDefinition{}, ErrContractViolation
	}
	return result, nil
}

func (client *httpClient) ListOfficialDrafts(ctx context.Context, actor ActorContext, page PageRequest) (Page[OfficialDraft], error) {
	var result Page[OfficialDraft]
	if err := client.officialPage(ctx, actor, "/internal/admin/v1/official-agent-drafts", page, &result); err != nil ||
		len(result.Items) > page.Limit || validateOfficialDrafts(result) != nil {
		return Page[OfficialDraft]{}, officialResultError(err)
	}
	return result, nil
}

func (client *httpClient) GetOfficialDraft(ctx context.Context, actor ActorContext, id uuid.UUID) (OfficialDraft, error) {
	var result OfficialDraft
	if !validOfficialReadActor(actor, rbac.ReadOfficialAgents) || id == uuid.Nil {
		return OfficialDraft{}, ErrContractViolation
	}
	if err := client.doJSONAs(ctx, &actor, http.MethodGet, "/internal/admin/v1/official-agent-drafts/"+id.String(), nil, nil, nil, &result); err != nil {
		return OfficialDraft{}, err
	}
	if result.ID != id || validateOfficialDraft(result) != nil {
		return OfficialDraft{}, ErrContractViolation
	}
	return result, nil
}

func (client *httpClient) ValidateOfficialDraft(ctx context.Context, actor ActorContext, id uuid.UUID) (OfficialDraftValidation, error) {
	var result OfficialDraftValidation
	if !validOfficialReadActor(actor, rbac.ManageOfficialDrafts) || id == uuid.Nil {
		return OfficialDraftValidation{}, ErrContractViolation
	}
	if err := client.doJSONAs(ctx, &actor, http.MethodPost, "/internal/admin/v1/official-agent-drafts/"+id.String()+"/validate", nil, nil, nil, &result); err != nil {
		return OfficialDraftValidation{}, err
	}
	if result.DraftID != id || validateOfficialDraftValidation(result) != nil {
		return OfficialDraftValidation{}, ErrContractViolation
	}
	return result, nil
}

func (client *httpClient) ListOfficialSubmissions(ctx context.Context, actor ActorContext, filter OfficialSubmissionFilter) (Page[OfficialSubmission], error) {
	query, err := officialPageQuery(filter.PageRequest)
	if err != nil || !validOfficialReadActor(actor, rbac.ReadOfficialAgents) ||
		(filter.Status != "" && !oneOf(filter.Status, "pending", "approved", "rejected", "withdrawn", "superseded")) {
		return Page[OfficialSubmission]{}, ErrContractViolation
	}
	if filter.Status != "" {
		query.Set("status", filter.Status)
	}
	var result Page[OfficialSubmission]
	if err := client.doJSONAs(ctx, &actor, http.MethodGet, "/internal/admin/v1/official-agent-submissions", query, nil, nil, &result); err != nil {
		return Page[OfficialSubmission]{}, err
	}
	if len(result.Items) > filter.Limit || validateOfficialSubmissions(result) != nil {
		return Page[OfficialSubmission]{}, ErrContractViolation
	}
	return result, nil
}

func (client *httpClient) GetOfficialSubmission(ctx context.Context, actor ActorContext, id uuid.UUID) (OfficialSubmission, error) {
	var result OfficialSubmission
	if !validOfficialReadActor(actor, rbac.ReadOfficialAgents) || id == uuid.Nil {
		return OfficialSubmission{}, ErrContractViolation
	}
	if err := client.doJSONAs(ctx, &actor, http.MethodGet, "/internal/admin/v1/official-agent-submissions/"+id.String(), nil, nil, nil, &result); err != nil {
		return OfficialSubmission{}, err
	}
	if result.ID != id || validateOfficialSubmission(result) != nil {
		return OfficialSubmission{}, ErrContractViolation
	}
	return result, nil
}

func (client *httpClient) ListOfficialVersions(ctx context.Context, actor ActorContext, page PageRequest) (Page[OfficialVersion], error) {
	var result Page[OfficialVersion]
	if err := client.officialPage(ctx, actor, "/internal/admin/v1/official-agent-versions", page, &result); err != nil ||
		len(result.Items) > page.Limit || validateOfficialVersions(result) != nil {
		return Page[OfficialVersion]{}, officialResultError(err)
	}
	return result, nil
}

func (client *httpClient) GetOfficialVersion(ctx context.Context, actor ActorContext, id uuid.UUID) (OfficialVersion, error) {
	var result OfficialVersion
	if !validOfficialReadActor(actor, rbac.ReadOfficialAgents) || id == uuid.Nil {
		return OfficialVersion{}, ErrContractViolation
	}
	if err := client.doJSONAs(ctx, &actor, http.MethodGet, "/internal/admin/v1/official-agent-versions/"+id.String(), nil, nil, nil, &result); err != nil {
		return OfficialVersion{}, err
	}
	if result.ID != id || validateOfficialVersion(result) != nil {
		return OfficialVersion{}, ErrContractViolation
	}
	return result, nil
}

func (client *httpClient) ListOfficialReleases(ctx context.Context, actor ActorContext, page PageRequest) (Page[OfficialRelease], error) {
	var result Page[OfficialRelease]
	if err := client.officialPage(ctx, actor, "/internal/admin/v1/official-agent-releases", page, &result); err != nil ||
		len(result.Items) > page.Limit || validateOfficialReleases(result) != nil {
		return Page[OfficialRelease]{}, officialResultError(err)
	}
	return result, nil
}

func (client *httpClient) GetOfficialRelease(ctx context.Context, actor ActorContext, id uuid.UUID) (OfficialReleaseDetail, error) {
	var result OfficialRelease
	if !validOfficialReadActor(actor, rbac.ReadOfficialAgents) || id == uuid.Nil {
		return OfficialRelease{}, ErrContractViolation
	}
	if err := client.doJSONAs(ctx, &actor, http.MethodGet, "/internal/admin/v1/official-agent-releases/"+id.String(), nil, nil, nil, &result); err != nil {
		return OfficialRelease{}, err
	}
	if result.ID != id || validateOfficialRelease(result) != nil {
		return OfficialRelease{}, ErrContractViolation
	}
	return result, nil
}

func (client *httpClient) ListOfficialAudit(ctx context.Context, actor ActorContext, page PageRequest) (Page[OfficialAuditEvent], error) {
	query, err := pageQuery(page)
	if err != nil || !validOfficialReadActor(actor, rbac.ReadOfficialAgentAudit) {
		return Page[OfficialAuditEvent]{}, ErrContractViolation
	}
	var result Page[OfficialAuditEvent]
	if err := client.doJSONAs(ctx, &actor, http.MethodGet, "/internal/admin/v1/official-agent-audit-events", query, nil, nil, &result); err != nil {
		return Page[OfficialAuditEvent]{}, err
	}
	if len(result.Items) > page.Limit || result.Items == nil || validateCursor(result.NextCursor) != nil {
		return Page[OfficialAuditEvent]{}, ErrContractViolation
	}
	for _, item := range result.Items {
		if validateOfficialAudit(item) != nil {
			return Page[OfficialAuditEvent]{}, ErrContractViolation
		}
	}
	return result, nil
}

func (client *httpClient) ExecuteOfficialCommand(ctx context.Context, actor ActorContext, command OfficialCommand) (Operation, error) {
	if !validOfficialMutationActor(actor, command.Action) || command.TargetID == uuid.Nil || command.ExpectedRevision <= 0 ||
		!officialReasonCodePattern.MatchString(command.ReasonCode) || len(command.TicketReference) > 128 ||
		(command.TicketReference != "" && strings.TrimSpace(command.TicketReference) != command.TicketReference) ||
		validateOfficialCommandPayload(command.Action, command.Payload) != nil {
		return Operation{}, ErrContractViolation
	}
	endpoint, method := officialCommandEndpoint(command.Action, command.TargetID)
	if endpoint == "" {
		return Operation{}, ErrContractViolation
	}
	envelope := officialMutationEnvelope{
		OperationID: *actor.OperationID, ActorAdminID: actor.AdminID, ActorAdminRole: actor.Role,
		ApprovalID: actor.ApprovalID, RequesterAdminID: actor.RequesterAdminID,
		ExpectedRevision: command.ExpectedRevision, ReasonCode: command.ReasonCode,
		TicketReference: command.TicketReference, Payload: append(json.RawMessage(nil), command.Payload...),
	}
	var result Operation
	if err := client.doJSONAs(ctx, &actor, method, endpoint, nil, envelope, actor.OperationID, &result); err != nil {
		return Operation{}, err
	}
	if validateOperation(result) != nil || result.ID != *actor.OperationID {
		return Operation{}, ErrContractViolation
	}
	return result, nil
}

func (client *httpClient) officialPage(ctx context.Context, actor ActorContext, endpoint string, page PageRequest, result any) error {
	query, err := officialPageQuery(page)
	if err != nil || !validOfficialReadActor(actor, rbac.ReadOfficialAgents) {
		return ErrContractViolation
	}
	return client.doJSONAs(ctx, &actor, http.MethodGet, endpoint, query, nil, nil, result)
}

func officialPageQuery(page PageRequest) (url.Values, error) {
	if page.Limit < 1 || page.Limit > 100 || (page.Cursor != "" && !canonicalUUIDString(page.Cursor)) {
		return nil, ErrContractViolation
	}
	query := url.Values{"limit": []string{strconv.Itoa(page.Limit)}}
	if page.Cursor != "" {
		query.Set("cursor", page.Cursor)
	}
	return query, nil
}

func officialCommandEndpoint(action OfficialAction, targetID uuid.UUID) (string, string) {
	switch action {
	case OfficialDefinitionReserve:
		return "/internal/admin/v1/official-agent-definitions", http.MethodPost
	case OfficialDraftCreate:
		return "/internal/admin/v1/official-agent-drafts", http.MethodPost
	case OfficialDraftUpdate:
		return "/internal/admin/v1/official-agent-drafts/" + targetID.String(), http.MethodPatch
	case OfficialDraftSubmit:
		return "/internal/admin/v1/official-agent-drafts/" + targetID.String() + "/submissions", http.MethodPost
	case OfficialSubmissionWithdraw:
		return "/internal/admin/v1/official-agent-submissions/" + targetID.String() + "/withdraw", http.MethodPost
	case OfficialSubmissionReview:
		return "/internal/admin/v1/official-agent-submissions/" + targetID.String() + "/reviews", http.MethodPost
	case OfficialReleaseActivate:
		return "/internal/admin/v1/official-agent-releases/" + targetID.String() + "/activate", http.MethodPost
	case OfficialReleaseRollout:
		return "/internal/admin/v1/official-agent-releases/" + targetID.String() + "/rollout", http.MethodPost
	case OfficialReleasePause:
		return "/internal/admin/v1/official-agent-releases/" + targetID.String() + "/pause", http.MethodPost
	case OfficialReleaseResume:
		return "/internal/admin/v1/official-agent-releases/" + targetID.String() + "/resume", http.MethodPost
	case OfficialReleaseRollback:
		return "/internal/admin/v1/official-agent-releases/" + targetID.String() + "/rollback", http.MethodPost
	default:
		return "", ""
	}
}

func validOfficialReadActor(actor ActorContext, permission rbac.Permission) bool {
	return validActorContext(&actor) && actor.OperationID == nil && actor.ApprovalID == nil &&
		actor.RequesterAdminID == nil && rbac.Allowed(actor.Role, permission)
}

func validOfficialMutationActor(actor ActorContext, action OfficialAction) bool {
	if !validActorContext(&actor) || actor.OperationID == nil {
		return false
	}
	permission := rbac.Permission("")
	switch action {
	case OfficialDefinitionReserve, OfficialDraftCreate, OfficialDraftUpdate, OfficialDraftSubmit, OfficialSubmissionWithdraw:
		permission = rbac.ManageOfficialDrafts
	case OfficialSubmissionReview:
		permission = rbac.ReviewOfficialAgents
	case OfficialReleaseActivate, OfficialReleaseRollout, OfficialReleasePause, OfficialReleaseResume:
		permission = rbac.ManageOfficialReleases
	case OfficialReleaseRollback:
		permission = rbac.ApproveOfficialRollback
		if actor.ApprovalID == nil || actor.RequesterAdminID == nil {
			return false
		}
	default:
		return false
	}
	if action != OfficialReleaseRollback && (actor.ApprovalID != nil || actor.RequesterAdminID != nil) {
		return false
	}
	return rbac.Allowed(actor.Role, permission)
}

func validateOfficialCommandPayload(action OfficialAction, raw json.RawMessage) error {
	if len(raw) < 2 || len(raw) > 131072 || !utf8.Valid(raw) || validateOfficialJSONEncoding(raw) != nil {
		return ErrContractViolation
	}
	var target any
	switch action {
	case OfficialDraftSubmit, OfficialSubmissionWithdraw, OfficialReleasePause, OfficialReleaseResume:
		target = &struct{}{}
	case OfficialDefinitionReserve:
		target = &struct {
			DisplayName   string `json:"display_name"`
			IconMediaType string `json:"icon_media_type,omitempty"`
			IconData      []byte `json:"icon_data,omitempty"`
		}{}
	case OfficialDraftCreate:
		target = &struct {
			DefinitionID  uuid.UUID        `json:"definition_id"`
			BaseVersionID *uuid.UUID       `json:"base_version_id,omitempty"`
			Kind          string           `json:"kind"`
			DisplayName   string           `json:"display_name"`
			IconMediaType string           `json:"icon_media_type,omitempty"`
			IconData      []byte           `json:"icon_data,omitempty"`
			Manifest      OfficialManifest `json:"manifest"`
			Bundle        OfficialBundle   `json:"bundle"`
		}{}
	case OfficialDraftUpdate:
		target = &struct {
			BaseVersionID *uuid.UUID       `json:"base_version_id,omitempty"`
			Kind          string           `json:"kind"`
			DisplayName   string           `json:"display_name"`
			IconMediaType string           `json:"icon_media_type,omitempty"`
			IconData      []byte           `json:"icon_data,omitempty"`
			Manifest      OfficialManifest `json:"manifest"`
			Bundle        OfficialBundle   `json:"bundle"`
		}{}
	case OfficialSubmissionReview:
		target = &struct {
			Decision         string   `json:"decision"`
			ReviewReasonCode string   `json:"review_reason_code,omitempty"`
			SafeNote         string   `json:"safe_note,omitempty"`
			InitialChannels  []string `json:"initial_channels,omitempty"`
		}{}
	case OfficialReleaseActivate:
		target = &struct {
			VersionID             uuid.UUID   `json:"version_id"`
			RolloutBasisPoints    int         `json:"rollout_basis_points"`
			MinimumDesktopVersion string      `json:"minimum_desktop_version"`
			AllowlistedUserIDs    []uuid.UUID `json:"allowlisted_user_ids,omitempty"`
		}{}
	case OfficialReleaseRollout:
		target = &struct {
			RolloutBasisPoints    int         `json:"rollout_basis_points"`
			MinimumDesktopVersion string      `json:"minimum_desktop_version"`
			AllowlistedUserIDs    []uuid.UUID `json:"allowlisted_user_ids,omitempty"`
		}{}
	case OfficialReleaseRollback:
		target = &struct {
			TargetVersionID         uuid.UUID `json:"target_version_id"`
			TargetReleaseRevisionID uuid.UUID `json:"target_release_revision_id"`
		}{}
	default:
		return ErrContractViolation
	}
	if decodeStrictOfficialJSON(raw, target) != nil {
		return ErrContractViolation
	}
	return validateDecodedOfficialPayload(action, target)
}

func validateDecodedOfficialPayload(action OfficialAction, target any) error {
	encoded, err := json.Marshal(target)
	if err != nil || len(encoded) < 2 {
		return ErrContractViolation
	}
	switch action {
	case OfficialDefinitionReserve:
		value := target.(*struct {
			DisplayName   string `json:"display_name"`
			IconMediaType string `json:"icon_media_type,omitempty"`
			IconData      []byte `json:"icon_data,omitempty"`
		})
		return validateOfficialPresentation(value.DisplayName, value.IconMediaType, value.IconData)
	case OfficialDraftCreate:
		value := target.(*struct {
			DefinitionID  uuid.UUID        `json:"definition_id"`
			BaseVersionID *uuid.UUID       `json:"base_version_id,omitempty"`
			Kind          string           `json:"kind"`
			DisplayName   string           `json:"display_name"`
			IconMediaType string           `json:"icon_media_type,omitempty"`
			IconData      []byte           `json:"icon_data,omitempty"`
			Manifest      OfficialManifest `json:"manifest"`
			Bundle        OfficialBundle   `json:"bundle"`
		})
		if value.DefinitionID == uuid.Nil {
			return ErrContractViolation
		}
		return validateOfficialDraftPayload(value.Kind, value.BaseVersionID, value.DisplayName, value.IconMediaType, value.IconData, value.Manifest, value.Bundle)
	case OfficialDraftUpdate:
		value := target.(*struct {
			BaseVersionID *uuid.UUID       `json:"base_version_id,omitempty"`
			Kind          string           `json:"kind"`
			DisplayName   string           `json:"display_name"`
			IconMediaType string           `json:"icon_media_type,omitempty"`
			IconData      []byte           `json:"icon_data,omitempty"`
			Manifest      OfficialManifest `json:"manifest"`
			Bundle        OfficialBundle   `json:"bundle"`
		})
		return validateOfficialDraftPayload(value.Kind, value.BaseVersionID, value.DisplayName, value.IconMediaType, value.IconData, value.Manifest, value.Bundle)
	case OfficialSubmissionReview:
		value := target.(*struct {
			Decision         string   `json:"decision"`
			ReviewReasonCode string   `json:"review_reason_code,omitempty"`
			SafeNote         string   `json:"safe_note,omitempty"`
			InitialChannels  []string `json:"initial_channels,omitempty"`
		})
		if value.Decision == "approve" {
			if len(value.InitialChannels) < 1 || len(value.InitialChannels) > 2 || value.ReviewReasonCode != "" || value.SafeNote != "" {
				return ErrContractViolation
			}
			seen := map[string]struct{}{}
			for _, channel := range value.InitialChannels {
				if !oneOf(channel, "internal", "stable") {
					return ErrContractViolation
				}
				if _, duplicate := seen[channel]; duplicate {
					return ErrContractViolation
				}
				seen[channel] = struct{}{}
			}
		} else if value.Decision != "reject" || !officialReasonCodePattern.MatchString(value.ReviewReasonCode) || len(value.InitialChannels) != 0 || len(value.SafeNote) > 500 {
			return ErrContractViolation
		}
	case OfficialDraftSubmit, OfficialSubmissionWithdraw, OfficialReleasePause, OfficialReleaseResume:
		return nil
	case OfficialReleaseActivate:
		value := target.(*struct {
			VersionID             uuid.UUID   `json:"version_id"`
			RolloutBasisPoints    int         `json:"rollout_basis_points"`
			MinimumDesktopVersion string      `json:"minimum_desktop_version"`
			AllowlistedUserIDs    []uuid.UUID `json:"allowlisted_user_ids,omitempty"`
		})
		if value.VersionID == uuid.Nil {
			return ErrContractViolation
		}
		return validateOfficialRollout(value.RolloutBasisPoints, value.MinimumDesktopVersion, value.AllowlistedUserIDs)
	case OfficialReleaseRollout:
		value := target.(*struct {
			RolloutBasisPoints    int         `json:"rollout_basis_points"`
			MinimumDesktopVersion string      `json:"minimum_desktop_version"`
			AllowlistedUserIDs    []uuid.UUID `json:"allowlisted_user_ids,omitempty"`
		})
		return validateOfficialRollout(value.RolloutBasisPoints, value.MinimumDesktopVersion, value.AllowlistedUserIDs)
	case OfficialReleaseRollback:
		value := target.(*struct {
			TargetVersionID         uuid.UUID `json:"target_version_id"`
			TargetReleaseRevisionID uuid.UUID `json:"target_release_revision_id"`
		})
		if value.TargetVersionID == uuid.Nil || value.TargetReleaseRevisionID == uuid.Nil {
			return ErrContractViolation
		}
	}
	return nil
}

func validateOfficialPresentation(displayName, iconMediaType string, iconData []byte) error {
	if !validOfficialLabel(displayName, 100) || strings.TrimSpace(displayName) != displayName ||
		(iconMediaType == "") != (len(iconData) == 0) || len(iconData) > 524288 ||
		(iconMediaType != "" && !oneOf(iconMediaType, "image/png", "image/webp")) {
		return ErrContractViolation
	}
	return nil
}

func validateOfficialDraftPayload(
	kind string,
	baseVersionID *uuid.UUID,
	displayName string,
	iconMediaType string,
	iconData []byte,
	manifest OfficialManifest,
	bundle OfficialBundle,
) error {
	if (kind == "initial" && baseVersionID != nil) ||
		(kind == "next" && (baseVersionID == nil || *baseVersionID == uuid.Nil)) ||
		(kind != "initial" && kind != "next") ||
		validateOfficialPresentation(displayName, iconMediaType, iconData) != nil {
		return ErrContractViolation
	}
	return validateOfficialPackage(manifest, bundle)
}

func validateOfficialRollout(basisPoints int, minimumVersion string, allowlist []uuid.UUID) error {
	if basisPoints < 0 || basisPoints > 10000 || !officialSemverPattern.MatchString(minimumVersion) || len(allowlist) > 10000 {
		return ErrContractViolation
	}
	seen := make(map[uuid.UUID]struct{}, len(allowlist))
	for _, userID := range allowlist {
		if userID == uuid.Nil {
			return ErrContractViolation
		}
		if _, duplicate := seen[userID]; duplicate {
			return ErrContractViolation
		}
		seen[userID] = struct{}{}
	}
	return nil
}

func validateOfficialDefinitions(page Page[OfficialDefinition]) error {
	if page.Items == nil || !validOfficialNextCursor(page.NextCursor) {
		return ErrContractViolation
	}
	for _, item := range page.Items {
		if validateOfficialDefinition(item) != nil {
			return ErrContractViolation
		}
	}
	return nil
}

func validateOfficialDefinition(value OfficialDefinition) error {
	if value.ID == uuid.Nil || value.PlatformID == uuid.Nil || value.CreatedByAdminID == uuid.Nil ||
		!validOfficialLabel(value.DisplayName, 100) || !oneOf(value.Status, "active", "archived") ||
		(value.LatestVersionID != nil && *value.LatestVersionID == uuid.Nil) ||
		(value.IconMediaType == "") != (len(value.IconData) == 0) ||
		(value.IconMediaType != "" && !oneOf(value.IconMediaType, "image/png", "image/webp")) || len(value.IconData) > 524288 ||
		strings.TrimSpace(value.DisplayName) != value.DisplayName ||
		value.CreatedAt.IsZero() || value.UpdatedAt.Before(value.CreatedAt) {
		return ErrContractViolation
	}
	return nil
}

func validateOfficialDrafts(page Page[OfficialDraft]) error {
	if page.Items == nil || !validOfficialNextCursor(page.NextCursor) {
		return ErrContractViolation
	}
	for _, item := range page.Items {
		if validateOfficialDraft(item) != nil {
			return ErrContractViolation
		}
	}
	return nil
}

func validateOfficialDraft(value OfficialDraft) error {
	if value.ID == uuid.Nil || value.PlatformID == uuid.Nil || value.DefinitionID == uuid.Nil ||
		value.LastEditorAdminID == uuid.Nil || value.LastEditorRole != rbac.Developer || value.Revision <= 0 ||
		!oneOf(value.Kind, "initial", "next") || !oneOf(value.Status, "active", "archived") ||
		!validOfficialLabel(value.DisplayName, 100) || !validDigest(value.ManifestDigest) ||
		!validDigest(value.BundleDigest) || !validDigest(value.ContentDigest) ||
		(value.Kind == "initial" && value.BaseVersionID != nil) ||
		(value.Kind == "next" && (value.BaseVersionID == nil || *value.BaseVersionID == uuid.Nil)) ||
		value.CreatedAt.IsZero() || value.UpdatedAt.Before(value.CreatedAt) ||
		validateOfficialPresentation(value.DisplayName, value.IconMediaType, value.IconData) != nil ||
		validateOfficialPackage(value.Manifest, value.Bundle) != nil {
		return ErrContractViolation
	}
	return nil
}

func validateOfficialDraftValidation(value OfficialDraftValidation) error {
	if value.DraftID == uuid.Nil || value.DraftRevision <= 0 || !validDigest(value.ContentDigest) ||
		!validOfficialLabel(value.DLPVersion, 100) || value.Findings == nil {
		return ErrContractViolation
	}
	for _, finding := range value.Findings {
		if !validOfficialLabel(finding.Code, 100) || !validOfficialLabel(finding.Path, 512) || finding.Line < 0 {
			return ErrContractViolation
		}
	}
	return nil
}

func validateOfficialSubmissions(page Page[OfficialSubmission]) error {
	if page.Items == nil || !validOfficialNextCursor(page.NextCursor) {
		return ErrContractViolation
	}
	for _, item := range page.Items {
		if validateOfficialSubmission(item) != nil {
			return ErrContractViolation
		}
	}
	return nil
}

func validateOfficialSubmission(value OfficialSubmission) error {
	if value.ID == uuid.Nil || value.PlatformID == uuid.Nil || value.DraftID == uuid.Nil || value.DraftRevision <= 0 ||
		value.DefinitionID == uuid.Nil || value.SubmittedByAdminID == uuid.Nil || value.SubmittedByRole != rbac.Developer ||
		!oneOf(value.Kind, "initial", "next") || !oneOf(value.Status, "pending", "approved", "rejected", "withdrawn", "superseded") ||
		!validOfficialLabel(value.DisplayName, 100) || !validDigest(value.ManifestDigest) || !validDigest(value.BundleDigest) ||
		!validDigest(value.ContentDigest) || value.Revision <= 0 || value.SubmittedAt.IsZero() ||
		value.UpdatedAt.Before(value.SubmittedAt) || (value.TerminalAt != nil && value.TerminalAt.Before(value.SubmittedAt)) ||
		(value.TerminalAt != nil && value.UpdatedAt.Before(*value.TerminalAt)) ||
		(value.Kind == "initial" && value.BaseVersionID != nil) ||
		(value.Kind == "next" && (value.BaseVersionID == nil || *value.BaseVersionID == uuid.Nil)) ||
		validateOfficialPresentation(value.DisplayName, value.IconMediaType, value.IconData) != nil ||
		validateOfficialPackage(value.Manifest, value.Bundle) != nil {
		return ErrContractViolation
	}
	switch value.Status {
	case "pending":
		if value.TerminalAt != nil || value.Review != nil {
			return ErrContractViolation
		}
	case "approved", "rejected":
		if value.TerminalAt == nil || value.Review == nil ||
			(value.Status == "approved" && value.Review.Decision != "approve") ||
			(value.Status == "rejected" && value.Review.Decision != "reject") {
			return ErrContractViolation
		}
	case "withdrawn", "superseded":
		if value.TerminalAt == nil || value.Review != nil {
			return ErrContractViolation
		}
	}
	if value.Review != nil && (validateOfficialReview(*value.Review) != nil || value.Review.ReviewedContentDigest != value.ContentDigest) {
		return ErrContractViolation
	}
	return nil
}

func validateOfficialReview(value OfficialReview) error {
	if value.ID == uuid.Nil || value.ReviewerAdminID == uuid.Nil || value.ReviewerRole != rbac.SuperAdmin ||
		!oneOf(value.Decision, "approve", "reject") || value.PlatformPolicySnapshotID == uuid.Nil ||
		value.PlatformPolicyVersion <= 0 || !validDigest(value.ReviewedContentDigest) || value.ReviewedAt.IsZero() ||
		(value.ReasonCode != "" && !officialReasonCodePattern.MatchString(value.ReasonCode)) || len(value.SafeNote) > 500 {
		return ErrContractViolation
	}
	if (value.Decision == "approve" && (value.ReasonCode != "" || value.SafeNote != "")) ||
		(value.Decision == "reject" && !officialReasonCodePattern.MatchString(value.ReasonCode)) {
		return ErrContractViolation
	}
	return nil
}

func validateOfficialVersions(page Page[OfficialVersion]) error {
	if page.Items == nil || !validOfficialNextCursor(page.NextCursor) {
		return ErrContractViolation
	}
	for _, item := range page.Items {
		if validateOfficialVersion(item) != nil {
			return ErrContractViolation
		}
	}
	return nil
}

func validateOfficialVersion(value OfficialVersion) error {
	if value.ID == uuid.Nil || value.DefinitionID == uuid.Nil || value.VersionNumber <= 0 ||
		!validDigest(value.ContentDigest) || !officialSemverPattern.MatchString(value.RuntimeMinimumVersion) ||
		(value.RuntimeMaximumVersionExclusive != "" && !officialSemverPattern.MatchString(value.RuntimeMaximumVersionExclusive)) ||
		value.PublishedAt.IsZero() || validateOfficialPackage(value.Manifest, value.Bundle) != nil {
		return ErrContractViolation
	}
	return nil
}

func validateOfficialReleases(page Page[OfficialRelease]) error {
	if page.Items == nil || !validOfficialNextCursor(page.NextCursor) {
		return ErrContractViolation
	}
	for _, item := range page.Items {
		if validateOfficialRelease(item) != nil {
			return ErrContractViolation
		}
	}
	return nil
}

func validateOfficialRelease(value OfficialRelease) error {
	if value.ID == uuid.Nil || value.PlatformID == uuid.Nil || value.DefinitionID == uuid.Nil ||
		value.CurrentRevisionID == uuid.Nil || value.HeadRevision <= 0 || value.AgentVersionID == uuid.Nil ||
		!oneOf(value.Channel, "internal", "stable") || !oneOf(value.State, "active", "paused") ||
		value.RolloutBasisPoints < 0 || value.RolloutBasisPoints > 10000 ||
		!officialSemverPattern.MatchString(value.MinimumDesktopVersion) ||
		!oneOf(value.Action, "initial", "activate", "rollout_update", "pause", "resume", "rollback") ||
		value.ActorAdminID == uuid.Nil || !value.ActorAdminRole.Valid() || !officialReasonCodePattern.MatchString(value.ReasonCode) ||
		value.AudienceCount < 0 || value.AudienceCount > 10000 || value.CreatedAt.IsZero() || value.UpdatedAt.Before(value.CreatedAt) {
		return ErrContractViolation
	}
	roleOK := (value.Action == "initial" && value.ActorAdminRole == rbac.SuperAdmin) ||
		(oneOf(value.Action, "activate", "rollout_update", "pause", "resume") && value.ActorAdminRole == rbac.Operator) ||
		(value.Action == "rollback" && value.ActorAdminRole == rbac.SuperAdmin)
	if !roleOK {
		return ErrContractViolation
	}
	return nil
}

func validateOfficialAudit(value OfficialAuditEvent) error {
	if value.ID == uuid.Nil || !strings.HasPrefix(value.EventType, "official_") || !validOfficialLabel(value.ObjectType, 100) ||
		value.ObjectID == uuid.Nil || !oneOf(value.Outcome, "success", "denied") ||
		(value.ReasonCode != "" && !officialReasonCodePattern.MatchString(value.ReasonCode)) ||
		!validOfficialLabel(value.RequestID, 128) || value.ActorAdminID == uuid.Nil ||
		!value.ActorAdminRole.Valid() || value.CreatedAt.IsZero() {
		return ErrContractViolation
	}
	return nil
}

func validateOfficialPackage(manifest OfficialManifest, bundle OfficialBundle) error {
	if manifest.SchemaVersion != 1 || !validOfficialLabel(manifest.Identity.SystemPrompt, 262144) ||
		manifest.Assets == nil || len(manifest.Assets) > 128 || manifest.Dependencies == nil || len(manifest.Dependencies) > 128 ||
		bundle.Assets == nil || len(bundle.Assets) > 128 ||
		!validOfficialStringSet(manifest.ModelConstraints.AllowedProviders, 1, 128) ||
		!validOfficialStringSet(manifest.ModelConstraints.AllowedModels, 1, 256) ||
		!validOfficialStringSet(manifest.Tools.Allowed, 0, 256) ||
		!validOfficialStringSet(manifest.Tools.Denied, 0, 256) ||
		!officialSemverPattern.MatchString(manifest.RuntimeCompatibility.MinimumVersion) ||
		(manifest.RuntimeCompatibility.MaximumVersionExclusive != "" &&
			!officialSemverPattern.MatchString(manifest.RuntimeCompatibility.MaximumVersionExclusive)) {
		return ErrContractViolation
	}
	bundleByPath := make(map[string]string, len(bundle.Assets))
	for _, asset := range bundle.Assets {
		if !validOfficialAssetPath(asset.Path) || !utf8.ValidString(asset.Content) || len([]byte(asset.Content)) > 262144 {
			return ErrContractViolation
		}
		if _, duplicate := bundleByPath[asset.Path]; duplicate {
			return ErrContractViolation
		}
		bundleByPath[asset.Path] = asset.Content
	}
	manifestPaths := make(map[string]struct{}, len(manifest.Assets))
	for _, asset := range manifest.Assets {
		if !validOfficialAssetPath(asset.Path) || !oneOf(asset.Kind, "skill", "sop", "knowledge") ||
			!oneOf(asset.MediaType, "text/markdown", "text/plain") || !validDigest(asset.SHA256) {
			return ErrContractViolation
		}
		if _, duplicate := manifestPaths[asset.Path]; duplicate {
			return ErrContractViolation
		}
		content, exists := bundleByPath[asset.Path]
		digest := sha256.Sum256([]byte(content))
		if !exists || hex.EncodeToString(digest[:]) != asset.SHA256 {
			return ErrContractViolation
		}
		manifestPaths[asset.Path] = struct{}{}
	}
	if len(manifestPaths) != len(bundleByPath) {
		return ErrContractViolation
	}
	allowedTools := make(map[string]struct{}, len(manifest.Tools.Allowed))
	for _, tool := range manifest.Tools.Allowed {
		allowedTools[tool] = struct{}{}
	}
	for _, tool := range manifest.Tools.Denied {
		if _, conflict := allowedTools[tool]; conflict {
			return ErrContractViolation
		}
	}
	dependencies := make(map[string]struct{}, len(manifest.Dependencies))
	for _, dependency := range manifest.Dependencies {
		if dependency.DefinitionID == uuid.Nil || dependency.VersionID == uuid.Nil {
			return ErrContractViolation
		}
		key := dependency.DefinitionID.String() + "\x00" + dependency.VersionID.String()
		if _, duplicate := dependencies[key]; duplicate {
			return ErrContractViolation
		}
		dependencies[key] = struct{}{}
	}
	return nil
}

func validOfficialStringSet(values []string, minimum, maximumLength int) bool {
	if values == nil || len(values) < minimum {
		return false
	}
	seen := make(map[string]struct{}, len(values))
	for _, value := range values {
		if !validOfficialLabel(value, maximumLength) || strings.TrimSpace(value) != value || strings.Contains(value, "://") {
			return false
		}
		if _, duplicate := seen[value]; duplicate {
			return false
		}
		seen[value] = struct{}{}
	}
	return true
}

func validOfficialAssetPath(value string) bool {
	if !validOfficialLabel(value, 512) || strings.TrimSpace(value) != value || strings.Contains(value, `\`) ||
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

func validOfficialNextCursor(value string) bool {
	return value == "" || canonicalUUIDString(value)
}

func canonicalUUIDString(value string) bool {
	parsed, err := uuid.Parse(value)
	return err == nil && parsed != uuid.Nil && parsed.String() == value
}

func validDigest(value string) bool {
	if !officialDigestPattern.MatchString(value) {
		return false
	}
	decoded, err := hex.DecodeString(value)
	return err == nil && len(decoded) == sha256.Size
}

func validOfficialLabel(value string, maximum int) bool {
	return value != "" && utf8.ValidString(value) && utf8.RuneCountInString(value) <= maximum &&
		!strings.ContainsRune(value, '\x00')
}

func oneOf[T comparable](value T, allowed ...T) bool {
	for _, candidate := range allowed {
		if value == candidate {
			return true
		}
	}
	return false
}

func officialResultError(err error) error {
	if err != nil {
		return err
	}
	return ErrContractViolation
}

func decodeStrictOfficialJSON(raw []byte, target any) error {
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(target); err != nil {
		return err
	}
	if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		return ErrContractViolation
	}
	return nil
}

var officialUUIDJSONFields = map[string]struct{}{
	"operation_id": {}, "actor_admin_id": {}, "approval_id": {}, "requester_admin_id": {},
	"definition_id": {}, "platform_id": {}, "latest_version_id": {}, "created_by_admin_id": {},
	"draft_id": {}, "base_version_id": {}, "last_editor_admin_id": {}, "submission_id": {},
	"submitted_by_admin_id": {}, "review_id": {}, "reviewer_admin_id": {},
	"platform_policy_snapshot_id": {}, "version_id": {}, "release_id": {},
	"current_revision_id": {}, "agent_version_id": {}, "previous_revision_id": {},
	"rollback_target_revision_id": {}, "target_version_id": {}, "target_release_revision_id": {},
	"event_id": {}, "object_id": {}, "agent_definition_id": {},
}

func validateOfficialJSONEncoding(raw []byte) error {
	if rejectDuplicateOfficialJSONKeys(raw) != nil {
		return ErrContractViolation
	}
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.UseNumber()
	var value any
	if err := decoder.Decode(&value); err != nil {
		return ErrContractViolation
	}
	if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		return ErrContractViolation
	}
	if validateOfficialJSONUUIDValues(value) != nil {
		return ErrContractViolation
	}
	return nil
}

func validateOfficialJSONUUIDValues(value any) error {
	switch typed := value.(type) {
	case map[string]any:
		for key, nested := range typed {
			if _, uuidField := officialUUIDJSONFields[key]; uuidField {
				if nested == nil {
					continue
				}
				encoded, ok := nested.(string)
				if !ok || !canonicalUUIDString(encoded) {
					return ErrContractViolation
				}
				continue
			}
			if key == "allowlisted_user_ids" {
				values, ok := nested.([]any)
				if !ok {
					return ErrContractViolation
				}
				for _, item := range values {
					encoded, ok := item.(string)
					if !ok || !canonicalUUIDString(encoded) {
						return ErrContractViolation
					}
				}
				continue
			}
			if err := validateOfficialJSONUUIDValues(nested); err != nil {
				return err
			}
		}
	case []any:
		for _, nested := range typed {
			if err := validateOfficialJSONUUIDValues(nested); err != nil {
				return err
			}
		}
	}
	return nil
}

func rejectDuplicateOfficialJSONKeys(raw []byte) error {
	decoder := json.NewDecoder(bytes.NewReader(raw))
	if err := scanOfficialJSONValue(decoder); err != nil {
		return err
	}
	if _, err := decoder.Token(); !errors.Is(err, io.EOF) {
		return ErrContractViolation
	}
	return nil
}

func scanOfficialJSONValue(decoder *json.Decoder) error {
	token, err := decoder.Token()
	if err != nil {
		return err
	}
	delimiter, compound := token.(json.Delim)
	if !compound {
		return nil
	}
	if delimiter == '{' {
		seen := map[string]struct{}{}
		for decoder.More() {
			keyToken, err := decoder.Token()
			if err != nil {
				return err
			}
			key, ok := keyToken.(string)
			if !ok {
				return ErrContractViolation
			}
			if _, duplicate := seen[key]; duplicate {
				return ErrContractViolation
			}
			seen[key] = struct{}{}
			if err := scanOfficialJSONValue(decoder); err != nil {
				return err
			}
		}
	} else if delimiter == '[' {
		for decoder.More() {
			if err := scanOfficialJSONValue(decoder); err != nil {
				return err
			}
		}
	} else {
		return ErrContractViolation
	}
	closing, err := decoder.Token()
	if err != nil || (delimiter == '{' && closing != json.Delim('}')) || (delimiter == '[' && closing != json.Delim(']')) {
		return ErrContractViolation
	}
	return nil
}

var _ OfficialAgentClient = (*httpClient)(nil)
