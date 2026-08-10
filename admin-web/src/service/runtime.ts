import type { PayloadPage, ResourceID, ResourceQuery } from './resources';
import { apiRequest } from './http';
import { createResource, deleteResource, listResources, updateResource } from './resources';
import { listDesktopInstances, type DesktopInstance, type DesktopQuery } from './cloud-desktop-control';

export type RuntimeCommandType = 'health_check' | 'gateway_restart' | 'runtime_rollback' | 'runtime_upgrade';
export type RuntimeInstance = {
  arch?: string;
  capabilities?: unknown;
  channels?: unknown;
  deviceId?: string;
  effectiveStatus?: string;
  healthSummary?: unknown;
  id: ResourceID;
  instanceType?: string;
  lastHeartbeatAt?: string | null;
  name?: string;
  os?: string;
  organizationId?: string;
  resources?: unknown;
  status?: string;
  tenantId?: string;
  userId?: string;
  version?: string;
  workspaceId?: string;
  [key: string]: unknown;
};
export type RuntimeRelease = { id: ResourceID; [key: string]: unknown };

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

export async function createRuntimeCommand(instance: RuntimeInstance, type: RuntimeCommandType) {
  if (!supportsRuntimeCommand(instance, type)) throw new Error('该实例不支持此命令');
  if (type !== 'health_check') throw new Error('该高风险命令需要重新验证，当前不可执行');
  return apiRequest('/platform/v1/runtime/commands', {
    body: { idempotencyKey: crypto.randomUUID(), instanceId: instance.id, type },
    method: 'POST'
  });
}

function mapDesktopInstance(instance: DesktopInstance): RuntimeInstance {
  return {
    arch: instance.arch,
    capabilities: [...instance.capabilities],
    deviceId: instance.device_id,
    effectiveStatus: instance.effective_status,
    healthSummary: instance.health_summary,
    id: instance.device_id,
    instanceType: 'desktop',
    lastHeartbeatAt: instance.last_heartbeat_at,
    name: instance.display_name,
    organizationId: instance.organization_id,
    os: instance.platform,
    status: instance.effective_status,
    userId: instance.user_id,
    version: instance.client_version,
    workspaceId: instance.workspace_id
  };
}

export type RuntimeInstanceQuery = ResourceQuery & {
  clientVersion?: string;
  deviceId?: string;
  effectiveStatus?: DesktopQuery['effectiveStatus'];
  organizationId?: string;
  platform?: DesktopQuery['platform'];
  userId?: string;
};

export async function listRuntimeInstances(
  query: RuntimeInstanceQuery,
  signal?: AbortSignal
): Promise<PayloadPage<RuntimeInstance>> {
  const result = await listDesktopInstances(
    {
      clientVersion: query.clientVersion,
      deviceId: query.deviceId,
      effectiveStatus: query.effectiveStatus,
      limit: query.limit,
      offset: Math.max(0, query.page - 1) * query.limit,
      organizationId: query.organizationId,
      platform: query.platform,
      userId: query.userId
    },
    signal
  );
  const totalPages = Math.max(1, Math.ceil(result.total / query.limit));
  return {
    docs: result.items.map(mapDesktopInstance),
    hasNextPage: query.page < totalPages,
    hasPrevPage: query.page > 1,
    limit: query.limit,
    page: query.page,
    totalDocs: result.total,
    totalPages
  };
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
