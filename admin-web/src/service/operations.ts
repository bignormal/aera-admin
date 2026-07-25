import type { PayloadPage, ResourceID, ResourceQuery } from './resources';
import { callPlatform } from './platform';
import {
  ContractError,
  asResourceRecord,
  asUpstreamRecord,
  normalizeUpstreamArray,
  normalizeUpstreamPage,
  unwrapUpstream
} from './upstream-contract';

export type OperationalResource = { id: ResourceID; [key: string]: unknown };
export type OperationalResourceKind =
  | 'alertEvents'
  | 'alertRules'
  | 'backups'
  | 'cleanupTasks'
  | 'dataBackupJobs'
  | 'requestDetails'
  | 'requestErrors'
  | 'riskLogs'
  | 'systemLogs'
  | 'upstreamErrors'
  | 'usage';

type OperationalListOperation = { operation: string; shape: 'array' | 'page' };

const listOperations: Record<OperationalResourceKind, OperationalListOperation> = {
  alertEvents: { operation: 'listAlertEvents', shape: 'array' },
  alertRules: { operation: 'listAlertRules', shape: 'array' },
  backups: { operation: 'listBackups', shape: 'page' },
  cleanupTasks: { operation: 'listUsageCleanupTasks', shape: 'page' },
  dataBackupJobs: { operation: 'listDataBackupJobs', shape: 'page' },
  requestDetails: { operation: 'listRequestDetails', shape: 'page' },
  requestErrors: { operation: 'listRequestErrors', shape: 'page' },
  riskLogs: { operation: 'listRiskLogs', shape: 'page' },
  systemLogs: { operation: 'listSystemLogs', shape: 'page' },
  upstreamErrors: { operation: 'listUpstreamErrors', shape: 'page' },
  usage: { operation: 'listUsage', shape: 'page' }
};

const diagnosticKinds = new Set<OperationalResourceKind>(['requestDetails', 'requestErrors', 'upstreamErrors']);

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function safeError(value: unknown): string | undefined {
  const message = text(value);
  if (!message) return undefined;
  return message
    .replace(/\bauthorization\s*[=:]\s*[a-z][a-z0-9._-]*\s+\S+/gi, 'authorization=[REDACTED]')
    .replace(/\b(token|secret|password|authorization|cookie)\s*[=:]\s*\S+/gi, '[REDACTED]')
    .slice(0, 500);
}

function sanitizeDiagnostic(value: unknown): OperationalResource {
  const source = value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
  const latency = source.latency_ms ?? source.latencyMs;
  const id = (source.id ?? source.request_id ?? source.requestId ?? '') as ResourceID;
  if (!['number', 'string'].includes(typeof id) || id === '') {
    throw new ContractError('AgentEra API 诊断资源缺少合法 id');
  }
  return {
    id,
    requestId: text(source.request_id ?? source.requestId) || '',
    occurredAt: text(source.occurred_at ?? source.created_at ?? source.occurredAt) || '',
    ...(text(source.model) ? { model: text(source.model) } : {}),
    ...(text(source.channel) ? { channel: text(source.channel) } : {}),
    status: text(source.status) || 'unknown',
    ...(typeof latency === 'number' && Number.isFinite(latency) ? { latencyMs: latency } : {}),
    ...(text(source.error_code ?? source.errorCode) ? { errorCode: text(source.error_code ?? source.errorCode) } : {}),
    ...(safeError(source.error_message ?? source.error_summary ?? source.errorSummary)
      ? { errorSummary: safeError(source.error_message ?? source.error_summary ?? source.errorSummary) }
      : {})
  };
}

export async function listOperationalResources<T extends OperationalResource = OperationalResource>(
  kind: OperationalResourceKind,
  query: ResourceQuery,
  signal?: AbortSignal
): Promise<PayloadPage<T>> {
  const listOperation = listOperations[kind];
  const result = await callPlatform<unknown>(listOperation.operation, {
    params:
      kind === 'alertEvents'
        ? { limit: query.limit }
        : kind === 'alertRules'
          ? {}
          : {
              page: query.page,
              page_size: query.limit,
              search: query.search?.trim(),
              sort_by: query.sort?.replace(/^-/, '') || 'created_at',
              sort_order: query.sort?.startsWith('-') ? 'desc' : 'asc'
            },
    signal
  });
  const parseItem = (value: unknown) =>
    (diagnosticKinds.has(kind) ? sanitizeDiagnostic(value) : asResourceRecord(value)) as T;
  const data = unwrapUpstream(result.data);
  return listOperation.shape === 'array'
    ? normalizeUpstreamArray(data, query, parseItem)
    : normalizeUpstreamPage(data, query, parseItem);
}

export async function getOperationalSnapshot(
  operation: string,
  signal?: AbortSignal
): Promise<Record<string, unknown>> {
  const result = await callPlatform<unknown>(operation, { signal });
  return asUpstreamRecord(unwrapUpstream(result.data));
}

export function createOperationsPoller(
  operation: string,
  intervalMs: number,
  listener: (value: Record<string, unknown>) => void,
  onError?: (error: unknown) => void
) {
  let timer: ReturnType<typeof setInterval> | undefined;
  let controller: AbortController | undefined;

  async function poll() {
    controller = new AbortController();
    try {
      listener(await getOperationalSnapshot(operation, controller.signal));
    } catch (error) {
      if (!(error instanceof DOMException && error.name === 'AbortError')) onError?.(error);
    }
  }

  return {
    start() {
      if (timer) return;
      void poll();
      timer = setInterval(() => void poll(), intervalMs);
    },
    dispose() {
      if (timer) clearInterval(timer);
      timer = undefined;
      controller?.abort();
      controller = undefined;
    }
  };
}

async function mutate(
  operation: string,
  options: { body?: unknown; id?: ResourceID; method?: 'DELETE' | 'POST' | 'PUT' }
) {
  const result = await callPlatform<unknown>(operation, {
    body: options.body,
    method: options.method || 'POST',
    params: options.id === undefined ? undefined : { id: options.id }
  });
  return unwrapUpstream(result.data);
}

export const createAlertRule = (input: Record<string, unknown>) => mutate('createAlertRule', { body: input });
export const updateAlertRule = (id: ResourceID, input: Record<string, unknown>) =>
  mutate('updateAlertRule', { body: input, id, method: 'PUT' });
export const deleteAlertRule = (id: ResourceID) => mutate('deleteAlertRule', { id, method: 'DELETE' });
export const updateAlertEventStatus = (id: ResourceID, status = 'resolved') =>
  mutate('updateAlertEventStatus', { body: { status }, id, method: 'PUT' });
export const resolveRequestError = (id: ResourceID) => mutate('resolveRequestError', { body: {}, id, method: 'PUT' });
export const resolveUpstreamError = (id: ResourceID) => mutate('resolveUpstreamError', { body: {}, id, method: 'PUT' });
export const cancelUsageCleanupTask = (id: ResourceID) => mutate('cancelUsageCleanupTask', { id });
export const createBackup = (input: Record<string, unknown>) => mutate('createBackup', { body: input });
export const deleteBackup = (id: ResourceID) => mutate('deleteBackup', { id, method: 'DELETE' });
export const getBackupDownloadURL = (id: ResourceID) => {
  return callPlatform<unknown>('getBackupDownloadURL', { params: { id } }).then(result => unwrapUpstream(result.data));
};
export const updateRiskConfig = (input: Record<string, unknown>) =>
  mutate('updateRiskConfig', { body: input, method: 'PUT' });
export const unbanRiskUser = (userId: ResourceID) => {
  return callPlatform<unknown>('unbanRiskUser', {
    body: {},
    method: 'POST',
    params: { user_id: userId }
  }).then(result => unwrapUpstream(result.data));
};
export const updateSystemSettings = (input: Record<string, unknown>) =>
  mutate('updateSystemSettings', { body: input, method: 'PUT' });
export const checkSystemUpdates = () => getOperationalSnapshot('checkSystemUpdates');
export const performSystemUpdate = (input: Record<string, unknown> = {}) => mutate('performSystemUpdate', { body: input });
export const rollbackSystem = (input: Record<string, unknown> = {}) => mutate('rollbackSystem', { body: input });
export const restartSystem = (input: Record<string, unknown> = {}) => mutate('restartSystem', { body: input });
export const regenerateAdminAPIKey = () => mutate('regenerateAdminAPIKey', { body: {} });
export const deleteAdminAPIKey = () => mutate('deleteAdminAPIKey', { method: 'DELETE' });
export const getBackupSchedule = () => getOperationalSnapshot('getBackupSchedule');
export const updateBackupSchedule = (input: Record<string, unknown>) =>
  mutate('updateBackupSchedule', { body: input, method: 'PUT' });
export const restoreBackup = (id: ResourceID, input: Record<string, unknown> = {}) =>
  mutate('restoreBackup', { body: input, id });
