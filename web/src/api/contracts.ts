import { z } from 'zod';

export const roles = [
  'super_admin',
  'developer',
  'operator',
  'support',
  'finance',
  'auditor',
] as const;

// Roles are data-driven and editable at runtime, so AdminRole is any role slug
// rather than a fixed union. The list below is only the built-in system roles.
export type AdminRole = string;

export const roleLabels: Record<AdminRole, string> = {
  super_admin: '超级管理员',
  developer: '开发人员',
  operator: '运营人员',
  support: '客服人员',
  finance: '财务人员',
  auditor: '审计人员',
};

export const permissions = [
  'administrator.manage',
  'administrator.read',
  'cloud_user.read',
  'cloud_user.read_technical',
  'cloud_identity.lookup_exact',
  'cloud_device.read',
  'cloud_session.revoke',
  'cloud_device.revoke',
  'account_lifecycle.initiate',
  'account_lifecycle.approve',
  'audit.read_full',
  'audit.read_own',
  'service_health.read',
  'system_settings.read',
  'system_settings.manage',
  'official_agent.read',
  'official_agent.draft.manage',
  'official_agent.review',
  'official_agent.release.manage',
  'official_agent.rollback.request',
  'official_agent.rollback.approve',
  'official_agent.audit.read',
] as const;

export type Permission = (typeof permissions)[number];

export const rolePermissions: Record<AdminRole, readonly Permission[]> = {
  super_admin: [
    'administrator.manage',
    'administrator.read',
    'cloud_user.read',
    'cloud_user.read_technical',
    'cloud_identity.lookup_exact',
    'cloud_device.read',
    'cloud_session.revoke',
    'cloud_device.revoke',
    'account_lifecycle.approve',
    'audit.read_full',
    'service_health.read',
    'system_settings.read',
    'system_settings.manage',
    'official_agent.read',
    'official_agent.review',
    'official_agent.rollback.approve',
    'official_agent.audit.read',
  ],
  developer: [
    'cloud_user.read_technical',
    'cloud_device.read',
    'service_health.read',
    'official_agent.read',
    'official_agent.draft.manage',
  ],
  operator: [
    'cloud_user.read',
    'cloud_identity.lookup_exact',
    'cloud_device.read',
    'cloud_session.revoke',
    'cloud_device.revoke',
    'account_lifecycle.initiate',
    'audit.read_own',
    'service_health.read',
    'official_agent.read',
    'official_agent.release.manage',
    'official_agent.rollback.request',
  ],
  support: [
    'cloud_user.read',
    'cloud_identity.lookup_exact',
    'cloud_device.read',
    'cloud_session.revoke',
    'cloud_device.revoke',
    'audit.read_own',
  ],
  finance: [],
  auditor: [
    'administrator.read',
    'audit.read_full',
    'service_health.read',
    'system_settings.read',
    'official_agent.read',
    'official_agent.audit.read',
  ],
};

export function isAdminRole(value: unknown): value is AdminRole {
  return typeof value === 'string' && /^[a-z][a-z0-9_]{1,49}$/.test(value);
}

export function roleLabel(role: string): string {
  return (roleLabels as Record<string, string | undefined>)[role] ?? role;
}

// Permission checks operate on the current administrator's EFFECTIVE permission
// set (delivered in the session document), because roles are now data-driven and
// editable; the static rolePermissions map is only a build-time fallback.
export function hasPermission(granted: readonly string[] | undefined, permission: Permission): boolean {
  return Boolean(granted?.includes(permission));
}

export function hasAnyPermission(granted: readonly string[] | undefined, required: readonly Permission[]): boolean {
  return required.some((permission) => hasPermission(granted, permission));
}

export interface RbacRole {
  slug: string;
  name: string;
  description: string;
  is_system: boolean;
  permissions: Permission[];
  user_count: number;
  created_at: string;
  updated_at: string;
}

export interface RbacRoleList {
  roles: RbacRole[];
}

export interface RbacCatalog {
  permissions: Permission[];
}

export interface AdministratorPrincipal {
  admin_id: string;
  session_id: string;
  role: AdminRole;
  permissions: string[];
  security_version: number;
  mfa_authenticated_at: string;
  totp_authenticated_at: string | null;
  mfa_method: 'totp' | 'recovery';
}

export interface SessionDocument {
  csrf_token: string;
  administrator: AdministratorPrincipal;
  display_name: string;
  absolute_expires_at: string;
}

export function isSessionDocument(value: unknown): value is SessionDocument {
  if (!value || typeof value !== 'object') return false;
  const document = value as Partial<SessionDocument>;
  const principal = document.administrator as Partial<AdministratorPrincipal> | undefined;
  return (
    typeof document.csrf_token === 'string' &&
    document.csrf_token.length > 0 &&
    document.csrf_token.length <= 512 &&
    typeof document.display_name === 'string' &&
    document.display_name.length > 0 &&
    typeof document.absolute_expires_at === 'string' &&
    Boolean(principal) &&
    typeof principal?.admin_id === 'string' &&
    typeof principal.session_id === 'string' &&
    isAdminRole(principal.role) &&
    Array.isArray(principal.permissions) &&
    typeof principal.security_version === 'number' &&
    principal.security_version > 0 &&
    typeof principal.mfa_authenticated_at === 'string' &&
    (principal.totp_authenticated_at === null || typeof principal.totp_authenticated_at === 'string') &&
    (principal.mfa_method === 'totp' || principal.mfa_method === 'recovery')
  );
}

export interface LoginChallenge {
  challenge_id: string;
  expires_at: string;
}

export interface ActivationPreparation {
  admin_id: string;
  display_name: string;
  masked_identity: string;
  purpose: 'activation' | 'totp_reset';
  provisioning_uri: string;
  expires_at: string;
}

export interface ActivationResult {
  admin_id: string;
  recovery_codes: string[];
}

export type AdministratorStatus = 'invited' | 'active' | 'suspended';

export interface Administrator {
  id: string;
  masked_identity: string;
  display_name: string;
  role: AdminRole;
  status: AdministratorStatus;
  mfa_enabled: boolean;
  security_version: number;
  last_login_at?: string;
  created_at: string;
  updated_at: string;
}

export interface AdministratorList {
  items: Administrator[];
}

export interface InvitationResult {
  invitation_id: string;
  admin_id: string;
  activation_url: string;
  expires_at: string;
}

export interface APIErrorDocument {
  error?: {
    code?: string;
    message?: string;
  };
}

export type CloudAvailability = 'not_configured' | 'available' | 'unavailable' | 'contract_error';
export type CloudUserStatus = 'active' | 'pending_deletion' | 'disabled';
export type CloudDeviceStatus = 'active' | 'inactive' | 'revoked';
export type CloudSessionStatus = 'active' | 'rotated' | 'expired' | 'revoked' | 'replay_detected';
export type OperationState = 'queued' | 'executing' | 'reconciling' | 'succeeded' | 'failed' | 'conflict';
export type ApprovalStatus = 'pending_review' | 'approved' | 'rejected' | 'expired' | 'cancelled';
export type ApprovalExecutionStatus = 'not_started' | OperationState;

export interface CloudUser {
  user_id: string;
  masked_email?: string;
  masked_phone?: string;
  status: CloudUserStatus;
  administratively_disabled: boolean;
  deletion_finalized_at?: string;
  administrative_revision: number;
  device_count: number;
  active_device_count: number;
  active_session_count: number;
  created_at: string;
  last_cloud_activity_at?: string;
}

// CloudStats mirrors the aera-cloud admin overview counters (no personal data).
export interface CloudStats {
  user_total: number;
  user_active: number;
  user_disabled: number;
  user_pending_deletion: number;
  device_total: number;
  device_active: number;
}

export interface CloudDeviceVersionStat {
  platform: string;
  app_version: string;
  total: number;
  active: number;
}

// CloudDeviceStats is the installed base grouped by platform and app version.
export interface CloudDeviceStats {
  buckets: CloudDeviceVersionStat[];
}

export interface CloudMembership {
  id: string;
  display_name: string;
  role: string;
  status: string;
}

// CloudUserMemberships lists the orgs and workspaces a user belongs to.
export interface CloudUserMemberships {
  organizations: CloudMembership[];
  workspaces: CloudMembership[];
}

export interface CloudDevice {
  device_id: string;
  user_id: string;
  display_name: string;
  platform: string;
  client_version: string;
  status: CloudDeviceStatus;
  last_seen_at?: string;
}

export interface CloudSession {
  session_id: string;
  user_id: string;
  device_id: string;
  status: CloudSessionStatus;
  issued_at: string;
  expires_at: string;
  revoked_at?: string;
}

export interface Page<T> {
  items: T[];
  next_cursor?: string;
}

export interface AdminOperation {
  operation_id: string;
  state: OperationState;
  error_code?: string;
  updated_at: string;
}

export interface ApprovalEvent {
  id: string;
  event_type: string;
  before_status: string;
  after_status: string;
  result_code?: string;
  actor_admin_id: string;
  actor_role: AdminRole;
  request_id: string;
  created_at: string;
}

export interface ApprovalRequest {
  id: string;
  action: 'disable_user' | 'enable_user';
  target_user_id: string;
  target_snapshot: CloudUser;
  requested_by_admin_id: string;
  requested_by_role: 'operator';
  reviewed_by_admin_id?: string;
  reason_code: string;
  ticket_reference?: string;
  note?: string;
  expected_revision: number;
  approval_status: ApprovalStatus;
  execution_status: ApprovalExecutionStatus;
  operation_id?: string;
  expires_at: string;
  created_at: string;
  updated_at: string;
  version: number;
  events?: ApprovalEvent[];
}

export interface SystemHealth {
  admin: 'ok';
  postgres: 'ok' | 'unavailable';
  redis: 'ok' | 'unavailable';
  cloud: {
    configured: boolean;
    availability: CloudAvailability;
    mtls: 'not_checked' | 'ok' | 'unavailable' | 'contract_error';
    service_jwt: 'not_checked' | 'ok' | 'unavailable' | 'contract_error';
    upstream: 'not_checked' | 'ok' | 'unavailable' | 'contract_error';
    checked_at: string;
  };
}

export interface ReasonInput {
  reason_code: string;
  ticket_reference: string;
  note: string;
}

export type ReasonCategory = 'administrator' | 'session' | 'device' | 'account' | 'security' | 'official_agent';
export type ReasonUsage = 'administrator' | 'account' | 'device' | 'session' | 'settings' | 'official_agent';

export interface ReasonCode {
  code: string;
  category: ReasonCategory;
  label: string;
  active: boolean;
  revision: number;
  created_at: string;
  updated_at: string;
}

export interface ReasonCodePage {
  items: ReasonCode[];
  settings_revision: number;
}

export interface SecurityPolicy {
  session_idle_minutes: number;
  session_absolute_hours: number;
  audit_retention_days: number;
  revision: number;
  updated_by_admin_id: string | null;
  updated_at: string;
}

export interface UpdateSecurityPolicyInput extends ReasonInput {
  expected_revision: number;
  session_idle_minutes: number;
  session_absolute_hours: number;
  audit_retention_days: number;
}

export interface SecurityPolicyMutationResult {
  operation_id: string;
  policy: SecurityPolicy;
  sessions_revoked: boolean;
}

export interface CreateReasonCodeInput extends ReasonInput {
  code: string;
  category: ReasonCategory;
  label: string;
  expected_settings_revision: number;
}

export interface UpdateReasonCodeInput extends ReasonInput {
  expected_settings_revision: number;
  expected_reason_revision: number;
  label: string;
  active: boolean;
}

export interface ReasonCodeMutationResult {
  operation_id: string;
  reason: ReasonCode;
  settings_revision: number;
}

export type AuditOutcome = 'success' | 'failure' | 'denied';

export interface AuditEvent {
  id: string;
  actor_admin_id: string | null;
  actor_role?: AdminRole;
  event_type: string;
  object_type: string;
  object_id: string | null;
  outcome: AuditOutcome;
  reason_code?: string;
  ticket_reference?: string;
  note?: string;
  approval_id: string | null;
  operation_id: string | null;
  error_code?: string;
  before_state?: Record<string, string>;
  after_state?: Record<string, string>;
  request_id: string;
  created_at: string;
}

export interface AuditEventPage {
  items: AuditEvent[];
  next_cursor: string | null;
}

const officialUUIDSchema = z.uuid();
const officialTimestampSchema = z.iso.datetime({ offset: true });
const officialDigestSchema = z.string().regex(/^[0-9a-f]{64}$/);
const officialRoleSchema = z.string().regex(/^[a-z][a-z0-9_]{1,49}$/);

export const officialManifestSchema = z.strictObject({
  schema_version: z.literal(1),
  identity: z.strictObject({ system_prompt: z.string().min(1).max(262_144) }),
  assets: z.array(z.strictObject({
    path: z.string().min(1).max(512),
    kind: z.enum(['skill', 'sop', 'knowledge']),
    media_type: z.enum(['text/markdown', 'text/plain']),
    sha256: officialDigestSchema,
  })).max(128),
  model_constraints: z.strictObject({
    allowed_providers: z.array(z.string().min(1).max(128)).min(1),
    allowed_models: z.array(z.string().min(1).max(256)).min(1),
  }),
  tools: z.strictObject({
    allowed: z.array(z.string().min(1).max(256)),
    denied: z.array(z.string().min(1).max(256)),
  }),
  dependencies: z.array(z.strictObject({
    agent_definition_id: officialUUIDSchema,
    agent_version_id: officialUUIDSchema,
  })).max(128),
  runtime_compatibility: z.strictObject({
    minimum_version: z.string().min(1).max(64),
    maximum_version_exclusive: z.string().min(1).max(64).optional(),
  }),
});

export const officialBundleSchema = z.strictObject({
  assets: z.array(z.strictObject({
    path: z.string().min(1).max(512),
    content: z.string().max(262_144),
  })).max(128),
});

export const officialDefinitionSchema = z.strictObject({
  definition_id: officialUUIDSchema,
  platform_id: officialUUIDSchema,
  display_name: z.string().min(1).max(100),
  icon_media_type: z.enum(['image/png', 'image/webp']).optional(),
  icon_data: z.string().max(699_052).optional(),
  status: z.enum(['active', 'archived']),
  latest_version_id: officialUUIDSchema.optional(),
  created_by_admin_id: officialUUIDSchema,
  created_at: officialTimestampSchema,
  updated_at: officialTimestampSchema,
  replayed: z.boolean().optional(),
});

export const officialDraftSchema = z.strictObject({
  draft_id: officialUUIDSchema,
  platform_id: officialUUIDSchema,
  definition_id: officialUUIDSchema,
  base_version_id: officialUUIDSchema.optional(),
  kind: z.enum(['initial', 'next']),
  display_name: z.string().min(1).max(100),
  icon_media_type: z.enum(['image/png', 'image/webp']).optional(),
  icon_data: z.string().max(699_052).optional(),
  manifest: officialManifestSchema,
  bundle: officialBundleSchema,
  manifest_digest: officialDigestSchema,
  bundle_digest: officialDigestSchema,
  content_digest: officialDigestSchema,
  revision: z.number().int().positive(),
  status: z.enum(['active', 'archived']),
  last_editor_admin_id: officialUUIDSchema,
  last_editor_role: officialRoleSchema,
  created_at: officialTimestampSchema,
  updated_at: officialTimestampSchema,
  replayed: z.boolean().optional(),
});

export const officialDraftValidationSchema = z.strictObject({
  draft_id: officialUUIDSchema,
  draft_revision: z.number().int().positive(),
  content_digest: officialDigestSchema,
  dlp_version: z.string().min(1).max(128),
  valid: z.boolean(),
  findings: z.array(z.strictObject({
    code: z.string().min(1).max(100),
    path: z.string().min(1).max(512),
    line: z.number().int().positive().optional(),
  })),
});

const officialReviewSchema = z.strictObject({
  review_id: officialUUIDSchema,
  reviewer_admin_id: officialUUIDSchema,
  reviewer_role: z.literal('super_admin'),
  decision: z.enum(['approve', 'reject']),
  reason_code: z.string().regex(/^[a-z][a-z0-9_]{2,63}$/).optional(),
  safe_note: z.string().max(500).optional(),
  platform_policy_snapshot_id: officialUUIDSchema,
  platform_policy_version: z.number().int().positive(),
  reviewed_content_digest: officialDigestSchema,
  reviewed_at: officialTimestampSchema,
});

export const officialSubmissionSchema = z.strictObject({
  submission_id: officialUUIDSchema,
  platform_id: officialUUIDSchema,
  draft_id: officialUUIDSchema,
  draft_revision: z.number().int().positive(),
  definition_id: officialUUIDSchema,
  base_version_id: officialUUIDSchema.optional(),
  kind: z.enum(['initial', 'next']),
  display_name: z.string().min(1).max(100),
  icon_media_type: z.enum(['image/png', 'image/webp']).optional(),
  icon_data: z.string().max(699_052).optional(),
  manifest: officialManifestSchema,
  bundle: officialBundleSchema,
  manifest_digest: officialDigestSchema,
  bundle_digest: officialDigestSchema,
  content_digest: officialDigestSchema,
  submitted_by_admin_id: officialUUIDSchema,
  submitted_by_role: z.literal('developer'),
  status: z.enum(['pending', 'approved', 'rejected', 'withdrawn', 'superseded']),
  revision: z.number().int().positive(),
  submitted_at: officialTimestampSchema,
  terminal_at: officialTimestampSchema.optional(),
  updated_at: officialTimestampSchema,
  review: officialReviewSchema.optional(),
  replayed: z.boolean().optional(),
});

export const officialVersionSchema = z.strictObject({
  version_id: officialUUIDSchema,
  definition_id: officialUUIDSchema,
  version_number: z.number().int().positive(),
  manifest: officialManifestSchema,
  bundle: officialBundleSchema,
  content_digest: officialDigestSchema,
  runtime_minimum_version: z.string().min(1).max(64),
  runtime_maximum_version_exclusive: z.string().min(1).max(64).optional(),
  published_at: officialTimestampSchema,
});

export const officialReleaseSchema = z.strictObject({
  release_id: officialUUIDSchema,
  platform_id: officialUUIDSchema,
  definition_id: officialUUIDSchema,
  channel: z.enum(['internal', 'stable']),
  current_revision_id: officialUUIDSchema,
  head_revision: z.number().int().positive(),
  agent_version_id: officialUUIDSchema,
  state: z.enum(['active', 'paused']),
  rollout_basis_points: z.number().int().min(0).max(10_000),
  minimum_desktop_version: z.string().min(1).max(64),
  action: z.enum(['initial', 'activate', 'rollout_update', 'pause', 'resume', 'rollback']),
  previous_revision_id: officialUUIDSchema.optional(),
  rollback_target_revision_id: officialUUIDSchema.optional(),
  actor_admin_id: officialUUIDSchema,
  actor_admin_role: officialRoleSchema,
  reason_code: z.string().regex(/^[a-z][a-z0-9_]{2,63}$/),
  ticket_reference: z.string().min(1).max(128).optional(),
  audience_count: z.number().int().min(0).max(10_000),
  created_at: officialTimestampSchema,
  updated_at: officialTimestampSchema,
  replayed: z.boolean().optional(),
});

export const officialOperationSchema = z.strictObject({
  operation_id: officialUUIDSchema,
  state: z.enum(['queued', 'executing', 'reconciling', 'succeeded', 'failed', 'conflict']),
  error_code: z.string().regex(/^[A-Z][A-Z0-9_]{2,99}$/).optional(),
  updated_at: officialTimestampSchema,
});

const officialRollbackEventSchema = z.strictObject({
  id: officialUUIDSchema,
  event_type: z.enum(['requested', 'approved', 'rejected', 'cancelled', 'expired', 'queued', 'executing', 'reconciling', 'succeeded', 'failed', 'conflict']),
  actor_admin_id: officialUUIDSchema,
  actor_role: officialRoleSchema,
  approval_status: z.enum(['pending_review', 'approved', 'rejected', 'cancelled', 'expired']),
  execution_status: z.enum(['not_started', 'queued', 'executing', 'reconciling', 'succeeded', 'failed', 'conflict']),
  operation_id: officialUUIDSchema.optional(),
  error_code: z.string().regex(/^[A-Z][A-Z0-9_]{2,99}$/).optional(),
  created_at: officialTimestampSchema,
});

export const officialRollbackApprovalSchema = z.strictObject({
  id: officialUUIDSchema,
  release_id: officialUUIDSchema,
  target_version_id: officialUUIDSchema,
  target_release_revision_id: officialUUIDSchema,
  expected_head_revision: z.number().int().positive(),
  target_digest: officialDigestSchema,
  requested_by_admin_id: officialUUIDSchema,
  reviewed_by_admin_id: officialUUIDSchema.optional(),
  reason_code: z.string().regex(/^[a-z][a-z0-9_]{2,63}$/),
  ticket_reference: z.string().max(128).optional(),
  safe_note: z.string().max(500).optional(),
  approval_status: z.enum(['pending_review', 'approved', 'rejected', 'cancelled', 'expired']),
  execution_status: z.enum(['not_started', 'queued', 'executing', 'reconciling', 'succeeded', 'failed', 'conflict']),
  operation_id: officialUUIDSchema.optional(),
  expires_at: officialTimestampSchema,
  reviewed_at: officialTimestampSchema.optional(),
  created_at: officialTimestampSchema,
  updated_at: officialTimestampSchema,
  version: z.number().int().positive(),
  events: z.array(officialRollbackEventSchema).optional(),
});

export const officialAuditEventSchema = z.strictObject({
  event_id: officialUUIDSchema,
  event_type: z.string().regex(/^official_/).max(128),
  object_type: z.string().min(1).max(128),
  object_id: officialUUIDSchema,
  outcome: z.enum(['success', 'denied']),
  reason_code: z.string().regex(/^[a-z][a-z0-9_]{2,63}$/).optional(),
  request_id: z.string().min(1).max(128),
  actor_admin_id: officialUUIDSchema,
  actor_admin_role: officialRoleSchema,
  created_at: officialTimestampSchema,
});

export const officialDefinitionPageSchema = z.strictObject({
  items: z.array(officialDefinitionSchema),
  next_cursor: officialUUIDSchema.optional(),
});
export const officialDraftPageSchema = z.strictObject({
  items: z.array(officialDraftSchema),
  next_cursor: officialUUIDSchema.optional(),
});
export const officialSubmissionPageSchema = z.strictObject({
  items: z.array(officialSubmissionSchema),
  next_cursor: officialUUIDSchema.optional(),
});
export const officialVersionPageSchema = z.strictObject({
  items: z.array(officialVersionSchema),
  next_cursor: officialUUIDSchema.optional(),
});
export const officialReleasePageSchema = z.strictObject({
  items: z.array(officialReleaseSchema),
  next_cursor: officialUUIDSchema.optional(),
});
export const officialRollbackPageSchema = z.strictObject({
  items: z.array(officialRollbackApprovalSchema),
  next_cursor: z.string().regex(/^[A-Za-z0-9_-]{1,512}$/).optional(),
});
export const officialAuditPageSchema = z.strictObject({
  items: z.array(officialAuditEventSchema),
  next_cursor: z.string().max(512).optional(),
});

export type OfficialManifest = z.infer<typeof officialManifestSchema>;
export type OfficialBundle = z.infer<typeof officialBundleSchema>;
export type OfficialDefinition = z.infer<typeof officialDefinitionSchema>;
export type OfficialDraft = z.infer<typeof officialDraftSchema>;
export type OfficialDraftValidation = z.infer<typeof officialDraftValidationSchema>;
export type OfficialSubmission = z.infer<typeof officialSubmissionSchema>;
export type OfficialVersion = z.infer<typeof officialVersionSchema>;
export type OfficialRelease = z.infer<typeof officialReleaseSchema>;
export type OfficialReleaseRevision = OfficialRelease;
export type OfficialOperation = z.infer<typeof officialOperationSchema>;
export type OfficialRollbackApproval = z.infer<typeof officialRollbackApprovalSchema>;
export type OfficialAuditEvent = z.infer<typeof officialAuditEventSchema>;
export type OfficialDefinitionPage = z.infer<typeof officialDefinitionPageSchema>;
export type OfficialDraftPage = z.infer<typeof officialDraftPageSchema>;
export type OfficialSubmissionPage = z.infer<typeof officialSubmissionPageSchema>;
export type OfficialVersionPage = z.infer<typeof officialVersionPageSchema>;
export type OfficialReleasePage = z.infer<typeof officialReleasePageSchema>;
export type OfficialRollbackPage = z.infer<typeof officialRollbackPageSchema>;
export type OfficialAuditPage = z.infer<typeof officialAuditPageSchema>;

export interface OfficialReasonInput {
  reason_code: string;
  ticket_reference: string;
  note: string;
}

export interface OfficialMutationEnvelope<Payload> extends OfficialReasonInput {
  expected_revision: number;
  expected_target_digest?: string;
  payload: Payload;
}

export interface OfficialRollbackInput extends OfficialReasonInput {
  target_version_id: string;
  target_release_revision_id: string;
  expected_head_revision: number;
  target_digest: string;
}
