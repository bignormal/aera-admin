import { callCloud } from './cloud';

// 类型对齐 aera-cloud/internal/admin/control_model.go 的 JSON 契约。
export type CloudUserStatus = 'active' | 'disabled' | 'pending_deletion';

export type CloudUser = {
  active_device_count: number;
  active_session_count: number;
  administrative_revision: number;
  administratively_disabled: boolean;
  created_at: string;
  deletion_finalized_at?: string | null;
  device_count: number;
  last_cloud_activity_at?: string | null;
  masked_email?: string;
  masked_phone?: string;
  status: CloudUserStatus;
  user_id: string;
};

export type CloudDevice = {
  client_version: string;
  device_id: string;
  display_name: string;
  last_seen_at?: string | null;
  platform: string;
  status: 'active' | 'inactive' | 'revoked';
  user_id: string;
};

export type CloudSession = {
  device_id: string;
  expires_at: string;
  issued_at: string;
  revoked_at?: string | null;
  session_id: string;
  status: 'active' | 'expired' | 'replay_detected' | 'revoked' | 'rotated';
  user_id: string;
};

export type CloudMembership = {
  display_name: string;
  id: string;
  role: string;
  status: string;
};

export type CloudUserMemberships = {
  organizations: CloudMembership[];
  workspaces: CloudMembership[];
};

export type CloudPage<T> = {
  items: T[];
  next_cursor?: string;
};

export type CloudPlatformStats = {
  device_active: number;
  device_total: number;
  user_active: number;
  user_disabled: number;
  user_pending_deletion: number;
  user_total: number;
};

export type CloudDeviceStats = {
  platforms?: Array<{ count: number; platform: string }>;
  versions?: Array<{ client_version?: string; count: number; version?: string }>;
  [key: string]: unknown;
};

export type CloudOperationResult = {
  administrative_revision?: number;
  error_code?: string;
  operation_id: string;
  status: string;
  updated_at: string;
};

// 云端命令统一入参：reason_code 必填（^[a-z][a-z0-9_]{2,63}$），
// expected_revision 为用户详情返回的 administrative_revision。
export type CloudCommandInput = {
  expected_revision: number;
  note?: string;
  reason_code: string;
  ticket_reference?: string;
};

export async function getCloudStats(signal?: AbortSignal): Promise<CloudPlatformStats> {
  const result = await callCloud<CloudPlatformStats>('cloudStats', { signal });
  return result.data;
}

export async function getCloudDeviceStats(signal?: AbortSignal): Promise<CloudDeviceStats> {
  const result = await callCloud<CloudDeviceStats>('cloudDeviceStats', { signal });
  return result.data;
}

export async function getCloudOperation(operationId: string, signal?: AbortSignal): Promise<CloudOperationResult> {
  const result = await callCloud<CloudOperationResult>('getCloudOperation', {
    params: { operation_id: operationId },
    signal
  });
  return result.data;
}

export async function listCloudUsers(
  query: { cursor?: string; limit?: number; status?: CloudUserStatus },
  signal?: AbortSignal
): Promise<CloudPage<CloudUser>> {
  const result = await callCloud<CloudPage<CloudUser>>('listCloudUsers', {
    params: { cursor: query.cursor, limit: query.limit, status: query.status },
    signal
  });
  return result.data;
}

export async function lookupCloudUser(kind: 'email' | 'phone', value: string): Promise<CloudUser> {
  const result = await callCloud<CloudUser>('lookupCloudUser', {
    method: 'POST',
    body: { type: kind, value }
  });
  return result.data;
}

export async function getCloudUser(userId: string, signal?: AbortSignal): Promise<CloudUser> {
  const result = await callCloud<CloudUser>('getCloudUser', { params: { user_id: userId }, signal });
  return result.data;
}

export async function listCloudUserDevices(
  userId: string,
  query: { cursor?: string; limit?: number } = {},
  signal?: AbortSignal
): Promise<CloudPage<CloudDevice>> {
  const result = await callCloud<CloudPage<CloudDevice>>('listCloudUserDevices', {
    params: { user_id: userId, cursor: query.cursor, limit: query.limit },
    signal
  });
  return result.data;
}

export async function listCloudUserSessions(
  userId: string,
  query: { cursor?: string; limit?: number } = {},
  signal?: AbortSignal
): Promise<CloudPage<CloudSession>> {
  const result = await callCloud<CloudPage<CloudSession>>('listCloudUserSessions', {
    params: { user_id: userId, cursor: query.cursor, limit: query.limit },
    signal
  });
  return result.data;
}

export async function getCloudUserMemberships(userId: string, signal?: AbortSignal): Promise<CloudUserMemberships> {
  const result = await callCloud<CloudUserMemberships>('getCloudUserMemberships', {
    params: { user_id: userId },
    signal
  });
  return result.data;
}

export async function revokeCloudDevice(deviceId: string, input: CloudCommandInput): Promise<CloudOperationResult> {
  const result = await callCloud<CloudOperationResult>('revokeCloudDevice', {
    method: 'POST',
    params: { device_id: deviceId },
    body: input
  });
  return result.data;
}

export async function revokeCloudSession(sessionId: string, input: CloudCommandInput): Promise<CloudOperationResult> {
  const result = await callCloud<CloudOperationResult>('revokeCloudSession', {
    method: 'POST',
    params: { session_id: sessionId },
    body: input
  });
  return result.data;
}

export async function revokeAllCloudSessions(userId: string, input: CloudCommandInput): Promise<CloudOperationResult> {
  const result = await callCloud<CloudOperationResult>('revokeAllCloudSessions', {
    method: 'POST',
    params: { user_id: userId },
    body: input
  });
  return result.data;
}

export async function disableCloudUser(userId: string, input: CloudCommandInput): Promise<CloudOperationResult> {
  const result = await callCloud<CloudOperationResult>('disableCloudUser', {
    method: 'POST',
    params: { user_id: userId },
    body: input
  });
  return result.data;
}

export async function enableCloudUser(userId: string, input: CloudCommandInput): Promise<CloudOperationResult> {
  const result = await callCloud<CloudOperationResult>('enableCloudUser', {
    method: 'POST',
    params: { user_id: userId },
    body: input
  });
  return result.data;
}

export async function resetCloudUserPassword(
  userId: string,
  input: CloudCommandInput
): Promise<CloudOperationResult> {
  const result = await callCloud<CloudOperationResult>('resetCloudUserPassword', {
    method: 'POST',
    params: { user_id: userId },
    body: input
  });
  return result.data;
}
