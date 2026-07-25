import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, apiRequest, setUnauthorizedHandler } from './http';

afterEach(() => {
  vi.unstubAllGlobals();
  setUnauthorizedHandler(undefined);
});

describe('apiRequest', () => {
  it('sends cookies and parses JSON', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      })
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(apiRequest<{ ok: boolean }>('/health')).resolves.toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledWith('/api/health', expect.objectContaining({ credentials: 'include' }));
  });

  it('maps nested Payload field errors', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            errors: [
              {
                message: '以下字段无效：稳定标识',
                data: { errors: [{ path: 'key', message: '稳定标识已存在' }] }
              }
            ]
          }),
          { status: 400, headers: { 'content-type': 'application/json' } }
        )
      )
    );

    await expect(apiRequest('/expert-categories')).rejects.toMatchObject({
      status: 400,
      fieldErrors: { key: '稳定标识已存在' }
    });
  });

  it('preserves a nested BFF error message', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ error: { code: 'FORBIDDEN', message: '仅超级管理员可验证真实资源。' } }), {
          status: 403,
          headers: { 'content-type': 'application/json' }
        })
      )
    );

    await expect(apiRequest('/platform/v1/readiness')).rejects.toMatchObject({
      message: '仅超级管理员可验证真实资源。',
      status: 403
    });
  });

  it('notifies on 401 but not on network failure', async () => {
    const unauthorized = vi.fn();
    setUnauthorizedHandler(unauthorized);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { status: 401 })));

    await expect(apiRequest('/admins/me')).rejects.toBeInstanceOf(ApiError);
    expect(unauthorized).toHaveBeenCalledOnce();

    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('offline')));
    await expect(apiRequest('/admins/me')).rejects.toMatchObject({ status: 0 });
    expect(unauthorized).toHaveBeenCalledOnce();
  });
});
