import { afterEach, describe, expect, it, vi } from 'vitest';

import { postIdempotentJSON } from './client';

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
  sessionStorage.clear();
});

describe('postIdempotentJSON', () => {
  it('sends the caller key once without browser persistence', async () => {
    const fetch = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      new Response(
        JSON.stringify({
          operation_id: '019f0000-0000-7000-8000-000000000051',
          state: 'queued',
          updated_at: '2026-07-22T08:00:00Z',
        }),
        { status: 202, headers: { 'Content-Type': 'application/json' } },
      ),
    );
    vi.stubGlobal('fetch', fetch);
    const key = '019f0000-0000-7000-8000-000000000052';

    await postIdempotentJSON(
      '/cloud-sessions/019f0000-0000-7000-8000-000000000053/revoke',
      { expected_revision: 3 },
      key,
    );

    expect(fetch).toHaveBeenCalledTimes(1);
    const headers = new Headers(fetch.mock.calls[0]?.[1]?.headers);
    expect(headers.get('Idempotency-Key')).toBe(key);
    expect(localStorage.length).toBe(0);
    expect(sessionStorage.length).toBe(0);
  });

  it('rejects a malformed key before fetch', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);

    await expect(postIdempotentJSON('/probe', {}, 'short')).rejects.toThrow('Invalid idempotency key');
    expect(fetch).not.toHaveBeenCalled();
  });
});
