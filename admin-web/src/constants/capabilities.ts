export const adminRoles = ['super_admin', 'operations_admin', 'publisher', 'finance_admin', 'auditor'] as const;

export type AdminRole = (typeof adminRoles)[number];

export const capabilities = [
  'auth:session',
  'dashboard:read',
  'admins:read',
  'admins:write',
  'content:agents:read',
  'content:agents:write',
  'content:agents:publish',
  'content:categories:read',
  'content:categories:write',
  'content:skills:read',
  'content:skills:write',
  'content:skills:publish',
  'content:plugins:read',
  'content:plugins:write',
  'content:plugins:publish',
  'content:media:read',
  'content:media:write',
  'content:pets:read',
  'content:pets:write',
  'content:pets:publish',
  'content:publish:read',
  'content:publish:execute',
  'users:read',
  'users:write',
  'users:balance:update',
  'ai-resources:read',
  'ai-resources:write',
  'billing:read',
  'billing:write',
  'billing:order:refund',
  'operations:read',
  'operations:write',
  'runtime:read',
  'runtime:command:create',
  'tenants:read',
  'tenants:write',
  'audit:read',
  'system:read',
  'system:write',
  'system:backup:restore',
  'cloud:users:read',
  'cloud:users:write',
  'cloud:devices:write',
  'cloud:sessions:write',
  'official-agents:read',
  'official-agents:draft:write',
  'official-agents:review:write',
  'official-agents:release:write',
  'official-agents:rollback:write'
] as const;

export type Capability = (typeof capabilities)[number];

export const roleCapabilities: Record<AdminRole, readonly Capability[]> = {
  super_admin: [
    ...capabilities.filter(capability => !capability.startsWith('official-agents:')),
    'official-agents:read',
    'official-agents:review:write',
    'official-agents:rollback:write'
  ],
  operations_admin: [
    'auth:session',
    'dashboard:read',
    'users:read',
    'users:write',
    'users:balance:update',
    'ai-resources:read',
    'ai-resources:write',
    'billing:read',
    'operations:read',
    'operations:write',
    'runtime:read',
    'runtime:command:create',
    'tenants:read',
    'tenants:write',
    'audit:read',
    'system:read',
    'cloud:users:read',
    'cloud:users:write',
    'cloud:devices:write',
    'cloud:sessions:write',
    'official-agents:read',
    'official-agents:release:write'
  ],
  publisher: [
    'auth:session',
    'dashboard:read',
    'content:agents:read',
    'content:agents:write',
    'content:agents:publish',
    'content:categories:read',
    'content:categories:write',
    'content:skills:read',
    'content:skills:write',
    'content:skills:publish',
    'content:plugins:read',
    'content:plugins:write',
    'content:plugins:publish',
    'content:media:read',
    'content:media:write',
    'content:pets:read',
    'content:pets:write',
    'content:pets:publish',
    'content:publish:read',
    'content:publish:execute',
    'official-agents:read',
    'official-agents:draft:write'
  ],
  finance_admin: [
    'auth:session',
    'dashboard:read',
    'users:read',
    'billing:read',
    'billing:write',
    'billing:order:refund',
    'audit:read'
  ],
  auditor: [
    'auth:session',
    'dashboard:read',
    'users:read',
    'ai-resources:read',
    'billing:read',
    'operations:read',
    'runtime:read',
    'tenants:read',
    'audit:read',
    'system:read',
    'cloud:users:read',
    'official-agents:read'
  ]
};

export function isAdminRole(value: unknown): value is AdminRole {
  return typeof value === 'string' && adminRoles.includes(value as AdminRole);
}

export function hasCapability(role: AdminRole | '' | undefined, capability: Capability): boolean {
  return isAdminRole(role) && roleCapabilities[role].includes(capability);
}
