import { beforeEach, describe, expect, it, vi } from 'vitest';
import { callPlatform } from './platform';
import { cancelPaymentOrder, listBillingResources, orderStatusTag, retryPaymentOrder } from './billing';

vi.mock('./platform', () => ({ callPlatform: vi.fn() }));

describe('billing service', () => {
  beforeEach(() => vi.mocked(callPlatform).mockReset());

  it('keeps money as strings and maps unknown order statuses safely', async () => {
    vi.mocked(callPlatform).mockResolvedValueOnce({
      data: {
        code: 0,
        message: 'success',
        data: {
          items: [{ id: 1, amount: 12.34, status: 'brand_new_state' }],
          total: 1,
          page: 1,
          page_size: 20,
          pages: 1
        }
      },
      meta: {},
      requestId: 'billing-list'
    });

    const page = await listBillingResources('orders', { page: 1, limit: 20, search: '', sort: '-created_at' });
    expect(page.docs[0]?.amount).toBe('12.34');
    expect(orderStatusTag('brand_new_state')).toEqual({ label: 'brand_new_state', type: 'default' });
  });

  it('uses POST for order cancellation and fulfillment retry', async () => {
    vi.mocked(callPlatform).mockResolvedValue({
      data: { code: 0, message: 'success', data: {} },
      meta: {},
      requestId: 'action'
    });

    await cancelPaymentOrder(8, { reason: 'duplicate' });
    await retryPaymentOrder(8);

    expect(callPlatform).toHaveBeenNthCalledWith(1, 'cancelPaymentOrder', {
      method: 'POST',
      params: { id: 8 },
      body: { reason: 'duplicate' }
    });
    expect(callPlatform).toHaveBeenNthCalledWith(2, 'retryPaymentOrder', { method: 'POST', params: { id: 8 } });
  });

  it('never exposes provider secrets to forms', async () => {
    vi.mocked(callPlatform).mockResolvedValueOnce({
      data: {
        code: 0,
        message: 'success',
        data: [{ id: 1, name: 'Stripe', api_key: 'raw-provider-secret', config: { webhook_secret: 'raw-hook' } }]
      },
      meta: {},
      requestId: 'providers'
    });

    const page = await listBillingResources('providers', { page: 1, limit: 20, search: '', sort: '-created_at' });
    expect(JSON.stringify(page)).not.toContain('raw-provider-secret');
    expect(JSON.stringify(page)).not.toContain('raw-hook');
  });

  it('rejects a malformed paginated billing response', async () => {
    vi.mocked(callPlatform).mockResolvedValueOnce({
      data: { code: 0, data: { items: 'not-an-array' }, message: 'success' },
      meta: {},
      requestId: 'invalid-page'
    });

    await expect(listBillingResources('orders', { page: 1, limit: 10 })).rejects.toThrow('分页格式不合法');
  });

  it('uses user_id as the stable affiliate row id', async () => {
    vi.mocked(callPlatform).mockResolvedValueOnce({
      data: {
        code: 0,
        data: {
          items: [{ user_id: 19, email: 'affiliate@example.com' }],
          page: 1,
          page_size: 10,
          pages: 1,
          total: 1
        },
        message: 'success'
      },
      meta: {},
      requestId: 'affiliate-page'
    });

    await expect(listBillingResources('affiliate', { page: 1, limit: 10 })).resolves.toMatchObject({
      docs: [{ id: 19, user_id: 19 }]
    });
  });

  it.each([
    ['orders', { id: '' }],
    ['affiliate', { user_id: '' }]
  ] as const)('rejects an empty %s resource id', async (kind, item) => {
    vi.mocked(callPlatform).mockResolvedValueOnce({
      data: {
        code: 0,
        data: { items: [item], page: 1, page_size: 10, pages: 1, total: 1 },
        message: 'success'
      },
      meta: {},
      requestId: 'empty-billing-id'
    });

    await expect(listBillingResources(kind, { page: 1, limit: 10 })).rejects.toThrow('缺少合法 id');
  });
});
