import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { RouterProvider } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AuthProvider } from '../auth/AuthProvider';
import { createAppRouter } from './router';

afterEach(() => vi.unstubAllGlobals());

describe('application router', () => {
  it('renders the security-foundation dashboard without invented metrics', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(
          JSON.stringify({
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
            display_name: '管理员',
            absolute_expires_at: '2026-07-21T18:00:00Z',
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      ),
    );
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={queryClient}>
        <AuthProvider>
          <RouterProvider router={createAppRouter(['/dashboard'])} />
        </AuthProvider>
      </QueryClientProvider>,
    );

    expect(await screen.findByRole('heading', { name: '内部运营工作台' })).toBeInTheDocument();
    expect(screen.getByText('管理员安全底座')).toBeInTheDocument();
    expect(screen.getByText('Aera Cloud 管理链路')).toBeInTheDocument();
    expect(screen.getByText('尚未接入')).toBeInTheDocument();
    expect(screen.queryByText(/活跃用户数/)).not.toBeInTheDocument();
  });

  it('rejects a support user who navigates directly to administrator management', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            csrf_token: 'csrf-in-memory-only',
            administrator: {
              admin_id: '019f0000-0000-7000-8000-000000000003',
              session_id: '019f0000-0000-7000-8000-000000000004',
              role: 'support',
              security_version: 1,
              mfa_authenticated_at: '2026-07-21T10:00:00Z',
              totp_authenticated_at: '2026-07-21T10:00:00Z',
              mfa_method: 'totp',
            },
            display_name: '客服人员',
            absolute_expires_at: '2026-07-21T18:00:00Z',
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      ),
    );
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={queryClient}>
        <AuthProvider>
          <RouterProvider router={createAppRouter(['/security/admins'])} />
        </AuthProvider>
      </QueryClientProvider>,
    );

    expect(await screen.findByText('无权访问此页面')).toBeVisible();
    expect(screen.queryByRole('heading', { name: '内部管理员' })).not.toBeInTheDocument();
  });

  it('renders the real masked Cloud user page for support', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const path = String(input);
        if (path === '/api/v1/me') return sessionResponse('support');
        if (path.startsWith('/api/v1/cloud-users')) {
          return new Response(JSON.stringify({ items: [] }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        throw new Error(`unexpected request: ${path}`);
      }),
    );
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={queryClient}>
        <AuthProvider>
          <RouterProvider router={createAppRouter(['/cloud/users'])} />
        </AuthProvider>
      </QueryClientProvider>,
    );

    expect(await screen.findByRole('heading', { name: 'Cloud 用户与访问' })).toBeVisible();
    expect(await screen.findByText('没有符合条件的数据')).toBeVisible();
  });

  it('rejects finance access to the Cloud user page', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => sessionResponse('finance')));
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={queryClient}>
        <AuthProvider>
          <RouterProvider router={createAppRouter(['/cloud/users'])} />
        </AuthProvider>
      </QueryClientProvider>,
    );

    expect(await screen.findByText('无权访问此页面')).toBeVisible();
    expect(screen.queryByRole('heading', { name: 'Cloud 用户与访问' })).not.toBeInTheDocument();
  });
});

function sessionResponse(role: string): Response {
  return new Response(
    JSON.stringify({
      csrf_token: 'csrf-in-memory-only',
      administrator: {
        admin_id: '019f0000-0000-7000-8000-000000000081',
        session_id: '019f0000-0000-7000-8000-000000000082',
        role,
        security_version: 1,
        mfa_authenticated_at: '2026-07-22T08:00:00Z',
        totp_authenticated_at: '2026-07-22T08:00:00Z',
        mfa_method: 'totp',
      },
      display_name: '内部人员',
      absolute_expires_at: '2026-07-22T18:00:00Z',
    }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  );
}
