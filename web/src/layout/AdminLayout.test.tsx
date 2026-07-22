import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AuthProvider } from '../auth/AuthProvider';
import { AdminLayout } from './AdminLayout';

function sessionFor(role: string) {
  return {
    csrf_token: 'csrf-in-memory-only',
    administrator: {
      admin_id: '019f0000-0000-7000-8000-000000000001',
      session_id: '019f0000-0000-7000-8000-000000000002',
      role,
      security_version: 1,
      mfa_authenticated_at: '2026-07-21T10:00:00Z',
      totp_authenticated_at: '2026-07-21T10:00:00Z',
      mfa_method: 'totp',
    },
    display_name: '测试人员',
    absolute_expires_at: '2026-07-21T18:00:00Z',
  };
}

function renderLayout(role: string) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      new Response(JSON.stringify(sessionFor(role)), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    ),
  );
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <MemoryRouter>
          <AdminLayout />
        </MemoryRouter>
      </AuthProvider>
    </QueryClientProvider>,
  );
}

afterEach(() => vi.unstubAllGlobals());

describe('AdminLayout', () => {
  it('renders the approved phase-one navigation for a super admin', async () => {
    renderLayout('super_admin');

    const menu = within(await screen.findByRole('menu'));
    for (const label of [
      '工作台',
      '内部管理员',
      '角色与权限',
      '用户与访问',
      '设备与会话',
      '处置审批',
      '审计记录',
      '系统设置',
      '服务健康',
    ]) {
      expect(menu.getByText(label)).toBeInTheDocument();
    }
    expect(screen.getByText('Aera Admin')).toBeInTheDocument();
    expect(screen.getByText('内部运营控制台')).toBeInTheDocument();
  });

  it('does not render administrator management for support', async () => {
    renderLayout('support');

    const menu = within(await screen.findByRole('menu'));
    expect(menu.queryByText('内部管理员')).not.toBeInTheDocument();
    expect(menu.queryByText('角色与权限')).not.toBeInTheDocument();
    expect(menu.getByText('用户与访问')).toBeInTheDocument();
    expect(menu.queryByText('系统设置')).not.toBeInTheDocument();
  });

  it('renders system settings navigation for the read-only auditor role', async () => {
    renderLayout('auditor');

    const menu = within(await screen.findByRole('menu'));
    expect(menu.getByText('系统设置')).toBeInTheDocument();
  });
});
