import type { platformOperations } from './operations'

export type PlatformReadProbeKey =
  | 'accounts'
  | 'alerts'
  | 'billing'
  | 'channels'
  | 'groups'
  | 'operations'
  | 'orders'
  | 'proxies'
  | 'risk'
  | 'subscriptions'
  | 'system'
  | 'usage'
  | 'users'

export type PlatformReadProbe = {
  key: PlatformReadProbeKey
  label: string
  operation: keyof typeof platformOperations
  query?: Readonly<Record<string, string>>
  shape: 'array' | 'page' | 'record'
}

export const platformReadProbes: readonly PlatformReadProbe[] = [
  {
    key: 'users',
    label: '平台用户',
    operation: 'listUsers',
    query: { page: '1', page_size: '1' },
    shape: 'page',
  },
  {
    key: 'accounts',
    label: 'AI 账号',
    operation: 'listAccounts',
    query: { page: '1', page_size: '1' },
    shape: 'page',
  },
  {
    key: 'groups',
    label: '资源分组',
    operation: 'listGroups',
    query: { page: '1', page_size: '1' },
    shape: 'page',
  },
  {
    key: 'proxies',
    label: '代理资源',
    operation: 'listProxies',
    query: { page: '1', page_size: '1' },
    shape: 'page',
  },
  {
    key: 'channels',
    label: '模型渠道',
    operation: 'listChannels',
    query: { page: '1', page_size: '1' },
    shape: 'page',
  },
  { key: 'billing', label: '商业总览', operation: 'getPaymentDashboard', shape: 'record' },
  {
    key: 'orders',
    label: '支付订单',
    operation: 'listPaymentOrders',
    query: { page: '1', page_size: '1' },
    shape: 'page',
  },
  {
    key: 'subscriptions',
    label: '订阅',
    operation: 'listSubscriptions',
    query: { page: '1', page_size: '1' },
    shape: 'page',
  },
  {
    key: 'operations',
    label: '运营总览',
    operation: 'getOpsDashboardOverview',
    shape: 'record',
  },
  {
    key: 'alerts',
    label: '告警事件',
    operation: 'listAlertEvents',
    query: { limit: '1' },
    shape: 'array',
  },
  { key: 'risk', label: '风险状态', operation: 'getRiskStatus', shape: 'record' },
  {
    key: 'usage',
    label: '用量日志',
    operation: 'listUsage',
    query: { page: '1', page_size: '1' },
    shape: 'page',
  },
  { key: 'system', label: '系统版本', operation: 'getSystemVersion', shape: 'record' },
] as const
