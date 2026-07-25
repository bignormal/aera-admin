import type { PayloadPage, ResourceID, ResourceQuery } from './resources';
import { apiRequest } from './http';
import { createResource, deleteResource, listResources, updateResource } from './resources';

export type RuntimeCommandType = 'health_check' | 'gateway_restart' | 'runtime_rollback' | 'runtime_upgrade';
export type RuntimeInstance = {
  arch?: string;
  capabilities?: unknown;
  channels?: unknown;
  healthSummary?: unknown;
  id: ResourceID;
  instanceType?: string;
  lastHeartbeatAt?: string | null;
  name?: string;
  os?: string;
  resources?: unknown;
  status?: string;
  tenantId?: string;
  version?: string;
  [key: string]: unknown;
};
export type RuntimeRelease = { id: ResourceID; [key: string]: unknown };

type EnrollmentResponse = {
  data: { enrollmentCode: string; expiresAt: string; instanceId: string };
  meta: Record<string, unknown>;
  requestId: string;
};

const requiredCapability: Record<RuntimeCommandType, string> = {
  gateway_restart: 'gateway.restart',
  health_check: 'diagnostics.health.read',
  runtime_rollback: 'runtime.version.rollback',
  runtime_upgrade: 'runtime.version.upgrade'
};

const resourceFields: Record<string, Set<string>> = {
  codingAgents: new Set(['id', 'type', 'status', 'durationMs', 'changeCount', 'workspaceHash']),
  cron: new Set(['id', 'status', 'nextRunAt', 'lastResult']),
  devices: new Set(['id', 'type', 'status', 'lastSeenAt']),
  tasks: new Set(['id', 'status', 'source', 'model', 'tokens', 'cost', 'errorCode']),
  workflows: new Set(['id', 'status', 'version', 'nodeCount', 'failedNode'])
};

export function deriveRuntimeStatus(
  instance: Pick<RuntimeInstance, 'lastHeartbeatAt' | 'status'>,
  now = Date.now()
): string {
  if (instance.status === 'disabled' || instance.status === 'pending') return instance.status;
  if (!instance.lastHeartbeatAt) return 'offline';
  return now - Date.parse(instance.lastHeartbeatAt) <= 150_000 ? 'online' : 'offline';
}

function capabilities(instance: Pick<RuntimeInstance, 'capabilities'>): string[] {
  return Array.isArray(instance.capabilities)
    ? instance.capabilities.filter((item): item is string => typeof item === 'string')
    : [];
}

export function supportsRuntimeCommand(
  instance: Pick<RuntimeInstance, 'capabilities'>,
  command: RuntimeCommandType
): boolean {
  return capabilities(instance).includes(requiredCapability[command]);
}

export function consumeEnrollmentCode(value: EnrollmentResponse['data']) {
  let code: string | null = value.enrollmentCode;
  return {
    expiresAt: value.expiresAt,
    instanceId: value.instanceId,
    take() {
      const current = code;
      code = null;
      return current;
    }
  };
}

export async function createRuntimeEnrollment(input: {
  instanceType: 'desktop' | 'runtime' | 'studio';
  name: string;
  tenantId?: string;
}) {
  const result = await apiRequest<EnrollmentResponse>('/platform/v1/runtime/enrollments', {
    body: input,
    method: 'POST'
  });
  return consumeEnrollmentCode(result.data);
}

export async function createRuntimeCommand(instance: RuntimeInstance, type: RuntimeCommandType) {
  if (!supportsRuntimeCommand(instance, type)) throw new Error('该实例不支持此命令');
  if (type !== 'health_check') throw new Error('该高风险命令需要重新验证，当前不可执行');
  return apiRequest('/platform/v1/runtime/commands', {
    body: { idempotencyKey: crypto.randomUUID(), instanceId: instance.id, type },
    method: 'POST'
  });
}

export function listRuntimeInstances(query: ResourceQuery, signal?: AbortSignal): Promise<PayloadPage<RuntimeInstance>> {
  return listResources<RuntimeInstance>('runtime-instances', query, signal);
}

export function listRuntimeReleases(query: ResourceQuery, signal?: AbortSignal): Promise<PayloadPage<RuntimeRelease>> {
  return listResources<RuntimeRelease>('runtime-releases', query, signal);
}

export const createRuntimeRelease = (input: Record<string, unknown>) =>
  createResource<RuntimeRelease, Record<string, unknown>>('runtime-releases', input);
export const updateRuntimeRelease = (id: ResourceID, input: Record<string, unknown>) =>
  updateResource<RuntimeRelease, Record<string, unknown>>('runtime-releases', id, input);
export const deleteRuntimeRelease = (id: ResourceID) => deleteResource<RuntimeRelease>('runtime-releases', id);

export const listRuntimeCommands = (query: ResourceQuery, signal?: AbortSignal) =>
  listResources<{ id: ResourceID; [key: string]: unknown }>('runtime-commands', query, signal);
export const listRuntimeEvents = (query: ResourceQuery, signal?: AbortSignal) =>
  listResources<{ id: ResourceID; [key: string]: unknown }>('runtime-events', query, signal);

export function runtimeResourceRows(kind: keyof typeof resourceFields, value: unknown) {
  if (!Array.isArray(value)) return [];
  const allowed = resourceFields[kind];
  return value.slice(0, 100).flatMap(item => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return [];
    const clean = Object.fromEntries(
      Object.entries(item as Record<string, unknown>).filter(([key]) => allowed.has(key))
    );
    return clean.id && clean.status ? [clean as { id: ResourceID; [key: string]: unknown }] : [];
  });
}

export async function listRuntimeOperations(
  kind: keyof typeof resourceFields,
  query: ResourceQuery,
  signal?: AbortSignal
): Promise<PayloadPage<{ id: ResourceID; [key: string]: unknown }>> {
  const instances = await listResources<RuntimeInstance>(
    'runtime-instances',
    { limit: 100, page: 1, search: query.search, sort: '-lastHeartbeatAt' },
    signal
  );
  const rows = instances.docs.flatMap(instance => {
    const source = instance.resources && typeof instance.resources === 'object' ? instance.resources : {};
    return runtimeResourceRows(kind, (source as Record<string, unknown>)[kind]).map(row => ({
      ...row,
      id: `${instance.id}:${row.id}`,
      instanceId: instance.id,
      instanceName: instance.name
    }));
  });
  const start = (query.page - 1) * query.limit;
  const docs = rows.slice(start, start + query.limit);
  const totalPages = Math.max(1, Math.ceil(rows.length / query.limit));
  return {
    docs,
    hasNextPage: query.page < totalPages,
    hasPrevPage: query.page > 1,
    limit: query.limit,
    page: query.page,
    totalDocs: rows.length,
    totalPages
  };
}
