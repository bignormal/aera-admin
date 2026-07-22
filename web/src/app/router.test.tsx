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
      vi.fn(async (input: RequestInfo | URL) => {
        const path = String(input);
        if (path === '/api/v1/me') return sessionResponse('super_admin');
        if (path === '/api/v1/system/health') return healthResponse();
        if (path === '/api/v1/approval-requests?view=pending_for_me&limit=5') {
          return jsonResponse({ items: [] });
        }
        throw new Error(`unexpected request: ${path}`);
      }),
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
    expect(await screen.findByText('0 项待处理')).toBeInTheDocument();
    expect(screen.getByText('可用')).toBeInTheDocument();
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

  it('renders the real Cloud device and session page for developers', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => sessionResponse('developer')));
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={queryClient}>
        <AuthProvider>
          <RouterProvider router={createAppRouter(['/cloud/devices'])} />
        </AuthProvider>
      </QueryClientProvider>,
    );

    expect(await screen.findByRole('heading', { name: 'Cloud 设备与会话' })).toBeVisible();
  });

  it('rejects finance access to the Cloud device and session page', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => sessionResponse('finance')));
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={queryClient}>
        <AuthProvider>
          <RouterProvider router={createAppRouter(['/cloud/devices'])} />
        </AuthProvider>
      </QueryClientProvider>,
    );

    expect(await screen.findByText('无权访问此页面')).toBeVisible();
    expect(screen.queryByRole('heading', { name: 'Cloud 设备与会话' })).not.toBeInTheDocument();
  });

  it.each(['operator', 'super_admin'])('renders the real approval console for %s', async (role) => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const path = String(input);
        if (path === '/api/v1/me') return sessionResponse(role);
        if (path.startsWith('/api/v1/approval-requests?')) return jsonResponse({ items: [] });
        throw new Error(`unexpected request: ${path}`);
      }),
    );
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={queryClient}>
        <AuthProvider>
          <RouterProvider router={createAppRouter(['/approvals'])} />
        </AuthProvider>
      </QueryClientProvider>,
    );

    expect(await screen.findByRole('heading', { name: '处置审批' })).toBeVisible();
    expect(screen.getByText('审批结论与 Cloud 执行结果分别展示；批准不代表处置已经成功。')).toBeVisible();
  });

  it('renders the real scoped audit console for auditors', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const path = String(input);
        if (path === '/api/v1/me') return sessionResponse('auditor');
        if (path === '/api/v1/audit-events?limit=20') return jsonResponse({ items: [], next_cursor: null });
        throw new Error(`unexpected request: ${path}`);
      }),
    );
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={queryClient}>
        <AuthProvider>
          <RouterProvider router={createAppRouter(['/audit'])} />
        </AuthProvider>
      </QueryClientProvider>,
    );

    expect(await screen.findByRole('heading', { name: '审计记录' })).toBeVisible();
    expect(await screen.findByText('可查看全部管理员审计记录')).toBeVisible();
    expect(await screen.findByText('没有符合条件的审计记录')).toBeVisible();
  });

  it('renders the real safe health console for developers', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const path = String(input);
        if (path === '/api/v1/me') return sessionResponse('developer');
        if (path === '/api/v1/system/health') return healthResponse();
        throw new Error(`unexpected request: ${path}`);
      }),
    );
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={queryClient}>
        <AuthProvider>
          <RouterProvider router={createAppRouter(['/system/health'])} />
        </AuthProvider>
      </QueryClientProvider>,
    );

    expect(await screen.findByRole('heading', { name: '服务健康' })).toBeVisible();
    expect(await screen.findByText('Cloud 管理链路')).toBeVisible();
  });

  it.each([
    ['support', '/system/health', '服务健康'],
    ['finance', '/approvals', '处置审批'],
  ])('rejects %s direct access to %s', async (role, path, heading) => {
    vi.stubGlobal('fetch', vi.fn(async () => sessionResponse(role)));
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={queryClient}>
        <AuthProvider>
          <RouterProvider router={createAppRouter([path])} />
        </AuthProvider>
      </QueryClientProvider>,
    );

    expect(await screen.findByText('无权访问此页面')).toBeVisible();
    expect(screen.queryByRole('heading', { name: heading })).not.toBeInTheDocument();
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

function healthResponse(): Response {
  return jsonResponse({
    admin: 'ok',
    postgres: 'ok',
    redis: 'ok',
    cloud: {
      configured: true,
      availability: 'available',
      mtls: 'ok',
      service_jwt: 'ok',
      upstream: 'ok',
      checked_at: '2026-07-22T08:00:00Z',
    },
  });
}

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}
