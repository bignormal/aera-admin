import type { ResourceID, PayloadPage, ResourceQuery } from './resources';
import { callPlatform } from './platform';
import { asResourceRecord, normalizeUpstreamArray, normalizeUpstreamPage, unwrapUpstream } from './upstream-contract';

export type AIResourceKind =
  | 'accounts'
  | 'channels'
  | 'errorRules'
  | 'groups'
  | 'monitorTemplates'
  | 'monitors'
  | 'proxies'
  | 'tlsProfiles';

export type AIResource = { id: ResourceID; name?: string; [key: string]: unknown };

type ResourceOperations = {
  create: string;
  delete: string;
  list: string;
  listShape: 'array' | 'page';
  update: string;
};

const operations: Record<AIResourceKind, ResourceOperations> = {
  accounts: {
    list: 'listAccounts',
    listShape: 'page',
    create: 'createAccount',
    update: 'updateAccount',
    delete: 'deleteAccount'
  },
  channels: {
    list: 'listChannels',
    listShape: 'page',
    create: 'createChannel',
    update: 'updateChannel',
    delete: 'deleteChannel'
  },
  errorRules: {
    list: 'listErrorRules',
    listShape: 'array',
    create: 'createErrorRule',
    update: 'updateErrorRule',
    delete: 'deleteErrorRule'
  },
  groups: {
    list: 'listGroups',
    listShape: 'page',
    create: 'createGroup',
    update: 'updateGroup',
    delete: 'deleteGroup'
  },
  monitorTemplates: {
    list: 'listChannelMonitorTemplates',
    listShape: 'page',
    create: 'createChannelMonitorTemplate',
    update: 'updateChannelMonitorTemplate',
    delete: 'deleteChannelMonitorTemplate'
  },
  monitors: {
    list: 'listChannelMonitors',
    listShape: 'page',
    create: 'createChannelMonitor',
    update: 'updateChannelMonitor',
    delete: 'deleteChannelMonitor'
  },
  proxies: {
    list: 'listProxies',
    listShape: 'page',
    create: 'createProxy',
    update: 'updateProxy',
    delete: 'deleteProxy'
  },
  tlsProfiles: {
    list: 'listTLSProfiles',
    listShape: 'array',
    create: 'createTLSProfile',
    update: 'updateTLSProfile',
    delete: 'deleteTLSProfile'
  }
};

const secretKey = /^(access_token|refresh_token|client_secret|client_key|api_key|password|proxy_password|secret)$/i;

function sanitize<T>(value: T): T {
  if (Array.isArray(value)) return value.map(item => sanitize(item)) as T;
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, secretKey.test(key) ? '[REDACTED]' : sanitize(item)])
  ) as T;
}

function parseAIResource<T extends AIResource = AIResource>(value: unknown): T {
  return sanitize(asResourceRecord(value)) as T;
}

function upstreamSort(value?: string): string {
  return (value || 'created_at').replace(/^-/, '').replace(/[A-Z]/g, letter => `_${letter.toLowerCase()}`);
}

export async function listAIResources<T extends AIResource = AIResource>(
  kind: AIResourceKind,
  query: ResourceQuery,
  signal?: AbortSignal
): Promise<PayloadPage<T>> {
  const descending = query.sort?.startsWith('-') ?? false;
  const operation = operations[kind];
  const result = await callPlatform<unknown>(operation.list, {
    params: {
      page: query.page,
      page_size: query.limit,
      search: query.search?.trim(),
      sort_by: upstreamSort(query.sort),
      sort_order: descending ? 'desc' : 'asc'
    },
    signal
  });
  const data = unwrapUpstream(result.data);
  return operation.listShape === 'array'
    ? normalizeUpstreamArray(data, query, parseAIResource<T>)
    : normalizeUpstreamPage(data, query, parseAIResource<T>);
}

export async function createAIResource<T extends AIResource = AIResource>(
  kind: AIResourceKind,
  input: Record<string, unknown>
): Promise<T> {
  const result = await callPlatform<unknown>(operations[kind].create, { body: input, method: 'POST' });
  return parseAIResource<T>(unwrapUpstream(result.data));
}

export async function updateAIResource<T extends AIResource = AIResource>(
  kind: AIResourceKind,
  id: ResourceID,
  input: Record<string, unknown>
): Promise<T> {
  const result = await callPlatform<unknown>(operations[kind].update, {
    body: input,
    method: 'PUT',
    params: { id }
  });
  return parseAIResource<T>(unwrapUpstream(result.data));
}

export async function deleteAIResource(kind: AIResourceKind, id: ResourceID): Promise<unknown> {
  const result = await callPlatform<unknown>(operations[kind].delete, {
    method: 'DELETE',
    params: { id }
  });
  return sanitize(unwrapUpstream(result.data));
}

async function groupAction(operation: string, id: ResourceID, options: { body?: unknown; method?: 'DELETE' | 'GET' | 'POST' | 'PUT' } = {}) {
  const result = await callPlatform<unknown>(operation, {
    body: options.body,
    method: options.method || 'GET',
    params: { id }
  });
  return sanitize(unwrapUpstream(result.data));
}

export const getGroupStats = (id: ResourceID) => groupAction('getGroupStats', id);
export const getGroupRateMultipliers = (id: ResourceID) => groupAction('getGroupRateMultipliers', id);
export const updateGroupRateMultipliers = (id: ResourceID, body: Record<string, unknown>) =>
  groupAction('updateGroupRateMultipliers', id, { body, method: 'PUT' });
export const clearGroupRateMultipliers = (id: ResourceID) =>
  groupAction('clearGroupRateMultipliers', id, { method: 'DELETE' });
export const updateGroupRPMOverrides = (id: ResourceID, body: Record<string, unknown>) =>
  groupAction('updateGroupRPMOverrides', id, { body, method: 'PUT' });
export const clearGroupRPMOverrides = (id: ResourceID) =>
  groupAction('clearGroupRPMOverrides', id, { method: 'DELETE' });

export type AIResourceAction =
  | 'applyChannelMonitorTemplate'
  | 'checkProxyQuality'
  | 'clearAccountError'
  | 'clearAccountRateLimit'
  | 'recoverAccountState'
  | 'refreshAccount'
  | 'resetAccountQuota'
  | 'runChannelMonitor'
  | 'testAccount'
  | 'testProxy';

export async function runAIResourceAction(operation: AIResourceAction, id: ResourceID): Promise<unknown> {
  const result = await callPlatform<unknown>(operation, { method: 'POST', params: { id } });
  return sanitize(unwrapUpstream(result.data));
}

export const testAccount = (id: ResourceID) => runAIResourceAction('testAccount', id);
export const refreshAccount = (id: ResourceID) => runAIResourceAction('refreshAccount', id);
export const recoverAccountState = (id: ResourceID) => runAIResourceAction('recoverAccountState', id);
export const clearAccountRateLimit = (id: ResourceID) => runAIResourceAction('clearAccountRateLimit', id);
export const resetAccountQuota = (id: ResourceID) => runAIResourceAction('resetAccountQuota', id);

export async function getAccountStats(id: ResourceID): Promise<unknown> {
  return groupAction('getAccountStats', id);
}

export async function getAccountTodayStats(id: ResourceID): Promise<unknown> {
  return groupAction('getAccountTodayStats', id);
}

export async function getAccountModels(id: ResourceID): Promise<unknown> {
  return groupAction('getAccountModels', id);
}

export async function syncAccountModels(id: ResourceID): Promise<unknown> {
  return groupAction('syncAccountModels', id, { method: 'POST' });
}

export async function getScheduledTestResults(accountId: ResourceID, query: ResourceQuery): Promise<PayloadPage<AIResource>> {
  const result = await callPlatform<unknown>('getScheduledTestResults', {
    params: { id: accountId, page: query.page, page_size: query.limit }
  });
  return normalizeUpstreamArray(unwrapUpstream(result.data), query, parseAIResource);
}

export async function listScheduledTests(
  accountId: ResourceID,
  query: ResourceQuery
): Promise<PayloadPage<AIResource>> {
  const result = await callPlatform<unknown>('listScheduledTests', {
    params: { id: accountId, page: query.page, page_size: query.limit }
  });
  return normalizeUpstreamArray(unwrapUpstream(result.data), query, parseAIResource);
}

export async function createScheduledTest(input: Record<string, unknown>): Promise<AIResource> {
  const result = await callPlatform<unknown>('createScheduledTest', {
    body: input,
    method: 'POST'
  });
  return parseAIResource(unwrapUpstream(result.data));
}

export async function updateScheduledTest(id: ResourceID, input: Record<string, unknown>): Promise<AIResource> {
  const result = await callPlatform<unknown>('updateScheduledTest', {
    body: input,
    method: 'PUT',
    params: { id }
  });
  return parseAIResource(unwrapUpstream(result.data));
}

export async function deleteScheduledTest(id: ResourceID): Promise<unknown> {
  const result = await callPlatform<unknown>('deleteScheduledTest', {
    method: 'DELETE',
    params: { id }
  });
  return sanitize(unwrapUpstream(result.data));
}
