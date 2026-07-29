import type { PayloadPage, ResourceID, ResourceQuery } from './resources';
import { callPlatform } from './platform';
import { ContractError, asResourceRecord, normalizeUpstreamPage, unwrapUpstream } from './upstream-contract';

export type UserStatus = 'active' | 'disabled';
export type UserRole = 'admin' | 'user';

export type PlatformUser = {
  allowed_groups: number[] | null;
  balance: number;
  balance_notify_enabled: boolean;
  balance_notify_extra_emails: unknown[] | null;
  balance_notify_threshold: number | null;
  concurrency: number;
  created_at: string;
  current_concurrency?: number;
  email: string;
  id: number;
  last_active_at?: string | null;
  last_used_at?: string | null;
  notes: string;
  role: UserRole;
  rpm_limit?: number;
  status: UserStatus;
  subscriptions?: unknown[];
  updated_at: string;
  username: string;
};

export type UserListQuery = {
  groupName?: string;
  page: number;
  pageSize: number;
  role?: UserRole;
  search?: string;
  sortBy?: string;
  sortOrder?: 'asc' | 'desc';
  status?: UserStatus;
};

export type UserInput = {
  allowed_groups?: number[] | null;
  balance?: number;
  concurrency?: number;
  email: string;
  notes?: string;
  password?: string;
  role?: UserRole;
  rpm_limit?: number;
  status?: UserStatus;
  username?: string;
};

export type UserAttributeDefinition = {
  id: ResourceID;
  key: string;
  label?: string;
  name?: string;
  required?: boolean;
  sort_order?: number;
  type?: string;
  [key: string]: unknown;
};

function parsePlatformUser(value: unknown): PlatformUser {
  const user = asResourceRecord(value);
  const finiteNumber = (field: unknown) => typeof field === 'number' && Number.isFinite(field);
  const numberArrayOrNull = (field: unknown) =>
    field === null || (Array.isArray(field) && field.every(item => finiteNumber(item)));
  const arrayOrNull = (field: unknown) => field === null || Array.isArray(field);
  if (
    typeof user.id !== 'number' ||
    typeof user.email !== 'string' ||
    typeof user.username !== 'string' ||
    !finiteNumber(user.balance) ||
    !finiteNumber(user.concurrency) ||
    !numberArrayOrNull(user.allowed_groups) ||
    typeof user.balance_notify_enabled !== 'boolean' ||
    !(user.balance_notify_threshold === null || finiteNumber(user.balance_notify_threshold)) ||
    !arrayOrNull(user.balance_notify_extra_emails) ||
    typeof user.created_at !== 'string' ||
    typeof user.updated_at !== 'string' ||
    typeof user.notes !== 'string' ||
    !['admin', 'user'].includes(String(user.role)) ||
    !['active', 'disabled'].includes(String(user.status))
  ) {
    throw new ContractError('Aera API 用户格式不合法');
  }
  return user as PlatformUser;
}

export async function listUsers(query: UserListQuery, signal?: AbortSignal): Promise<PayloadPage<PlatformUser>> {
  const result = await callPlatform<unknown>('listUsers', {
    params: {
      group_name: query.groupName,
      page: query.page,
      page_size: query.pageSize,
      role: query.role,
      search: query.search?.trim(),
      sort_by: query.sortBy || 'created_at',
      sort_order: query.sortOrder || 'desc',
      status: query.status
    },
    signal
  });
  return normalizeUpstreamPage(
    unwrapUpstream(result.data),
    { page: query.page, limit: query.pageSize },
    parsePlatformUser
  );
}

export async function getUser(id: number, signal?: AbortSignal): Promise<PlatformUser> {
  const result = await callPlatform<unknown>('getUser', { params: { id }, signal });
  return parsePlatformUser(unwrapUpstream(result.data));
}

export async function createUser(input: UserInput): Promise<PlatformUser> {
  const result = await callPlatform<unknown>('createUser', {
    body: input,
    method: 'POST'
  });
  return parsePlatformUser(unwrapUpstream(result.data));
}

export async function updateUser(id: number, input: Partial<UserInput>): Promise<PlatformUser> {
  const result = await callPlatform<unknown>('updateUser', {
    body: input,
    method: 'PUT',
    params: { id }
  });
  return parsePlatformUser(unwrapUpstream(result.data));
}

export async function updateUserStatus(id: number, status: UserStatus): Promise<PlatformUser> {
  return updateUser(id, { status });
}

export type BalanceUpdate = {
  balance: number;
  notes: string;
  operation: 'add' | 'set' | 'subtract';
};

export async function updateUserBalance(id: number, input: BalanceUpdate): Promise<PlatformUser> {
  const result = await callPlatform<unknown>('updateUserBalance', {
    body: input,
    method: 'POST',
    params: { id }
  });
  return parsePlatformUser(unwrapUpstream(result.data));
}

async function userRelated<T>(operation: string, id: number, params?: Record<string, number | string>): Promise<T> {
  const result = await callPlatform<unknown>(operation, { params: { id, ...params } });
  return unwrapUpstream(result.data) as T;
}

export const getUserAPIKeys = (id: number) => userRelated<unknown>('listUserAPIKeys', id);
export const getUserUsage = (id: number, period = 'month') => userRelated<unknown>('getUserUsage', id, { period });
export const getUserBalanceHistory = (id: number) => userRelated<unknown>('getUserBalanceHistory', id);
export const getUserRPMStatus = (id: number) => userRelated<unknown>('getUserRPMStatus', id);
export const getUserPlatformQuotas = (id: number) => userRelated<unknown>('getUserPlatformQuotas', id);
export const getUserAttributes = (id: number) => userRelated<unknown>('getUserAttributes', id);
export const getUserSubscriptions = (id: number) => userRelated<unknown>('listUserSubscriptions', id);

export async function updateUserAttributes(id: number, input: Record<string, unknown>): Promise<unknown> {
  const result = await callPlatform<unknown>('updateUserAttributes', { body: input, method: 'PUT', params: { id } });
  return unwrapUpstream(result.data);
}

export async function updateUserPlatformQuotas(id: number, input: Record<string, unknown>): Promise<unknown> {
  const result = await callPlatform<unknown>('updateUserPlatformQuotas', { body: input, method: 'PUT', params: { id } });
  return unwrapUpstream(result.data);
}

export async function resetUserPlatformQuotas(id: number): Promise<unknown> {
  const result = await callPlatform<unknown>('resetUserPlatformQuotas', { method: 'POST', params: { id } });
  return unwrapUpstream(result.data);
}

export async function batchUpdateUserConcurrency(input: { concurrency: number; user_ids: number[] }): Promise<unknown> {
  const result = await callPlatform<unknown>('batchUpdateUserConcurrency', { body: input, method: 'POST' });
  return unwrapUpstream(result.data);
}

export async function replaceUserGroup(id: number, input: { group_id?: number | null; group_name?: string }): Promise<unknown> {
  const result = await callPlatform<unknown>('replaceUserGroup', { body: input, method: 'POST', params: { id } });
  return unwrapUpstream(result.data);
}

export async function listUserAttributeDefinitions(
  query: ResourceQuery,
  signal?: AbortSignal
): Promise<PayloadPage<UserAttributeDefinition>> {
  const result = await callPlatform<unknown>('listUserAttributeDefinitions', {
    params: { page: query.page, page_size: query.limit, search: query.search?.trim() },
    signal
  });
  return normalizeUpstreamPage(unwrapUpstream(result.data), query, value => asResourceRecord(value) as UserAttributeDefinition);
}

export async function createUserAttributeDefinition(input: Record<string, unknown>): Promise<UserAttributeDefinition> {
  const result = await callPlatform<unknown>('createUserAttributeDefinition', { body: input, method: 'POST' });
  return asResourceRecord(unwrapUpstream(result.data)) as UserAttributeDefinition;
}

export async function updateUserAttributeDefinition(
  id: ResourceID,
  input: Record<string, unknown>
): Promise<UserAttributeDefinition> {
  const result = await callPlatform<unknown>('updateUserAttributeDefinition', { body: input, method: 'PUT', params: { id } });
  return asResourceRecord(unwrapUpstream(result.data)) as UserAttributeDefinition;
}

export async function deleteUserAttributeDefinition(id: ResourceID): Promise<unknown> {
  const result = await callPlatform<unknown>('deleteUserAttributeDefinition', { method: 'DELETE', params: { id } });
  return unwrapUpstream(result.data);
}

export async function reorderUserAttributeDefinitions(items: Array<{ id: ResourceID; sort_order: number }>): Promise<unknown> {
  const result = await callPlatform<unknown>('reorderUserAttributeDefinitions', { body: { items }, method: 'PUT' });
  return unwrapUpstream(result.data);
}
