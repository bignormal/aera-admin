import type { PayloadPage, ResourceID, ResourceQuery } from './resources';
import { callPlatform } from './platform';
import {
  ContractError,
  asUpstreamRecord,
  normalizeUpstreamArray,
  normalizeUpstreamPage,
  unwrapUpstream
} from './upstream-contract';

export type BillingResource = { id: ResourceID; name?: string; [key: string]: unknown };
export type BillingResourceKind =
  | 'affiliate'
  | 'affiliateInvites'
  | 'affiliateRebates'
  | 'affiliateTransfers'
  | 'announcements'
  | 'orders'
  | 'plans'
  | 'promo'
  | 'providers'
  | 'redeem'
  | 'subscriptions';

type BillingListOperation = { operation: string; shape: 'array' | 'page' };

const listOperations: Record<BillingResourceKind, BillingListOperation> = {
  affiliate: { operation: 'listAffiliateUsers', shape: 'page' },
  affiliateInvites: { operation: 'listAffiliateInvites', shape: 'page' },
  affiliateRebates: { operation: 'listAffiliateRebates', shape: 'page' },
  affiliateTransfers: { operation: 'listAffiliateTransfers', shape: 'page' },
  announcements: { operation: 'listAnnouncements', shape: 'page' },
  orders: { operation: 'listPaymentOrders', shape: 'page' },
  plans: { operation: 'listPaymentPlans', shape: 'array' },
  promo: { operation: 'listPromoCodes', shape: 'page' },
  providers: { operation: 'listPaymentProviders', shape: 'array' },
  redeem: { operation: 'listRedeemCodes', shape: 'page' },
  subscriptions: { operation: 'listSubscriptions', shape: 'page' }
};

const mutations: Partial<Record<BillingResourceKind, { create?: string; delete?: string; update?: string }>> = {
  announcements: { create: 'createAnnouncement', update: 'updateAnnouncement', delete: 'deleteAnnouncement' },
  plans: { create: 'createPaymentPlan', update: 'updatePaymentPlan', delete: 'deletePaymentPlan' },
  promo: { create: 'createPromoCode', update: 'updatePromoCode', delete: 'deletePromoCode' }
};

const moneyKey = /(amount|balance|cost|price|quota|revenue|refund|rebate|total_paid|total_spent)/i;
const secretKey = /(secret|password|api[_-]?key|private[_-]?key|access[_-]?token|refresh[_-]?token)/i;

function normalizeExternal<T>(value: T, key = ''): T {
  if (Array.isArray(value)) return value.map(item => normalizeExternal(item)) as T;
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([childKey, child]) => [
        childKey,
        secretKey.test(childKey)
          ? child === null || child === undefined || child === ''
            ? { configured: false, masked: '' }
            : { configured: true, masked: `****${String(child).slice(-4)}` }
          : normalizeExternal(child, childKey)
      ])
    ) as T;
  }
  if (moneyKey.test(key) && typeof value === 'number') return String(value) as T;
  return value;
}

function unwrap(value: unknown): unknown {
  return normalizeExternal(unwrapUpstream(value));
}

function parseBillingResource(kind: BillingResourceKind, value: unknown): BillingResource {
  const source = asUpstreamRecord(value);
  const id =
    source.id ??
    (kind === 'affiliate' ? source.user_id : undefined) ??
    source.invite_id ??
    source.rebate_id ??
    source.transfer_id ??
    source.order_id ??
    source.code;
  if (!['number', 'string'].includes(typeof id) || (typeof id === 'string' && id.trim() === '')) {
    throw new ContractError('Aera API 商业资源缺少合法 id');
  }
  return { ...source, id: id as ResourceID };
}

export async function listBillingResources<T extends BillingResource = BillingResource>(
  kind: BillingResourceKind,
  query: ResourceQuery,
  signal?: AbortSignal
): Promise<PayloadPage<T>> {
  const listOperation = listOperations[kind];
  const result = await callPlatform<unknown>(listOperation.operation, {
    params: {
      page: query.page,
      page_size: query.limit,
      search: query.search?.trim(),
      sort_by: query.sort?.replace(/^-/, '') || 'created_at',
      sort_order: query.sort?.startsWith('-') ? 'desc' : 'asc'
    },
    signal
  });
  const parseItem = (value: unknown) => parseBillingResource(kind, value) as T;
  const data = unwrap(result.data);
  return listOperation.shape === 'array'
    ? normalizeUpstreamArray(data, query, parseItem)
    : normalizeUpstreamPage(data, query, parseItem);
}

export async function createBillingResource(
  kind: BillingResourceKind,
  input: Record<string, unknown>
): Promise<unknown> {
  const operation = mutations[kind]?.create;
  if (!operation) throw new Error(`Unsupported create operation: ${kind}`);
  const result = await callPlatform<unknown>(operation, { body: input, method: 'POST' });
  return unwrap(result.data);
}

export async function updateBillingResource(
  kind: BillingResourceKind,
  id: ResourceID,
  input: Record<string, unknown>
): Promise<unknown> {
  const operation = mutations[kind]?.update;
  if (!operation) throw new Error(`Unsupported update operation: ${kind}`);
  const result = await callPlatform<unknown>(operation, {
    body: input,
    method: 'PUT',
    params: { id }
  });
  return unwrap(result.data);
}

export async function deleteBillingResource(kind: BillingResourceKind, id: ResourceID): Promise<unknown> {
  const operation = mutations[kind]?.delete;
  if (!operation) throw new Error(`Unsupported delete operation: ${kind}`);
  const result = await callPlatform<unknown>(operation, { method: 'DELETE', params: { id } });
  return unwrap(result.data);
}

async function postAction(operation: string, id: ResourceID, body?: unknown): Promise<unknown> {
  const result = await callPlatform<unknown>(operation, { body, method: 'POST', params: { id } });
  return unwrap(result.data);
}

export const cancelPaymentOrder = (id: ResourceID, body: { reason: string }) =>
  postAction('cancelPaymentOrder', id, body);
export const retryPaymentOrder = (id: ResourceID) => postAction('retryPaymentOrder', id);
export const processRefund = (id: ResourceID, body: Record<string, unknown>) => postAction('processRefund', id, body);
export const queryPaymentRefund = (id: ResourceID, body: Record<string, unknown> = {}) =>
  postAction('queryPaymentRefund', id, body);
export const extendSubscription = (id: ResourceID, body: unknown = {}) => postAction('extendSubscription', id, body);
export const resetSubscriptionQuota = (id: ResourceID) => postAction('resetSubscriptionQuota', id);
export const revokeSubscription = (id: ResourceID) => postAction('revokeSubscription', id);
export const restoreSubscription = (id: ResourceID) => postAction('restoreSubscription', id);
export const expireRedeemCode = (id: ResourceID) => postAction('expireRedeemCode', id);

export async function assignSubscription(input: Record<string, unknown>): Promise<unknown> {
  const result = await callPlatform<unknown>('assignSubscription', { body: input, method: 'POST' });
  return unwrap(result.data);
}

export async function generateRedeemCodes(input: Record<string, unknown>): Promise<unknown> {
  const result = await callPlatform<unknown>('generateRedeemCodes', { body: input, method: 'POST' });
  return unwrap(result.data);
}

export async function deleteRedeemCode(id: ResourceID): Promise<unknown> {
  const result = await callPlatform<unknown>('deleteRedeemCode', {
    method: 'DELETE',
    params: { id }
  });
  return unwrap(result.data);
}

export async function getRedeemCodeStats(): Promise<Record<string, unknown>> {
  const result = await callPlatform<unknown>('getRedeemCodeStats');
  return asUpstreamRecord(unwrap(result.data));
}

export async function exportRedeemCodes(): Promise<unknown> {
  const result = await callPlatform<unknown>('exportRedeemCodes');
  return unwrap(result.data);
}

export async function getPromoCodeUsages(id: ResourceID): Promise<unknown> {
  const result = await callPlatform<unknown>('getPromoCodeUsages', { params: { id } });
  return unwrap(result.data);
}

export async function updateAffiliateUser(id: ResourceID, input: Record<string, unknown>): Promise<unknown> {
  const result = await callPlatform<unknown>('updateAffiliateUser', {
    body: input,
    method: 'PUT',
    params: { user_id: id }
  });
  return unwrap(result.data);
}

export async function clearAffiliateUser(id: ResourceID): Promise<unknown> {
  const result = await callPlatform<unknown>('clearAffiliateUser', {
    method: 'DELETE',
    params: { user_id: id }
  });
  return unwrap(result.data);
}

export async function getBillingOverview(signal?: AbortSignal): Promise<Record<string, unknown>> {
  const result = await callPlatform<unknown>('getPaymentDashboard', { signal });
  return asUpstreamRecord(unwrap(result.data));
}

export function orderStatusTag(status: unknown): {
  label: string;
  type: 'default' | 'error' | 'info' | 'success' | 'warning';
} {
  const value = typeof status === 'string' && status ? status : 'unknown';
  const known: Record<string, { label: string; type: 'default' | 'error' | 'info' | 'success' | 'warning' }> = {
    cancelled: { label: '已取消', type: 'default' },
    failed: { label: '失败', type: 'error' },
    paid: { label: '已支付', type: 'success' },
    pending: { label: '待支付', type: 'warning' },
    processing: { label: '处理中', type: 'info' },
    refunded: { label: '已退款', type: 'default' }
  };
  return known[value] || { label: value, type: 'default' };
}
