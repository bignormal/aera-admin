export const roles = [
  'super_admin',
  'developer',
  'operator',
  'support',
  'finance',
  'auditor',
] as const;

export type AdminRole = (typeof roles)[number];

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
  ],
  developer: ['cloud_user.read_technical', 'cloud_device.read', 'service_health.read'],
  operator: [
    'cloud_user.read',
    'cloud_identity.lookup_exact',
    'cloud_device.read',
    'cloud_session.revoke',
    'cloud_device.revoke',
    'account_lifecycle.initiate',
    'audit.read_own',
    'service_health.read',
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
  auditor: ['administrator.read', 'audit.read_full', 'service_health.read', 'system_settings.read'],
};

export function isAdminRole(value: unknown): value is AdminRole {
  return typeof value === 'string' && roles.includes(value as AdminRole);
}

export function hasPermission(role: AdminRole, permission: Permission): boolean {
  return rolePermissions[role]?.includes(permission) ?? false;
}

export function hasAnyPermission(role: AdminRole, required: readonly Permission[]): boolean {
  return required.some((permission) => hasPermission(role, permission));
}

export interface AdministratorPrincipal {
  admin_id: string;
  session_id: string;
  role: AdminRole;
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

export type ReasonCategory = 'administrator' | 'session' | 'device' | 'account' | 'security';
export type ReasonUsage = 'administrator' | 'account' | 'device' | 'session' | 'settings';

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
