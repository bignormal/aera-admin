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
  auditor: ['administrator.read', 'audit.read_full', 'service_health.read'],
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
