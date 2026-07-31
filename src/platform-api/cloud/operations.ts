import type { Capability } from '../../access/capabilities'

// 云上游操作注册表，覆盖 aera-cloud/internal/adminapi 的 /internal/admin/v1 路由。
// kind 决定 BFF 如何构造请求：
// - read：直接转发（POST lookup 透传请求体），JWT 不携带 actor 声明
// - command：包装 admin.Command 信封（operation_id/actor_admin_id/...），Idempotency-Key=operation_id
// - official-read：JWT 携带 actor 声明（admin_id + admin_role，无 operation_id）
// - official-validate：同 official-read，但 POST 且禁止请求体
// - official-mutation：包装 officialMutationEnvelope，JWT 携带 operation_id
// - official-rollback：mutation 基础上追加 approval_id/requester_admin_id（双人复核）
export type CloudOperationKind =
  | 'command'
  | 'official-mutation'
  | 'official-read'
  | 'official-rollback'
  | 'official-validate'
  | 'read'

export type CloudMethod = 'GET' | 'PATCH' | 'POST'

// aera-cloud 的 officialRoleAllowed 强制职责分离：草稿类动作只接受 developer，
// 审核/回滚只接受 super_admin，发布操作只接受 operator。
// 本地 capability 是真正的授权门，此处声明的是云端要求的职责角色。
export type CloudRequiredActorRole = 'developer' | 'operator' | 'super_admin'

export type CloudOperation = {
  capability: Capability
  requiredActorRole?: CloudRequiredActorRole
  kind: CloudOperationKind
  method: CloudMethod
  mutation: boolean
  params?: readonly string[]
  requiresApproval?: boolean
  requiresReauthentication?: boolean
  risk: 'high' | 'important' | 'normal'
  upstreamPath: (params: Record<string, string>) => string
}

function cloudOperation(
  kind: CloudOperationKind,
  method: CloudMethod,
  capability: Capability,
  path: string | ((params: Record<string, string>) => string),
  params: readonly string[] = [],
  options: Pick<
    CloudOperation,
    'requiredActorRole' | 'requiresApproval' | 'requiresReauthentication' | 'risk'
  > = { risk: 'normal' },
): CloudOperation {
  const mutation =
    kind === 'command' || kind === 'official-mutation' || kind === 'official-rollback'
  return {
    capability,
    requiredActorRole: options.requiredActorRole,
    kind,
    method,
    mutation,
    params,
    requiresApproval: options.requiresApproval,
    requiresReauthentication: options.requiresReauthentication,
    risk: options.risk,
    upstreamPath: typeof path === 'string' ? () => path : path,
  }
}

const cloudUsersRead = 'cloud:users:read' as const
const cloudUsersWrite = 'cloud:users:write' as const
const officialRead = 'official-agents:read' as const
const officialDraftWrite = 'official-agents:draft:write' as const
const officialReviewWrite = 'official-agents:review:write' as const
const officialReleaseWrite = 'official-agents:release:write' as const
const userID = ['user_id'] as const
const definitionID = ['definition_id'] as const
const draftID = ['draft_id'] as const
const submissionID = ['submission_id'] as const
const versionID = ['version_id'] as const
const releaseID = ['release_id'] as const

export const cloudOperations = {
  // ---- 平台统计与云用户读 ----
  cloudStats: cloudOperation('read', 'GET', cloudUsersRead, '/stats'),
  cloudDeviceStats: cloudOperation('read', 'GET', cloudUsersRead, '/devices/stats'),
  listCloudUsers: cloudOperation('read', 'GET', cloudUsersRead, '/users'),
  lookupCloudUser: cloudOperation('read', 'POST', cloudUsersRead, '/users/lookup'),
  getCloudUser: cloudOperation(
    'read',
    'GET',
    cloudUsersRead,
    ({ user_id }) => `/users/${user_id}`,
    userID,
  ),
  listCloudUserDevices: cloudOperation(
    'read',
    'GET',
    cloudUsersRead,
    ({ user_id }) => `/users/${user_id}/devices`,
    userID,
  ),
  listCloudUserSessions: cloudOperation(
    'read',
    'GET',
    cloudUsersRead,
    ({ user_id }) => `/users/${user_id}/sessions`,
    userID,
  ),
  getCloudUserMemberships: cloudOperation(
    'read',
    'GET',
    cloudUsersRead,
    ({ user_id }) => `/users/${user_id}/memberships`,
    userID,
  ),
  getCloudOperation: cloudOperation(
    'read',
    'GET',
    cloudUsersRead,
    ({ operation_id }) => `/operations/${operation_id}`,
    ['operation_id'],
  ),

  // ---- 云用户/设备/会话命令 ----
  revokeCloudDevice: cloudOperation(
    'command',
    'POST',
    'cloud:devices:write',
    ({ device_id }) => `/devices/${device_id}/revoke`,
    ['device_id'],
    { risk: 'important' },
  ),
  revokeCloudSession: cloudOperation(
    'command',
    'POST',
    'cloud:sessions:write',
    ({ session_id }) => `/sessions/${session_id}/revoke`,
    ['session_id'],
    { risk: 'important' },
  ),
  revokeAllCloudSessions: cloudOperation(
    'command',
    'POST',
    'cloud:sessions:write',
    ({ user_id }) => `/users/${user_id}/sessions/revoke-all`,
    userID,
    { risk: 'important' },
  ),
  disableCloudUser: cloudOperation(
    'command',
    'POST',
    cloudUsersWrite,
    ({ user_id }) => `/users/${user_id}/disable`,
    userID,
    { requiresApproval: true, risk: 'important' },
  ),
  enableCloudUser: cloudOperation(
    'command',
    'POST',
    cloudUsersWrite,
    ({ user_id }) => `/users/${user_id}/enable`,
    userID,
    { requiresApproval: true, risk: 'important' },
  ),
  resetCloudUserPassword: cloudOperation(
    'command',
    'POST',
    cloudUsersWrite,
    ({ user_id }) => `/users/${user_id}/password/reset`,
    userID,
    { requiresReauthentication: true, risk: 'high' },
  ),

  // ---- 官方 Agent 读 ----
  listOfficialDefinitions: cloudOperation(
    'official-read',
    'GET',
    officialRead,
    '/official-agent-definitions',
  ),
  getOfficialDefinition: cloudOperation(
    'official-read',
    'GET',
    officialRead,
    ({ definition_id }) => `/official-agent-definitions/${definition_id}`,
    definitionID,
  ),
  listOfficialDrafts: cloudOperation(
    'official-read',
    'GET',
    officialRead,
    '/official-agent-drafts',
  ),
  getOfficialDraft: cloudOperation(
    'official-read',
    'GET',
    officialRead,
    ({ draft_id }) => `/official-agent-drafts/${draft_id}`,
    draftID,
  ),
  listOfficialSubmissions: cloudOperation(
    'official-read',
    'GET',
    officialRead,
    '/official-agent-submissions',
  ),
  getOfficialSubmission: cloudOperation(
    'official-read',
    'GET',
    officialRead,
    ({ submission_id }) => `/official-agent-submissions/${submission_id}`,
    submissionID,
  ),
  listOfficialVersions: cloudOperation(
    'official-read',
    'GET',
    officialRead,
    '/official-agent-versions',
  ),
  getOfficialVersion: cloudOperation(
    'official-read',
    'GET',
    officialRead,
    ({ version_id }) => `/official-agent-versions/${version_id}`,
    versionID,
  ),
  listOfficialReleases: cloudOperation(
    'official-read',
    'GET',
    officialRead,
    '/official-agent-releases',
  ),
  getOfficialRelease: cloudOperation(
    'official-read',
    'GET',
    officialRead,
    ({ release_id }) => `/official-agent-releases/${release_id}`,
    releaseID,
  ),
  listOfficialAgentAuditEvents: cloudOperation(
    'official-read',
    'GET',
    officialRead,
    '/official-agent-audit-events',
  ),

  // ---- 官方 Agent 草稿与提交 ----
  validateOfficialDraft: cloudOperation(
    'official-validate',
    'POST',
    officialDraftWrite,
    ({ draft_id }) => `/official-agent-drafts/${draft_id}/validate`,
    draftID,
  ),
  reserveOfficialDefinition: cloudOperation(
    'official-mutation',
    'POST',
    officialDraftWrite,
    '/official-agent-definitions',
    [],
    { requiredActorRole: 'developer', risk: 'normal' },
  ),
  createOfficialDraft: cloudOperation(
    'official-mutation',
    'POST',
    officialDraftWrite,
    '/official-agent-drafts',
    [],
    { requiredActorRole: 'developer', risk: 'normal' },
  ),
  updateOfficialDraft: cloudOperation(
    'official-mutation',
    'PATCH',
    officialDraftWrite,
    ({ draft_id }) => `/official-agent-drafts/${draft_id}`,
    draftID,
    { requiredActorRole: 'developer', risk: 'normal' },
  ),
  submitOfficialDraft: cloudOperation(
    'official-mutation',
    'POST',
    officialDraftWrite,
    ({ draft_id }) => `/official-agent-drafts/${draft_id}/submissions`,
    draftID,
    { requiredActorRole: 'developer', risk: 'normal' },
  ),
  withdrawOfficialSubmission: cloudOperation(
    'official-mutation',
    'POST',
    officialDraftWrite,
    ({ submission_id }) => `/official-agent-submissions/${submission_id}/withdraw`,
    submissionID,
    { requiredActorRole: 'developer', risk: 'normal' },
  ),
  reviewOfficialSubmission: cloudOperation(
    'official-mutation',
    'POST',
    officialReviewWrite,
    ({ submission_id }) => `/official-agent-submissions/${submission_id}/reviews`,
    submissionID,
    { requiredActorRole: 'super_admin', risk: 'important' },
  ),

  // ---- 官方 Agent 发布 ----
  activateOfficialRelease: cloudOperation(
    'official-mutation',
    'POST',
    officialReleaseWrite,
    ({ release_id }) => `/official-agent-releases/${release_id}/activate`,
    releaseID,
    { requiredActorRole: 'operator', risk: 'important' },
  ),
  rolloutOfficialRelease: cloudOperation(
    'official-mutation',
    'POST',
    officialReleaseWrite,
    ({ release_id }) => `/official-agent-releases/${release_id}/rollout`,
    releaseID,
    { requiredActorRole: 'operator', risk: 'important' },
  ),
  pauseOfficialRelease: cloudOperation(
    'official-mutation',
    'POST',
    officialReleaseWrite,
    ({ release_id }) => `/official-agent-releases/${release_id}/pause`,
    releaseID,
    { requiredActorRole: 'operator', risk: 'important' },
  ),
  resumeOfficialRelease: cloudOperation(
    'official-mutation',
    'POST',
    officialReleaseWrite,
    ({ release_id }) => `/official-agent-releases/${release_id}/resume`,
    releaseID,
    { requiredActorRole: 'operator', risk: 'important' },
  ),
  rollbackOfficialRelease: cloudOperation(
    'official-rollback',
    'POST',
    'official-agents:rollback:write',
    ({ release_id }) => `/official-agent-releases/${release_id}/rollback`,
    releaseID,
    { requiredActorRole: 'super_admin', requiresReauthentication: true, risk: 'high' },
  ),
} satisfies Record<string, CloudOperation>

export type CloudOperationKey = keyof typeof cloudOperations

export function isCloudOperationKey(value: string): value is CloudOperationKey {
  return Object.hasOwn(cloudOperations, value)
}
