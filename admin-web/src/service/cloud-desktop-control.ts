import type { components } from './generated/cloud-admin';
import { callCloud } from './cloud';

export type DesktopInstance = components['schemas']['DesktopControlInstance'];
export type DesktopInstancePage = components['schemas']['DesktopControlInstancePage'];
export type DesktopCommand = components['schemas']['DesktopControlCommand'];
export type DesktopHealthCode = NonNullable<DesktopCommand['result_code']>;
export type DesktopEffectiveStatus = DesktopInstance['effective_status'];
export type DesktopPlatform = DesktopInstance['platform'];

export type DesktopQuery = {
  clientVersion?: string;
  deviceId?: string;
  effectiveStatus?: DesktopEffectiveStatus;
  limit?: number;
  offset?: number;
  organizationId?: string;
  platform?: DesktopPlatform;
  userId?: string;
};

const effectiveStatuses = new Set<DesktopEffectiveStatus>([
  'pending',
  'revoked',
  'disabled',
  'online',
  'offline'
]);

export const desktopHealthCodeLabels: Readonly<Record<DesktopHealthCode, string>> = {
  HEALTHY: '健康',
  DESKTOP_UNHEALTHY: '桌面配置异常',
  RUNTIME_UNAVAILABLE: 'Runtime 不可用',
  GATEWAY_UNAVAILABLE: 'Gateway 不可用',
  HEALTH_CHECK_TIMEOUT: '健康检查超时',
  CLIENT_INTERRUPTED: '客户端执行中断'
};

export function mapDesktopStatus(value: unknown): DesktopEffectiveStatus {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Cloud Desktop effective_status is invalid');
  }
  const status = (value as { effective_status?: unknown }).effective_status;
  if (typeof status !== 'string' || !effectiveStatuses.has(status as DesktopEffectiveStatus)) {
    throw new Error('Cloud Desktop effective_status is invalid');
  }
  return status as DesktopEffectiveStatus;
}

export async function listDesktopInstances(
  query: DesktopQuery = {},
  signal?: AbortSignal
): Promise<DesktopInstancePage> {
  const result = await callCloud<DesktopInstancePage>('listDesktopControlInstances', {
    params: {
      client_version: query.clientVersion,
      device_id: query.deviceId,
      effective_status: query.effectiveStatus,
      limit: query.limit,
      offset: query.offset,
      organization_id: query.organizationId,
      platform: query.platform,
      user_id: query.userId
    },
    signal
  });
  result.data.items.forEach(mapDesktopStatus);
  return result.data;
}

export async function listUserDesktopInstances(
  userId: string,
  query: Pick<DesktopQuery, 'limit' | 'offset'> = {},
  signal?: AbortSignal
): Promise<DesktopInstancePage> {
  const result = await callCloud<DesktopInstancePage>('listUserDesktopControlInstances', {
    params: { limit: query.limit, offset: query.offset, user_id: userId },
    signal
  });
  result.data.items.forEach(mapDesktopStatus);
  return result.data;
}

export async function getDesktopInstance(
  deviceId: string,
  signal?: AbortSignal
): Promise<DesktopInstance> {
  const result = await callCloud<DesktopInstance>('getDesktopControlInstance', {
    params: { device_id: deviceId },
    signal
  });
  mapDesktopStatus(result.data);
  return result.data;
}

export async function requestHealthCheck(
  deviceId: string,
  idempotencyKey: string = crypto.randomUUID()
): Promise<DesktopCommand> {
  const result = await callCloud<DesktopCommand>('createDesktopHealthCheck', {
    body: {},
    idempotencyKey,
    method: 'POST',
    params: { device_id: deviceId }
  });
  return result.data;
}

export async function getDesktopCommand(
  commandId: string,
  signal?: AbortSignal
): Promise<DesktopCommand> {
  const result = await callCloud<DesktopCommand>('getDesktopControlCommand', {
    params: { command_id: commandId },
    signal
  });
  return result.data;
}
