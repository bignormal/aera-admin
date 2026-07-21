import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { SessionDocument } from '../api/contracts';
import { AuthProvider, useAuth } from './AuthProvider';

function session(displayName: string): SessionDocument {
  return {
    csrf_token: `csrf-${displayName}`,
    administrator: {
      admin_id: '019f0000-0000-7000-8000-000000000001',
      session_id: '019f0000-0000-7000-8000-000000000002',
      role: 'super_admin',
      security_version: 1,
      mfa_authenticated_at: '2026-07-21T10:00:00Z',
      totp_authenticated_at: '2026-07-21T10:00:00Z',
      mfa_method: 'totp',
    },
    display_name: displayName,
    absolute_expires_at: '2026-07-21T18:00:00Z',
  };
}

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

function SessionProbe() {
  const auth = useAuth();
  return (
    <div>
      <output aria-label="当前会话">{auth.session?.display_name ?? 'signed-out'}</output>
      <button type="button" onClick={() => void auth.establishSession(session('新会话'))}>建立会话</button>
      <button type="button" onClick={() => void auth.refreshSession().catch(() => undefined)}>刷新会话</button>
      <button type="button" onClick={() => void auth.logout().catch(() => undefined)}>退出</button>
    </div>
  );
}

function renderProvider() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <AuthProvider><SessionProbe /></AuthProvider>
    </QueryClientProvider>,
  );
}

afterEach(() => vi.unstubAllGlobals());

describe('AuthProvider session ordering', () => {
  it('does not let an older bootstrap response replace a newly established session', async () => {
    const bootstrap = deferred<Response>();
    const bootstrapSignals: AbortSignal[] = [];
    vi.stubGlobal('fetch', vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.signal) bootstrapSignals.push(init.signal);
      return bootstrap.promise;
    }));
    const user = userEvent.setup();
    renderProvider();

    await user.click(screen.getByRole('button', { name: '建立会话' }));
    expect(await screen.findByText('新会话')).toBeVisible();
    expect(bootstrapSignals[0]?.aborted).toBe(true);

    await act(async () => bootstrap.resolve(jsonResponse(session('旧会话'))));
    expect(screen.getByLabelText('当前会话')).toHaveTextContent('新会话');
  });

  it('does not let an older refresh response revive a logged-out session', async () => {
    const refresh = deferred<Response>();
    let meCalls = 0;
    const refreshSignals: AbortSignal[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        const path = String(input);
        if (path === '/api/v1/me') {
          meCalls += 1;
          if (meCalls === 2 && init?.signal) refreshSignals.push(init.signal);
          return meCalls === 1 ? Promise.resolve(jsonResponse(session('现有会话'))) : refresh.promise;
        }
        if (path === '/api/v1/auth/logout') return Promise.resolve(jsonResponse({ status: 'ok' }));
        throw new Error(`unexpected request: ${path}`);
      }),
    );
    const user = userEvent.setup();
    renderProvider();
    expect(await screen.findByText('现有会话')).toBeVisible();

    await user.click(screen.getByRole('button', { name: '刷新会话' }));
    await user.click(screen.getByRole('button', { name: '退出' }));
    expect(await screen.findByText('signed-out')).toBeVisible();
    expect(refreshSignals[0]?.aborted).toBe(true);

    await act(async () => refresh.resolve(jsonResponse(session('旧会话'))));
    expect(screen.getByLabelText('当前会话')).toHaveTextContent('signed-out');
  });
});
