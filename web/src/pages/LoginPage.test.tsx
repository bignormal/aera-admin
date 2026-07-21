import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AuthProvider } from '../auth/AuthProvider';
import { LoginPage } from './LoginPage';

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function renderLogin() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <MemoryRouter>
          <LoginPage />
        </MemoryRouter>
      </AuthProvider>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  window.localStorage.clear();
  window.sessionStorage.clear();
});

describe('LoginPage', () => {
  it('does not persist credentials and advances to mandatory TOTP', async () => {
    const requests: Array<{ path: string; body?: string }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const path = String(input);
        requests.push({ path, body: typeof init?.body === 'string' ? init.body : undefined });
        if (path === '/api/v1/me') {
          return jsonResponse({ error: { code: 'AUTH_REQUIRED', message: '需要登录' } }, 401);
        }
        if (path === '/api/v1/auth/login') {
          return jsonResponse({ challenge_id: 'challenge-1', expires_at: '2026-07-21T10:05:00Z' });
        }
        throw new Error(`unexpected request: ${path}`);
      }),
    );

    const user = userEvent.setup();
    renderLogin();
    await user.type(await screen.findByLabelText('内部邮箱'), 'admin@example.com');
    const password = screen.getByLabelText('密码');
    await user.type(password, 'correct horse battery staple');
    await user.click(screen.getByRole('button', { name: /继\s*续/ }));

    expect(await screen.findByLabelText('动态验证码')).toBeVisible();
    expect(password).not.toBeInTheDocument();
    expect(window.localStorage).toHaveLength(0);
    expect(window.sessionStorage).toHaveLength(0);
    expect(requests.find((request) => request.path.endsWith('/auth/login'))?.body).toBe(
      JSON.stringify({ email: 'admin@example.com', password: 'correct horse battery staple' }),
    );

    await user.click(screen.getByRole('button', { name: '返回密码登录' }));
    expect(screen.getByLabelText('内部邮箱')).toHaveValue('');
  });

  it('clears a rejected TOTP and keeps the challenge only in memory', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input);
      if (path === '/api/v1/me') {
        return jsonResponse({ error: { code: 'AUTH_REQUIRED', message: '需要登录' } }, 401);
      }
      if (path === '/api/v1/auth/login') {
        return jsonResponse({ challenge_id: 'challenge-2', expires_at: '2026-07-21T10:05:00Z' });
      }
      if (path === '/api/v1/auth/totp/verify') {
        return jsonResponse(
          { error: { code: 'AUTH_INVALID_CREDENTIALS', message: '管理员凭证无效' } },
          401,
        );
      }
      throw new Error(`unexpected request: ${path}`);
    });
    vi.stubGlobal(
      'fetch',
      fetchMock,
    );

    const user = userEvent.setup();
    renderLogin();
    await user.type(await screen.findByLabelText('内部邮箱'), 'admin@example.com');
    await user.type(screen.getByLabelText('密码'), 'correct horse battery staple');
    await user.click(screen.getByRole('button', { name: /继\s*续/ }));
    const totp = await screen.findByLabelText('动态验证码');
    await user.type(totp, '123456');
    expect(totp).toHaveValue('123456');
    await user.click(screen.getByRole('button', { name: /安\s*全\s*登\s*录/ }));

    await waitFor(() =>
      expect(fetchMock.mock.calls.some(([input]) => String(input) === '/api/v1/auth/totp/verify')).toBe(true),
    );
    await waitFor(() => expect(screen.getByLabelText('动态验证码')).toHaveValue(''));
    expect(await screen.findByText('管理员凭证无效')).toBeVisible();
    expect(JSON.stringify(window.localStorage)).not.toContain('challenge-2');
    expect(JSON.stringify(window.sessionStorage)).not.toContain('challenge-2');
  });
});
