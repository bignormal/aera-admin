import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { callPlatform } from './platform';
import { createOperationsPoller, getOperationalSnapshot, listOperationalResources } from './operations';

vi.mock('./platform', () => ({ callPlatform: vi.fn() }));

describe('operations service', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.mocked(callPlatform).mockReset();
  });
  afterEach(() => vi.useRealTimers());

  it('keeps one poll active and aborts on disposal', async () => {
    vi.mocked(callPlatform).mockResolvedValue({
      data: { code: 0, message: 'success', data: { qps: 2 } },
      meta: {},
      requestId: 'poll'
    });
    const listener = vi.fn();
    const poller = createOperationsPoller('getOpsRealtimeTraffic', 5_000, listener);

    poller.start();
    poller.start();
    await vi.advanceTimersByTimeAsync(15_000);
    expect(callPlatform).toHaveBeenCalledTimes(4);
    expect(listener).toHaveBeenCalled();

    poller.dispose();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(callPlatform).toHaveBeenCalledTimes(4);
  });

  it('removes raw bodies, headers and credential material from diagnostics', async () => {
    vi.mocked(callPlatform).mockResolvedValueOnce({
      data: {
        code: 0,
        message: 'success',
        data: {
          items: [
            {
              id: 1,
              request_id: 'req-1',
              created_at: '2026-07-16T00:00:00Z',
              status: 'failed',
              error_message: 'upstream token=secret',
              request_body: 'private prompt',
              response_body: 'private response',
              headers: { authorization: 'Bearer secret' }
            }
          ],
          total: 1,
          page: 1,
          page_size: 20,
          pages: 1
        }
      },
      meta: {},
      requestId: 'list'
    });

    const page = await listOperationalResources('requestErrors', {
      page: 1,
      limit: 20,
      search: '',
      sort: '-created_at'
    });
    const serialized = JSON.stringify(page);
    expect(serialized).not.toContain('private prompt');
    expect(serialized).not.toContain('Bearer');
    expect(serialized).not.toContain('token=secret');
    expect(page.docs[0]).toMatchObject({ requestId: 'req-1', status: 'failed' });
  });

  it('rejects malformed page and record responses', async () => {
    vi.mocked(callPlatform)
      .mockResolvedValueOnce({
        data: { code: 0, data: { items: 'not-an-array' }, message: 'success' },
        meta: {},
        requestId: 'invalid-page'
      })
      .mockResolvedValueOnce({
        data: { code: 0, data: [], message: 'success' },
        meta: {},
        requestId: 'invalid-record'
      });

    await expect(listOperationalResources('usage', { page: 1, limit: 10 })).rejects.toThrow('分页格式不合法');
    await expect(getOperationalSnapshot('getRiskStatus')).rejects.toThrow('对象格式不合法');
  });

  it('redacts a complete scheme-prefixed authorization credential', async () => {
    vi.mocked(callPlatform).mockResolvedValueOnce({
      data: {
        code: 0,
        data: {
          items: [{ id: 1, request_id: 'req-auth', error_message: 'Authorization: Bearer abc123' }],
          page: 1,
          page_size: 10,
          pages: 1,
          total: 1
        },
        message: 'success'
      },
      meta: {},
      requestId: 'authorization-redaction'
    });

    const page = await listOperationalResources('requestErrors', { page: 1, limit: 10 });

    expect(JSON.stringify(page)).not.toContain('abc123');
  });
});
