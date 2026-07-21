import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AdminRole, CloudUser, SessionDocument } from '../api/contracts';
import { AuthProvider } from '../auth/AuthProvider';
import { CloudUsersPage } from './CloudUsersPage';

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
  sessionStorage.clear();
});

describe('CloudUsersPage', () => {
  it('uses a POST mutation for exact identity and clears every raw value after success', async () => {
    const rawIdentity = 'lookup.canary@example.test';
    const observed: Array<{ url: string; method: string; body?: string }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const method = init?.method ?? 'GET';
        observed.push({ url, method, body: typeof init?.body === 'string' ? init.body : undefined });
        if (url === '/api/v1/me') return jsonResponse(sessionFor('support'), 200);
        if (url === '/api/v1/cloud-users/lookup') return jsonResponse(maskedUser(), 200);
        if (url.startsWith('/api/v1/cloud-users')) return jsonResponse({ items: [] }, 200);
        throw new Error(`unexpected request: ${url}`);
      }),
    );
    const queryClient = renderCloudUsers();
    const user = userEvent.setup();

    await user.type(await screen.findByLabelText('完整邮箱或手机号'), rawIdentity);
    await user.click(screen.getByRole('button', { name: '精确查找' }));

    expect(await screen.findByText('l***@example.test')).toBeVisible();
    expect(screen.getByLabelText('完整邮箱或手机号')).toHaveValue('');
    const lookup = observed.find((item) => item.url === '/api/v1/cloud-users/lookup');
    expect(lookup?.method).toBe('POST');
    expect(lookup?.body).toContain(rawIdentity);
    expect(observed.some((item) => item.url.includes(rawIdentity))).toBe(false);
    expect(JSON.stringify(queryClient.getQueryCache().getAll().map((query) => query.queryKey))).not.toContain(
      rawIdentity,
    );
    expect(
      JSON.stringify(queryClient.getMutationCache().getAll().map((mutation) => mutation.state.variables)),
    ).not.toContain(rawIdentity);
    expect(localStorage.length).toBe(0);
    expect(sessionStorage.length).toBe(0);
  });

  it('renders explicit Cloud-unavailable state without invented rows', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        if (String(input) === '/api/v1/me') return jsonResponse(sessionFor('operator'), 200);
        return jsonResponse({ error: { code: 'CLOUD_UNAVAILABLE', message: 'unavailable' } }, 503);
      }),
    );

    renderCloudUsers();

    expect(await screen.findByText('Cloud 管理服务暂时不可用')).toBeVisible();
    expect(screen.queryByRole('row', { name: /example/ })).not.toBeInTheDocument();
  });
});

function renderCloudUsers(): QueryClient {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <MemoryRouter>
          <CloudUsersPage />
        </MemoryRouter>
      </AuthProvider>
    </QueryClientProvider>,
  );
  return queryClient;
}

function sessionFor(role: AdminRole): SessionDocument {
  return {
    csrf_token: 'csrf-in-memory-only',
    administrator: {
      admin_id: '019f0000-0000-7000-8000-000000000001',
      session_id: '019f0000-0000-7000-8000-000000000002',
      role,
      security_version: 1,
      mfa_authenticated_at: '2026-07-22T08:00:00Z',
      totp_authenticated_at: '2026-07-22T08:00:00Z',
      mfa_method: 'totp',
    },
    display_name: '内部人员',
    absolute_expires_at: '2026-07-22T18:00:00Z',
  };
}

function maskedUser(): CloudUser {
  return {
    user_id: '019f0000-0000-7000-8000-000000000071',
    masked_email: 'l***@example.test',
    status: 'active',
    administratively_disabled: false,
    administrative_revision: 3,
    device_count: 2,
    active_device_count: 1,
    active_session_count: 1,
    created_at: '2026-07-20T08:00:00Z',
    last_cloud_activity_at: '2026-07-22T07:30:00Z',
  };
}

function jsonResponse(value: unknown, status: number): Response {
  return new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
}
