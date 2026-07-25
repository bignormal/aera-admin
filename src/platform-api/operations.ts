import type { Capability } from '../access/capabilities'

export type PlatformMethod = 'DELETE' | 'GET' | 'POST' | 'PUT'

export type PlatformOperation = {
  capability: Capability
  method: PlatformMethod
  mutation: boolean
  params?: readonly string[]
  requiresReauthentication?: boolean
  risk: 'high' | 'important' | 'normal'
  upstreamPath: (params: Record<string, string>) => string
}

function operation(
  method: PlatformMethod,
  capability: Capability,
  path: string | ((params: Record<string, string>) => string),
  params: readonly string[] = [],
  options: Pick<PlatformOperation, 'requiresReauthentication' | 'risk'> = { risk: 'normal' },
): PlatformOperation {
  return {
    capability,
    method,
    mutation: method !== 'GET',
    params,
    requiresReauthentication: options.requiresReauthentication,
    risk: options.risk,
    upstreamPath: typeof path === 'string' ? () => path : path,
  }
}

const usersRead = 'users:read' as const
const usersWrite = 'users:write' as const
const aiRead = 'ai-resources:read' as const
const aiWrite = 'ai-resources:write' as const
const id = ['id'] as const
const userID = ['user_id'] as const
const cleanupTaskID = ['id'] as const

export const platformOperations = {
  listUsers: operation('GET', usersRead, '/admin/users'),
  getUser: operation('GET', usersRead, ({ id }) => `/admin/users/${id}`, id),
  createUser: operation('POST', usersWrite, '/admin/users'),
  updateUser: operation('PUT', usersWrite, ({ id }) => `/admin/users/${id}`, id),
  updateUserBalance: operation(
    'POST',
    'users:balance:update',
    ({ id }) => `/admin/users/${id}/balance`,
    id,
  ),
  listUserAPIKeys: operation('GET', usersRead, ({ id }) => `/admin/users/${id}/api-keys`, id),
  getUserUsage: operation('GET', usersRead, ({ id }) => `/admin/users/${id}/usage`, id),
  getUserBalanceHistory: operation(
    'GET',
    usersRead,
    ({ id }) => `/admin/users/${id}/balance-history`,
    id,
  ),
  replaceUserGroup: operation(
    'POST',
    usersWrite,
    ({ id }) => `/admin/users/${id}/replace-group`,
    id,
  ),
  getUserRPMStatus: operation('GET', usersRead, ({ id }) => `/admin/users/${id}/rpm-status`, id),
  batchUpdateUserConcurrency: operation('POST', usersWrite, '/admin/users/batch-concurrency'),
  getUserPlatformQuotas: operation(
    'GET',
    usersRead,
    ({ id }) => `/admin/users/${id}/platform-quotas`,
    id,
  ),
  updateUserPlatformQuotas: operation(
    'PUT',
    usersWrite,
    ({ id }) => `/admin/users/${id}/platform-quotas`,
    id,
  ),
  resetUserPlatformQuotas: operation(
    'POST',
    usersWrite,
    ({ id }) => `/admin/users/${id}/platform-quotas/reset`,
    id,
  ),
  getUserAttributes: operation('GET', usersRead, ({ id }) => `/admin/users/${id}/attributes`, id),
  updateUserAttributes: operation(
    'PUT',
    usersWrite,
    ({ id }) => `/admin/users/${id}/attributes`,
    id,
  ),
  listUserSubscriptions: operation(
    'GET',
    usersRead,
    ({ id }) => `/admin/users/${id}/subscriptions`,
    id,
  ),

  listUserAttributeDefinitions: operation('GET', usersRead, '/admin/user-attributes'),
  createUserAttributeDefinition: operation('POST', usersWrite, '/admin/user-attributes'),
  updateUserAttributeDefinition: operation(
    'PUT',
    usersWrite,
    ({ id }) => `/admin/user-attributes/${id}`,
    id,
  ),
  deleteUserAttributeDefinition: operation(
    'DELETE',
    usersWrite,
    ({ id }) => `/admin/user-attributes/${id}`,
    id,
  ),
  reorderUserAttributeDefinitions: operation('PUT', usersWrite, '/admin/user-attributes/reorder'),

  listGroups: operation('GET', aiRead, '/admin/groups'),
  listAllGroups: operation('GET', aiRead, '/admin/groups/all'),
  getGroup: operation('GET', aiRead, ({ id }) => `/admin/groups/${id}`, id),
  createGroup: operation('POST', aiWrite, '/admin/groups'),
  updateGroup: operation('PUT', aiWrite, ({ id }) => `/admin/groups/${id}`, id),
  deleteGroup: operation('DELETE', aiWrite, ({ id }) => `/admin/groups/${id}`, id),
  getGroupStats: operation('GET', aiRead, ({ id }) => `/admin/groups/${id}/stats`, id),
  getGroupModelsListCandidates: operation(
    'GET',
    aiRead,
    ({ id }) => `/admin/groups/${id}/models-list-candidates`,
    id,
  ),
  getGroupRateMultipliers: operation(
    'GET',
    aiRead,
    ({ id }) => `/admin/groups/${id}/rate-multipliers`,
    id,
  ),
  updateGroupRateMultipliers: operation(
    'PUT',
    aiWrite,
    ({ id }) => `/admin/groups/${id}/rate-multipliers`,
    id,
  ),
  clearGroupRateMultipliers: operation(
    'DELETE',
    aiWrite,
    ({ id }) => `/admin/groups/${id}/rate-multipliers`,
    id,
  ),
  updateGroupRPMOverrides: operation(
    'PUT',
    aiWrite,
    ({ id }) => `/admin/groups/${id}/rpm-overrides`,
    id,
  ),
  clearGroupRPMOverrides: operation(
    'DELETE',
    aiWrite,
    ({ id }) => `/admin/groups/${id}/rpm-overrides`,
    id,
  ),
  updateGroupSortOrder: operation('PUT', aiWrite, '/admin/groups/sort-order'),
  getGroupUsageSummary: operation('GET', aiRead, '/admin/groups/usage-summary'),
  getGroupCapacitySummary: operation('GET', aiRead, '/admin/groups/capacity-summary'),

  listAccounts: operation('GET', aiRead, '/admin/accounts'),
  getAccount: operation('GET', aiRead, ({ id }) => `/admin/accounts/${id}`, id),
  createAccount: operation('POST', aiWrite, '/admin/accounts'),
  updateAccount: operation('PUT', aiWrite, ({ id }) => `/admin/accounts/${id}`, id),
  deleteAccount: operation('DELETE', aiWrite, ({ id }) => `/admin/accounts/${id}`, id),
  testAccount: operation('POST', aiWrite, ({ id }) => `/admin/accounts/${id}/test`, id),
  refreshAccount: operation('POST', aiWrite, ({ id }) => `/admin/accounts/${id}/refresh`, id),
  recoverAccountState: operation(
    'POST',
    aiWrite,
    ({ id }) => `/admin/accounts/${id}/recover-state`,
    id,
  ),
  clearAccountError: operation(
    'POST',
    aiWrite,
    ({ id }) => `/admin/accounts/${id}/clear-error`,
    id,
  ),
  clearAccountRateLimit: operation(
    'POST',
    aiWrite,
    ({ id }) => `/admin/accounts/${id}/clear-rate-limit`,
    id,
  ),
  getAccountStats: operation('GET', aiRead, ({ id }) => `/admin/accounts/${id}/stats`, id),
  getAccountUsage: operation('GET', aiRead, ({ id }) => `/admin/accounts/${id}/usage`, id),
  getAccountTodayStats: operation(
    'GET',
    aiRead,
    ({ id }) => `/admin/accounts/${id}/today-stats`,
    id,
  ),
  getAccountModels: operation('GET', aiRead, ({ id }) => `/admin/accounts/${id}/models`, id),
  syncAccountModels: operation(
    'POST',
    aiWrite,
    ({ id }) => `/admin/accounts/${id}/models/sync-upstream`,
    id,
  ),
  resetAccountQuota: operation(
    'POST',
    aiWrite,
    ({ id }) => `/admin/accounts/${id}/reset-quota`,
    id,
  ),

  listProxies: operation('GET', aiRead, '/admin/proxies'),
  listAllProxies: operation('GET', aiRead, '/admin/proxies/all'),
  getProxy: operation('GET', aiRead, ({ id }) => `/admin/proxies/${id}`, id),
  createProxy: operation('POST', aiWrite, '/admin/proxies'),
  updateProxy: operation('PUT', aiWrite, ({ id }) => `/admin/proxies/${id}`, id),
  deleteProxy: operation('DELETE', aiWrite, ({ id }) => `/admin/proxies/${id}`, id),
  testProxy: operation('POST', aiWrite, ({ id }) => `/admin/proxies/${id}/test`, id),
  checkProxyQuality: operation(
    'POST',
    aiWrite,
    ({ id }) => `/admin/proxies/${id}/quality-check`,
    id,
  ),
  getProxyStats: operation('GET', aiRead, ({ id }) => `/admin/proxies/${id}/stats`, id),
  getProxyAccounts: operation('GET', aiRead, ({ id }) => `/admin/proxies/${id}/accounts`, id),

  listChannels: operation('GET', aiRead, '/admin/channels'),
  getChannel: operation('GET', aiRead, ({ id }) => `/admin/channels/${id}`, id),
  createChannel: operation('POST', aiWrite, '/admin/channels'),
  updateChannel: operation('PUT', aiWrite, ({ id }) => `/admin/channels/${id}`, id),
  deleteChannel: operation('DELETE', aiWrite, ({ id }) => `/admin/channels/${id}`, id),
  getChannelModelPricing: operation('GET', aiRead, '/admin/channels/model-pricing'),
  getChannelPricingModels: operation('GET', aiRead, '/admin/channels/pricing/sync-models'),

  listChannelMonitors: operation('GET', aiRead, '/admin/channel-monitors'),
  getChannelMonitor: operation('GET', aiRead, ({ id }) => `/admin/channel-monitors/${id}`, id),
  createChannelMonitor: operation('POST', aiWrite, '/admin/channel-monitors'),
  updateChannelMonitor: operation('PUT', aiWrite, ({ id }) => `/admin/channel-monitors/${id}`, id),
  deleteChannelMonitor: operation(
    'DELETE',
    aiWrite,
    ({ id }) => `/admin/channel-monitors/${id}`,
    id,
  ),
  runChannelMonitor: operation(
    'POST',
    aiWrite,
    ({ id }) => `/admin/channel-monitors/${id}/run`,
    id,
  ),
  getChannelMonitorHistory: operation(
    'GET',
    aiRead,
    ({ id }) => `/admin/channel-monitors/${id}/history`,
    id,
  ),
  listChannelMonitorTemplates: operation('GET', aiRead, '/admin/channel-monitor-templates'),
  getChannelMonitorTemplate: operation(
    'GET',
    aiRead,
    ({ id }) => `/admin/channel-monitor-templates/${id}`,
    id,
  ),
  createChannelMonitorTemplate: operation('POST', aiWrite, '/admin/channel-monitor-templates'),
  updateChannelMonitorTemplate: operation(
    'PUT',
    aiWrite,
    ({ id }) => `/admin/channel-monitor-templates/${id}`,
    id,
  ),
  deleteChannelMonitorTemplate: operation(
    'DELETE',
    aiWrite,
    ({ id }) => `/admin/channel-monitor-templates/${id}`,
    id,
  ),
  applyChannelMonitorTemplate: operation(
    'POST',
    aiWrite,
    ({ id }) => `/admin/channel-monitor-templates/${id}/apply`,
    id,
  ),

  listScheduledTests: operation(
    'GET',
    aiRead,
    ({ id }) => `/admin/accounts/${id}/scheduled-test-plans`,
    id,
  ),
  createScheduledTest: operation('POST', aiWrite, '/admin/scheduled-test-plans'),
  updateScheduledTest: operation(
    'PUT',
    aiWrite,
    ({ id }) => `/admin/scheduled-test-plans/${id}`,
    id,
  ),
  deleteScheduledTest: operation(
    'DELETE',
    aiWrite,
    ({ id }) => `/admin/scheduled-test-plans/${id}`,
    id,
  ),
  getScheduledTestResults: operation(
    'GET',
    aiRead,
    ({ id }) => `/admin/scheduled-test-plans/${id}/results`,
    id,
  ),

  listTLSProfiles: operation('GET', aiRead, '/admin/tls-fingerprint-profiles'),
  getTLSProfile: operation('GET', aiRead, ({ id }) => `/admin/tls-fingerprint-profiles/${id}`, id),
  createTLSProfile: operation('POST', aiWrite, '/admin/tls-fingerprint-profiles'),
  updateTLSProfile: operation(
    'PUT',
    aiWrite,
    ({ id }) => `/admin/tls-fingerprint-profiles/${id}`,
    id,
  ),
  deleteTLSProfile: operation(
    'DELETE',
    aiWrite,
    ({ id }) => `/admin/tls-fingerprint-profiles/${id}`,
    id,
  ),

  listErrorRules: operation('GET', aiRead, '/admin/error-passthrough-rules'),
  getErrorRule: operation('GET', aiRead, ({ id }) => `/admin/error-passthrough-rules/${id}`, id),
  createErrorRule: operation('POST', aiWrite, '/admin/error-passthrough-rules'),
  updateErrorRule: operation(
    'PUT',
    aiWrite,
    ({ id }) => `/admin/error-passthrough-rules/${id}`,
    id,
  ),
  deleteErrorRule: operation(
    'DELETE',
    aiWrite,
    ({ id }) => `/admin/error-passthrough-rules/${id}`,
    id,
  ),

  getPaymentDashboard: operation('GET', 'billing:read', '/admin/payment/dashboard'),
  getPaymentConfig: operation('GET', 'billing:read', '/admin/payment/config'),
  updatePaymentConfig: operation('PUT', 'billing:write', '/admin/payment/config', [], {
    requiresReauthentication: true,
    risk: 'high',
  }),
  listPaymentOrders: operation('GET', 'billing:read', '/admin/payment/orders'),
  getPaymentOrder: operation('GET', 'billing:read', ({ id }) => `/admin/payment/orders/${id}`, id),
  cancelPaymentOrder: operation(
    'POST',
    'billing:write',
    ({ id }) => `/admin/payment/orders/${id}/cancel`,
    id,
    { risk: 'important' },
  ),
  retryPaymentOrder: operation(
    'POST',
    'billing:write',
    ({ id }) => `/admin/payment/orders/${id}/retry`,
    id,
    { risk: 'important' },
  ),
  processRefund: operation(
    'POST',
    'billing:order:refund',
    ({ id }) => `/admin/payment/orders/${id}/refund`,
    id,
    { requiresReauthentication: true, risk: 'high' },
  ),
  queryPaymentRefund: operation(
    'POST',
    'billing:order:refund',
    ({ id }) => `/admin/payment/orders/${id}/refund/query`,
    id,
    { requiresReauthentication: true, risk: 'high' },
  ),
  listPaymentPlans: operation('GET', 'billing:read', '/admin/payment/plans'),
  createPaymentPlan: operation('POST', 'billing:write', '/admin/payment/plans', [], {
    risk: 'important',
  }),
  updatePaymentPlan: operation(
    'PUT',
    'billing:write',
    ({ id }) => `/admin/payment/plans/${id}`,
    id,
    { risk: 'important' },
  ),
  deletePaymentPlan: operation(
    'DELETE',
    'billing:write',
    ({ id }) => `/admin/payment/plans/${id}`,
    id,
    { risk: 'important' },
  ),
  listPaymentProviders: operation('GET', 'billing:read', '/admin/payment/providers'),
  createPaymentProvider: operation('POST', 'billing:write', '/admin/payment/providers', [], {
    requiresReauthentication: true,
    risk: 'high',
  }),
  updatePaymentProvider: operation(
    'PUT',
    'billing:write',
    ({ id }) => `/admin/payment/providers/${id}`,
    id,
    { requiresReauthentication: true, risk: 'high' },
  ),
  deletePaymentProvider: operation(
    'DELETE',
    'billing:write',
    ({ id }) => `/admin/payment/providers/${id}`,
    id,
    { requiresReauthentication: true, risk: 'high' },
  ),

  listSubscriptions: operation('GET', 'billing:read', '/admin/subscriptions'),
  getSubscription: operation('GET', 'billing:read', ({ id }) => `/admin/subscriptions/${id}`, id),
  getSubscriptionProgress: operation(
    'GET',
    'billing:read',
    ({ id }) => `/admin/subscriptions/${id}/progress`,
    id,
  ),
  assignSubscription: operation('POST', 'billing:write', '/admin/subscriptions/assign', [], {
    risk: 'important',
  }),
  extendSubscription: operation(
    'POST',
    'billing:write',
    ({ id }) => `/admin/subscriptions/${id}/extend`,
    id,
    { risk: 'important' },
  ),
  resetSubscriptionQuota: operation(
    'POST',
    'billing:write',
    ({ id }) => `/admin/subscriptions/${id}/reset-quota`,
    id,
    { risk: 'important' },
  ),
  revokeSubscription: operation(
    'POST',
    'billing:write',
    ({ id }) => `/admin/subscriptions/${id}/revoke`,
    id,
    { risk: 'important' },
  ),
  restoreSubscription: operation(
    'POST',
    'billing:write',
    ({ id }) => `/admin/subscriptions/${id}/restore`,
    id,
    { risk: 'important' },
  ),

  listRedeemCodes: operation('GET', 'billing:read', '/admin/redeem-codes'),
  getRedeemCodeStats: operation('GET', 'billing:read', '/admin/redeem-codes/stats'),
  exportRedeemCodes: operation('GET', 'billing:read', '/admin/redeem-codes/export'),
  generateRedeemCodes: operation('POST', 'billing:write', '/admin/redeem-codes/generate', [], {
    risk: 'important',
  }),
  expireRedeemCode: operation(
    'POST',
    'billing:write',
    ({ id }) => `/admin/redeem-codes/${id}/expire`,
    id,
    { risk: 'important' },
  ),
  deleteRedeemCode: operation(
    'DELETE',
    'billing:write',
    ({ id }) => `/admin/redeem-codes/${id}`,
    id,
    { risk: 'important' },
  ),
  listPromoCodes: operation('GET', 'billing:read', '/admin/promo-codes'),
  createPromoCode: operation('POST', 'billing:write', '/admin/promo-codes'),
  updatePromoCode: operation('PUT', 'billing:write', ({ id }) => `/admin/promo-codes/${id}`, id),
  deletePromoCode: operation(
    'DELETE',
    'billing:write',
    ({ id }) => `/admin/promo-codes/${id}`,
    id,
  ),
  getPromoCodeUsages: operation(
    'GET',
    'billing:read',
    ({ id }) => `/admin/promo-codes/${id}/usages`,
    id,
  ),
  listAffiliateUsers: operation('GET', 'billing:read', '/admin/affiliates/users'),
  listAffiliateInvites: operation('GET', 'billing:read', '/admin/affiliates/invites'),
  listAffiliateRebates: operation('GET', 'billing:read', '/admin/affiliates/rebates'),
  listAffiliateTransfers: operation('GET', 'billing:read', '/admin/affiliates/transfers'),
  updateAffiliateUser: operation(
    'PUT',
    'billing:write',
    ({ user_id }) => `/admin/affiliates/users/${user_id}`,
    userID,
  ),
  clearAffiliateUser: operation(
    'DELETE',
    'billing:write',
    ({ user_id }) => `/admin/affiliates/users/${user_id}`,
    userID,
  ),

  listAnnouncements: operation('GET', 'operations:read', '/admin/announcements'),
  getAnnouncement: operation(
    'GET',
    'operations:read',
    ({ id }) => `/admin/announcements/${id}`,
    id,
  ),
  createAnnouncement: operation('POST', 'operations:write', '/admin/announcements'),
  updateAnnouncement: operation(
    'PUT',
    'operations:write',
    ({ id }) => `/admin/announcements/${id}`,
    id,
  ),
  deleteAnnouncement: operation(
    'DELETE',
    'operations:write',
    ({ id }) => `/admin/announcements/${id}`,
    id,
  ),

  getOpsConcurrency: operation('GET', 'operations:read', '/admin/ops/concurrency'),
  getOpsUserConcurrency: operation('GET', 'operations:read', '/admin/ops/user-concurrency'),
  getOpsAccountAvailability: operation('GET', 'operations:read', '/admin/ops/account-availability'),
  getOpsRealtimeTraffic: operation('GET', 'operations:read', '/admin/ops/realtime-traffic'),
  getOpsDashboardSnapshot: operation('GET', 'operations:read', '/admin/ops/dashboard/snapshot-v2'),
  getOpsDashboardOverview: operation('GET', 'operations:read', '/admin/ops/dashboard/overview'),
  getOpsThroughputTrend: operation('GET', 'operations:read', '/admin/ops/dashboard/throughput-trend'),
  getOpsLatencyHistogram: operation('GET', 'operations:read', '/admin/ops/dashboard/latency-histogram'),
  getOpsErrorTrend: operation('GET', 'operations:read', '/admin/ops/dashboard/error-trend'),
  getOpsErrorDistribution: operation('GET', 'operations:read', '/admin/ops/dashboard/error-distribution'),

  listAlertRules: operation('GET', 'operations:read', '/admin/ops/alert-rules'),
  createAlertRule: operation('POST', 'operations:write', '/admin/ops/alert-rules'),
  updateAlertRule: operation('PUT', 'operations:write', ({ id }) => `/admin/ops/alert-rules/${id}`, id),
  deleteAlertRule: operation('DELETE', 'operations:write', ({ id }) => `/admin/ops/alert-rules/${id}`, id),
  listAlertEvents: operation('GET', 'operations:read', '/admin/ops/alert-events'),
  getAlertEvent: operation('GET', 'operations:read', ({ id }) => `/admin/ops/alert-events/${id}`, id),
  updateAlertEventStatus: operation(
    'PUT',
    'operations:write',
    ({ id }) => `/admin/ops/alert-events/${id}/status`,
    id,
  ),
  createAlertSilence: operation('POST', 'operations:write', '/admin/ops/alert-silences'),

  listRequestErrors: operation('GET', 'operations:read', '/admin/ops/request-errors'),
  getRequestError: operation('GET', 'operations:read', ({ id }) => `/admin/ops/request-errors/${id}`, id),
  resolveRequestError: operation(
    'PUT',
    'operations:write',
    ({ id }) => `/admin/ops/request-errors/${id}/resolve`,
    id,
  ),
  listUpstreamErrors: operation('GET', 'operations:read', '/admin/ops/upstream-errors'),
  getUpstreamError: operation('GET', 'operations:read', ({ id }) => `/admin/ops/upstream-errors/${id}`, id),
  resolveUpstreamError: operation(
    'PUT',
    'operations:write',
    ({ id }) => `/admin/ops/upstream-errors/${id}/resolve`,
    id,
  ),
  listRequestDetails: operation('GET', 'operations:read', '/admin/ops/requests'),
  listSystemLogs: operation('GET', 'operations:read', '/admin/ops/system-logs'),
  cleanupSystemLogs: operation('POST', 'operations:write', '/admin/ops/system-logs/cleanup', [], {
    risk: 'important',
  }),
  getSystemLogHealth: operation('GET', 'operations:read', '/admin/ops/system-logs/health'),

  getRiskConfig: operation('GET', 'operations:read', '/admin/risk-control/config'),
  updateRiskConfig: operation('PUT', 'operations:write', '/admin/risk-control/config', [], {
    risk: 'important',
  }),
  getRiskStatus: operation('GET', 'operations:read', '/admin/risk-control/status'),
  listRiskLogs: operation('GET', 'operations:read', '/admin/risk-control/logs'),
  unbanRiskUser: operation(
    'POST',
    'operations:write',
    ({ user_id }) => `/admin/risk-control/users/${user_id}/unban`,
    userID,
    { risk: 'important' },
  ),
  deleteRiskHash: operation('DELETE', 'operations:write', '/admin/risk-control/hashes', [], {
    risk: 'important',
  }),
  clearRiskHashes: operation('DELETE', 'operations:write', '/admin/risk-control/hashes/all', [], {
    risk: 'important',
  }),

  listUsage: operation('GET', 'operations:read', '/admin/usage'),
  getUsageStats: operation('GET', 'operations:read', '/admin/usage/stats'),
  listUsageCleanupTasks: operation('GET', 'operations:read', '/admin/usage/cleanup-tasks'),
  createUsageCleanupTask: operation('POST', 'operations:write', '/admin/usage/cleanup-tasks', [], {
    risk: 'important',
  }),
  cancelUsageCleanupTask: operation(
    'POST',
    'operations:write',
    ({ id }) => `/admin/usage/cleanup-tasks/${id}/cancel`,
    cleanupTaskID,
  ),

  getDataAgentHealth: operation('GET', 'system:read', '/admin/data-management/agent/health'),
  getDataManagementConfig: operation('GET', 'system:read', '/admin/data-management/config'),
  updateDataManagementConfig: operation('PUT', 'system:write', '/admin/data-management/config', [], {
    risk: 'important',
  }),
  listDataBackupJobs: operation('GET', 'system:read', '/admin/data-management/backups'),
  createDataBackupJob: operation('POST', 'system:write', '/admin/data-management/backups', [], {
    risk: 'important',
  }),

  listBackups: operation('GET', 'system:read', '/admin/backups'),
  createBackup: operation('POST', 'system:write', '/admin/backups', [], { risk: 'important' }),
  getBackup: operation('GET', 'system:read', ({ id }) => `/admin/backups/${id}`, id),
  deleteBackup: operation('DELETE', 'system:write', ({ id }) => `/admin/backups/${id}`, id, {
    risk: 'important',
  }),
  getBackupDownloadURL: operation(
    'GET',
    'system:read',
    ({ id }) => `/admin/backups/${id}/download-url`,
    id,
  ),
  getBackupSchedule: operation('GET', 'system:read', '/admin/backups/schedule'),
  updateBackupSchedule: operation('PUT', 'system:write', '/admin/backups/schedule', [], {
    risk: 'important',
  }),
  restoreBackup: operation(
    'POST',
    'system:backup:restore',
    ({ id }) => `/admin/backups/${id}/restore`,
    id,
    { requiresReauthentication: true, risk: 'high' },
  ),

  getSystemSettings: operation('GET', 'system:read', '/admin/settings'),
  updateSystemSettings: operation('PUT', 'system:write', '/admin/settings', [], { risk: 'important' }),
  getAdminAPIKeyStatus: operation('GET', 'system:read', '/admin/settings/admin-api-key'),
  regenerateAdminAPIKey: operation(
    'POST',
    'system:write',
    '/admin/settings/admin-api-key/regenerate',
    [],
    { requiresReauthentication: true, risk: 'high' },
  ),
  deleteAdminAPIKey: operation(
    'DELETE',
    'system:write',
    '/admin/settings/admin-api-key',
    [],
    { requiresReauthentication: true, risk: 'high' },
  ),
  getSystemVersion: operation('GET', 'system:read', '/admin/system/version'),
  checkSystemUpdates: operation('GET', 'system:read', '/admin/system/check-updates'),
  performSystemUpdate: operation('POST', 'system:write', '/admin/system/update', [], {
    requiresReauthentication: true,
    risk: 'high',
  }),
  rollbackSystem: operation('POST', 'system:write', '/admin/system/rollback', [], {
    requiresReauthentication: true,
    risk: 'high',
  }),
  restartSystem: operation('POST', 'system:write', '/admin/system/restart', [], {
    requiresReauthentication: true,
    risk: 'high',
  }),
} satisfies Record<string, PlatformOperation>

export type PlatformOperationKey = keyof typeof platformOperations

export function isPlatformOperationKey(value: string): value is PlatformOperationKey {
  return Object.hasOwn(platformOperations, value)
}
