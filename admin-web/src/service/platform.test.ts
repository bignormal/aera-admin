import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, apiRequest } from './http';
import { callPlatform, getPlatformReadiness } from './platform';

vi.mock('./http', async importOriginal => {
  const actual = await importOriginal<typeof import('./http')>();
  return { ...actual, apiRequest: vi.fn() };
});

describe('platform BFF client', () => {
  beforeEach(() => vi.mocked(apiRequest).mockReset());

  it('returns the fixed BFF success envelope', async () => {
    vi.mocked(apiRequest).mockResolvedValueOnce({
      data: { code: 0, message: 'success', data: { items: [] } },
      meta: { upstreamRequestId: 'upstream-1' },
      requestId: 'request-1'
    });

    await expect(callPlatform('listUsers', { params: { page: 1, page_size: 20 } })).resolves.toEqual({
      data: { code: 0, message: 'success', data: { items: [] } },
      meta: { upstreamRequestId: 'upstream-1' },
      requestId: 'request-1'
    });
    expect(apiRequest).toHaveBeenCalledWith('/platform/v1/listUsers?page=1&page_size=20', {
      method: 'GET',
      signal: undefined
    });
  });

  it('loads domain readiness only when explicitly requested', async () => {
    vi.mocked(apiRequest).mockResolvedValueOnce({
      data: { domains: [{ key: 'users', label: '平台用户', latencyMs: 8, status: 'healthy' }] },
      meta: { generatedAt: '2026-07-16T00:00:00Z' },
      requestId: 'readiness-1'
    });

    await expect(getPlatformReadiness()).resolves.toMatchObject({ data: { domains: [{ key: 'users' }] } });
    expect(apiRequest).toHaveBeenCalledWith('/platform/v1/readiness', { signal: undefined });
  });

  it.each([
    [503, 'backend-unavailable'],
    [403, 'forbidden']
  ] as const)('maps status %s and preserves the BFF request ID', async (status, kind) => {
    vi.mocked(apiRequest).mockRejectedValueOnce(
      new ApiError(status, '暂时无法完成', undefined, {
        error: { code: status === 503 ? 'UPSTREAM_NOT_CONFIGURED' : 'FORBIDDEN', message: '暂时无法完成' },
        requestId: 'request-error-1'
      })
    );

    await expect(callPlatform('listUsers')).rejects.toMatchObject({
      kind,
      requestId: 'request-error-1',
      status
    });
  });
});
