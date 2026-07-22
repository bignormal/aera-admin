import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AuthProvider } from '../auth/AuthProvider';
import { AdministratorsPage } from './AdministratorsPage';

const session = {
  csrf_token: 'csrf-in-memory-only',
  administrator: {
    admin_id: '019f0000-0000-7000-8000-000000000001',
    session_id: '019f0000-0000-7000-8000-000000000002',
    role: 'super_admin',
    security_version: 1,
    mfa_authenticated_at: '2026-07-21T10:00:00Z',
    totp_authenticated_at: '2026-07-21T10:00:00Z',
    mfa_method: 'totp',
  },
  display_name: '首席管理员',
  absolute_expires_at: '2026-07-21T18:00:00Z',
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('AdministratorsPage', () => {
  it('renders only the backend-masked identity and fixed role data', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const path = String(input);
        if (path === '/api/v1/me') {
          return new Response(JSON.stringify(session), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        if (path === '/api/v1/admin-users') {
          return new Response(
            JSON.stringify({
              items: [
                {
                  id: '019f0000-0000-7000-8000-000000000001',
                  masked_identity: 'a***@example.com',
                  display_name: '首席管理员',
                  role: 'super_admin',
                  status: 'active',
                  mfa_enabled: true,
                  security_version: 1,
                  last_login_at: '2026-07-21T10:00:00Z',
                  created_at: '2026-07-20T10:00:00Z',
                  updated_at: '2026-07-21T10:00:00Z',
                },
              ],
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          );
        }
        throw new Error(`unexpected request: ${path}`);
      }),
    );
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    render(
      <QueryClientProvider client={queryClient}>
        <AuthProvider>
          <MemoryRouter>
            <AdministratorsPage />
          </MemoryRouter>
        </AuthProvider>
      </QueryClientProvider>,
    );

    expect(await screen.findByText('a***@example.com')).toBeVisible();
    expect(screen.queryByText('admin@example.com')).not.toBeInTheDocument();
    expect(screen.getByText('超级管理员')).toBeVisible();
    expect(screen.getByRole('button', { name: /邀请管理员/ })).toBeEnabled();
  });

  it('keeps a protected operation locked while replaying it after step-up', async () => {
    let revokeCalls = 0;
    const protectedRequests: Array<{ path: string; csrf: string | null; body: unknown }> = [];
    let finishReplay!: () => void;
    const replay = new Promise<Response>((resolve) => {
      finishReplay = () => resolve(new Response(JSON.stringify({ status: 'ok' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }));
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const path = String(input);
        if (path === '/api/v1/me') {
          return new Response(JSON.stringify(session), { status: 200, headers: { 'Content-Type': 'application/json' } });
        }
        if (path === '/api/v1/admin-users') {
          return new Response(JSON.stringify({
            items: [{
              id: '019f0000-0000-7000-8000-000000000009',
              masked_identity: 'o***@example.com',
              display_name: '运营人员',
              role: 'operator',
              status: 'active',
              mfa_enabled: true,
              security_version: 1,
              created_at: '2026-07-20T10:00:00Z',
              updated_at: '2026-07-21T10:00:00Z',
            }],
          }), { status: 200, headers: { 'Content-Type': 'application/json' } });
        }
        if (path.endsWith('/sessions/revoke')) {
          protectedRequests.push({
            path,
            csrf: new Headers(init?.headers).get('X-CSRF-Token'),
            body: typeof init?.body === 'string' ? JSON.parse(init.body) : null,
          });
          revokeCalls += 1;
          if (revokeCalls === 1) {
            return new Response(JSON.stringify({ error: { code: 'STEP_UP_REQUIRED', message: '需要二次验证' } }), {
              status: 403,
              headers: { 'Content-Type': 'application/json' },
            });
          }
          return replay;
        }
        if (path === '/api/v1/system/reason-codes?usage=session') {
          return new Response(JSON.stringify({
            items: [reason('suspected_compromise', 'security', '疑似凭证泄露')],
            settings_revision: 4,
          }), { status: 200, headers: { 'Content-Type': 'application/json' } });
        }
        if (path === '/api/v1/auth/step-up') {
          protectedRequests.push({
            path,
            csrf: new Headers(init?.headers).get('X-CSRF-Token'),
            body: typeof init?.body === 'string' ? JSON.parse(init.body) : null,
          });
          return new Response(JSON.stringify(session), { status: 200, headers: { 'Content-Type': 'application/json' } });
        }
        throw new Error(`unexpected request: ${path}`);
      }),
    );
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const user = userEvent.setup();
    render(
      <QueryClientProvider client={queryClient}>
        <AuthProvider>
          <MemoryRouter><AdministratorsPage /></MemoryRouter>
        </AuthProvider>
      </QueryClientProvider>,
    );

    await user.click(await screen.findByRole('button', { name: '撤销会话' }));
    await user.click(await screen.findByRole('combobox', { name: '标准原因' }));
    await user.click(await screen.findByText('疑似凭证泄露'));
    await user.click(screen.getByRole('button', { name: '确认执行' }));
    await user.type(await screen.findByLabelText('二次验证动态验证码'), '123456');
    await user.click(screen.getByRole('button', { name: '验证并继续' }));

    await waitFor(() => expect(revokeCalls).toBe(2));
    expect(screen.getByRole('button', { name: /验证并继续/ })).toBeDisabled();
    expect(screen.getByRole('button', { name: /确认执行/ })).toBeDisabled();

    await act(async () => finishReplay());
    await waitFor(() => expect(screen.queryByText('高风险操作二次验证')).not.toBeInTheDocument());
    expect(revokeCalls).toBe(2);
    expect(protectedRequests).toEqual([
      {
        path: '/api/v1/admin-users/019f0000-0000-7000-8000-000000000009/sessions/revoke',
        csrf: 'csrf-in-memory-only',
        body: { reason_code: 'suspected_compromise', ticket_reference: '', note: '' },
      },
      {
        path: '/api/v1/auth/step-up',
        csrf: 'csrf-in-memory-only',
        body: { totp_code: '123456' },
      },
      {
        path: '/api/v1/admin-users/019f0000-0000-7000-8000-000000000009/sessions/revoke',
        csrf: 'csrf-in-memory-only',
        body: { reason_code: 'suspected_compromise', ticket_reference: '', note: '' },
      },
    ]);
  });

  it('keeps a one-time invitation visible when clipboard access fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const path = String(input);
        if (path === '/api/v1/me') {
          return new Response(JSON.stringify(session), { status: 200, headers: { 'Content-Type': 'application/json' } });
        }
        if (path === '/api/v1/admin-users') {
          return new Response(JSON.stringify({ items: [] }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        if (path === '/api/v1/admin-users/invitations') {
          return new Response(JSON.stringify({
            invitation_id: '019f0000-0000-7000-8000-000000000010',
            admin_id: '019f0000-0000-7000-8000-000000000011',
            activation_url: 'https://admin.example.test/activate#token=one-time-secret',
            expires_at: '2026-07-21T11:00:00Z',
          }), { status: 201, headers: { 'Content-Type': 'application/json' } });
        }
        if (path === '/api/v1/system/reason-codes?usage=administrator') {
          return new Response(JSON.stringify({
            items: [reason('staff_change', 'administrator', '人员或职责变更')],
            settings_revision: 4,
          }), { status: 200, headers: { 'Content-Type': 'application/json' } });
        }
        throw new Error(`unexpected request: ${path}`);
      }),
    );
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const user = userEvent.setup();
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: vi.fn().mockRejectedValue(new Error('clipboard denied')) },
    });
    render(
      <QueryClientProvider client={queryClient}>
        <AuthProvider>
          <MemoryRouter><AdministratorsPage /></MemoryRouter>
        </AuthProvider>
      </QueryClientProvider>,
    );

    await user.click(await screen.findByRole('button', { name: /邀请管理员/ }));
    await user.type(screen.getByLabelText('邀请邮箱'), 'support@example.com');
    await user.type(screen.getByLabelText('显示名称'), '客服人员');
    await user.click(await screen.findByRole('combobox', { name: '标准原因' }));
    await user.click(await screen.findByText('人员或职责变更'));
    await user.click(screen.getByRole('button', { name: /生成一次性激活链接/ }));

    const oneTimeLink = await screen.findByText('https://admin.example.test/activate#token=one-time-secret');
    await waitFor(() => expect(oneTimeLink).toBeVisible());
    await user.click(screen.getByRole('button', { name: /复制链接/ }));
    expect(await screen.findByText('复制失败，请手动选择并安全转交激活链接')).toBeVisible();
    expect(screen.getByText('https://admin.example.test/activate#token=one-time-secret')).toBeVisible();
  });
});

function reason(code: string, category: string, label: string) {
  return {
    code,
    category,
    label,
    active: true,
    revision: 1,
    created_at: '2026-07-22T08:00:00Z',
    updated_at: '2026-07-22T08:00:00Z',
  };
}
