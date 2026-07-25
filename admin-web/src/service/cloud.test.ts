import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, apiRequest } from './http';
import { CloudServiceError, callCloud } from './cloud';

vi.mock('./http', async importOriginal => {
  const actual = await importOriginal<typeof import('./http')>();
  return { ...actual, apiRequest: vi.fn() };
});

describe('cloud service', () => {
  beforeEach(() => vi.mocked(apiRequest).mockReset());

  it('calls the cloud BFF with encoded operation and query parameters', async () => {
    vi.mocked(apiRequest).mockResolvedValueOnce({ data: { items: [] }, meta: {}, requestId: 'r1' });

    await callCloud('listCloudUsers', { params: { cursor: undefined, limit: 20, status: 'active' } });

    expect(apiRequest).toHaveBeenCalledWith('/cloud/v1/listCloudUsers?limit=20&status=active', {
      method: 'GET',
      body: undefined,
      signal: undefined
    });
  });

  it('maps 428 responses to the step-up-required error kind', async () => {
    vi.mocked(apiRequest).mockRejectedValueOnce(
      new ApiError(428, '需要二次验证', undefined, {
        error: { code: 'STEP_UP_REQUIRED', message: '该高风险操作需要重新完成 TOTP 二次验证。' },
        requestId: 'cloud-1'
      })
    );

    const failure = await callCloud('resetCloudUserPassword', { method: 'POST' }).catch(
      (error: unknown) => error
    );

    expect(failure).toBeInstanceOf(CloudServiceError);
    const typed = failure as CloudServiceError;
    expect(typed.kind).toBe('step-up-required');
    expect(typed.status).toBe(428);
    expect(typed.code).toBe('STEP_UP_REQUIRED');
    expect(typed.requestId).toBe('cloud-1');
  });

  it('maps 403 and 503 to forbidden and backend-unavailable', async () => {
    vi.mocked(apiRequest).mockRejectedValueOnce(new ApiError(403, '无权', undefined, {}));
    const forbidden = (await callCloud('listCloudUsers').catch((e: unknown) => e)) as CloudServiceError;
    expect(forbidden.kind).toBe('forbidden');

    vi.mocked(apiRequest).mockRejectedValueOnce(new ApiError(503, '上游不可用', undefined, {}));
    const unavailable = (await callCloud('listCloudUsers').catch((e: unknown) => e)) as CloudServiceError;
    expect(unavailable.kind).toBe('backend-unavailable');
  });
});
