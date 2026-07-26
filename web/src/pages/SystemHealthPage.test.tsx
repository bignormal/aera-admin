import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { rolePermissions, type SessionDocument } from '../api/contracts';
import { AuthProvider } from '../auth/AuthProvider';
import { SystemHealthPage } from './SystemHealthPage';

afterEach(() => vi.unstubAllGlobals());

describe('SystemHealthPage', () => {
  it('shows Cloud authentication categories without addresses or key paths', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url === '/api/v1/me') return jsonResponse(sessionForDeveloper(), 200);
        if (url === '/api/v1/system/health') {
          return jsonResponse(
            {
              admin: 'ok',
              postgres: 'ok',
              redis: 'ok',
              cloud: {
                configured: true,
                availability: 'unavailable',
                mtls: 'ok',
                service_jwt: 'ok',
                upstream: 'unavailable',
                checked_at: '2026-07-22T08:00:00Z',
              },
            },
            200,
          );
        }
        throw new Error(`unexpected request: ${url}`);
      }),
    );
    renderHealth();

    expect(await screen.findByText('Cloud 管理链路')).toBeVisible();
    expect(screen.getByText('mTLS')).toBeVisible();
    expect(screen.getByText('服务令牌')).toBeVisible();
    expect(screen.getByText('Cloud 上游')).toBeVisible();
    expect(screen.getAllByText('暂时不可用')).toHaveLength(2);
    expect(document.body.textContent).not.toMatch(
      /\/run\/secrets|postgres:\/\/|redis:\/\/|BEGIN PRIVATE KEY|https?:\/\//,
    );
  });
});

function renderHealth(): void {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <MemoryRouter>
          <SystemHealthPage />
        </MemoryRouter>
      </AuthProvider>
    </QueryClientProvider>,
  );
}

function sessionForDeveloper(): SessionDocument {
  return {
    csrf_token: 'csrf-in-memory-only',
    administrator: {
      admin_id: '019f0000-0000-7000-8000-000000000071',
      session_id: '019f0000-0000-7000-8000-000000000072',
      role: 'developer',
      permissions: [...(rolePermissions.developer ?? [])],
      security_version: 1,
      mfa_authenticated_at: '2026-07-22T08:00:00Z',
      totp_authenticated_at: '2026-07-22T08:00:00Z',
      mfa_method: 'totp',
    },
    display_name: '开发人员',
    absolute_expires_at: '2026-07-22T18:00:00Z',
  };
}

function jsonResponse(value: unknown, status: number): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
