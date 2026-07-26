import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { rolePermissions, type SessionDocument } from '../api/contracts';
import { AuthProvider } from '../auth/AuthProvider';
import { DashboardPage } from './DashboardPage';

afterEach(() => vi.unstubAllGlobals());

describe('DashboardPage', () => {
  it('shows real health and approval counts only after successful queries', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url === '/api/v1/me') return jsonResponse(sessionForSuperAdmin(), 200);
        if (url === '/api/v1/system/health') {
          return jsonResponse(
            {
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
            },
            200,
          );
        }
        if (url === '/api/v1/approval-requests?view=pending_for_me&limit=5') {
          return jsonResponse({ items: [{ id: 'one' }, { id: 'two' }] }, 200);
        }
        throw new Error(`unexpected request: ${url}`);
      }),
    );
    renderDashboard();

    expect(await screen.findByText('2 项待处理')).toBeVisible();
    expect(screen.getByText('Aera Cloud 管理链路')).toBeVisible();
    expect(screen.getByText('可用')).toBeVisible();
    expect(screen.getByText('未连接的数据源不会生成演示指标', { exact: false })).toBeVisible();
    expect(screen.queryByText('尚未接入')).not.toBeInTheDocument();
  });

  it('shows unavailable without inventing numeric values when sources fail', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url === '/api/v1/me') return jsonResponse(sessionForSuperAdmin(), 200);
        if (url === '/api/v1/system/health' || url.startsWith('/api/v1/approval-requests?')) {
          return jsonResponse({ error: { code: 'REQUEST_FAILED', message: '暂时不可用' } }, 503);
        }
        throw new Error(`unexpected request: ${url}`);
      }),
    );
    renderDashboard();

    expect((await screen.findAllByText('不可用')).length).toBeGreaterThanOrEqual(2);
    expect(screen.queryByText(/\d+ 项待处理/)).not.toBeInTheDocument();
    expect(screen.queryByText(/活跃用户数/)).not.toBeInTheDocument();
  });
});

function renderDashboard(): void {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <MemoryRouter>
          <DashboardPage />
        </MemoryRouter>
      </AuthProvider>
    </QueryClientProvider>,
  );
}

function sessionForSuperAdmin(): SessionDocument {
  return {
    csrf_token: 'csrf-in-memory-only',
    administrator: {
      admin_id: '019f0000-0000-7000-8000-000000000081',
      session_id: '019f0000-0000-7000-8000-000000000082',
      role: 'super_admin',
      permissions: [...(rolePermissions.super_admin ?? [])],
      security_version: 1,
      mfa_authenticated_at: '2026-07-22T08:00:00Z',
      totp_authenticated_at: '2026-07-22T08:00:00Z',
      mfa_method: 'totp',
    },
    display_name: '超级管理员',
    absolute_expires_at: '2026-07-22T18:00:00Z',
  };
}

function jsonResponse(value: unknown, status: number): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
