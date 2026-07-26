import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { rolePermissions, type AdminRole, type SessionDocument } from '../api/contracts';
import { AuthProvider } from '../auth/AuthProvider';
import { AuditPage } from './AuditPage';

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
  sessionStorage.clear();
});

describe('AuditPage', () => {
  it('submits safe filters, follows the cursor, and opens a safe detail drawer', async () => {
    const observed: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url === '/api/v1/me') return jsonResponse(sessionFor('super_admin'));
        if (url.startsWith('/api/v1/audit-events?')) {
          observed.push(url);
          if (url.includes('cursor=cursor-page-2')) {
            return jsonResponse({ items: [auditEvent('account_disabled')], next_cursor: null });
          }
          return jsonResponse({ items: [auditEvent('admin_login_succeeded')], next_cursor: 'cursor-page-2' });
        }
        throw new Error(`unexpected request: ${url}`);
      }),
    );
    renderAuditPage();
    const user = userEvent.setup();

    expect(await screen.findByText('admin_login_succeeded')).toBeVisible();
    expect(screen.getByText('可查看全部管理员审计记录')).toBeVisible();
    for (const forbidden of [
      'source_ip_hmac',
      'user_agent',
      'previous_hash',
      'event_hash',
      'identity.canary@example.test',
    ]) {
      expect(screen.queryByText(forbidden)).not.toBeInTheDocument();
    }

    await user.type(screen.getByLabelText('操作人 ID'), '019f0000-0000-7000-8000-000000000099');
    await user.type(screen.getByLabelText('事件类型'), 'account_disabled');
    await user.click(screen.getByRole('button', { name: '查询审计' }));
    await waitFor(() => {
      expect(
        observed.some(
          (url) =>
            url.includes('actor_admin_id=019f0000-0000-7000-8000-000000000099') &&
            url.includes('event_type=account_disabled'),
        ),
      ).toBe(true);
    });

    await user.click(screen.getByRole('button', { name: '查看详情' }));
    expect(await screen.findByRole('dialog', { name: '审计详情' })).toBeVisible();
    expect(screen.getByText('req-audit-safe')).toBeVisible();
    expect(screen.queryByText('identity.canary@example.test')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '关闭' }));

    await user.click(screen.getByRole('button', { name: '下一页' }));
    expect(await screen.findByText('account_disabled')).toBeVisible();
    expect(observed.some((url) => url.includes('cursor=cursor-page-2'))).toBe(true);
    expect(screen.getByRole('button', { name: '上一页' })).toBeEnabled();
  });

  it('labels and enforces the own-record view for support staff', async () => {
    const observed: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url === '/api/v1/me') return jsonResponse(sessionFor('support'));
        if (url.startsWith('/api/v1/audit-events?')) {
          observed.push(url);
          return jsonResponse({ items: [], next_cursor: null });
        }
        throw new Error(`unexpected request: ${url}`);
      }),
    );

    renderAuditPage();

    expect(await screen.findByText('仅显示本人操作记录')).toBeVisible();
    expect(screen.queryByLabelText('操作人 ID')).not.toBeInTheDocument();
    expect(await screen.findByText('没有符合条件的审计记录')).toBeVisible();
    expect(observed.every((url) => !url.includes('actor_admin_id='))).toBe(true);
  });
});

function renderAuditPage(): void {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <MemoryRouter>
          <AuditPage />
        </MemoryRouter>
      </AuthProvider>
    </QueryClientProvider>,
  );
}

function sessionFor(role: AdminRole): SessionDocument {
  return {
    csrf_token: 'csrf-in-memory-only',
    administrator: {
      admin_id: '019f0000-0000-7000-8000-000000000001',
      session_id: '019f0000-0000-7000-8000-000000000002',
      role,
      permissions: [...(rolePermissions[role] ?? [])],
      security_version: 1,
      mfa_authenticated_at: '2026-07-22T08:00:00Z',
      totp_authenticated_at: '2026-07-22T08:00:00Z',
      mfa_method: 'totp',
    },
    display_name: '内部人员',
    absolute_expires_at: '2026-07-22T18:00:00Z',
  };
}

function auditEvent(eventType: string) {
  return {
    id: '019f0000-0000-7000-8000-000000000010',
    actor_admin_id: '019f0000-0000-7000-8000-000000000001',
    actor_role: 'super_admin',
    event_type: eventType,
    object_type: 'cloud_user',
    object_id: '019f0000-0000-7000-8000-000000000020',
    outcome: 'success',
    reason_code: 'security_incident',
    approval_id: null,
    operation_id: null,
    before_state: {
      status: 'active',
      email: 'identity.canary@example.test',
    },
    after_state: { status: 'disabled' },
    request_id: 'req-audit-safe',
    created_at: '2026-07-22T09:00:00Z',
    source_ip_hmac: 'source_ip_hmac',
    user_agent: 'user_agent',
    previous_hash: 'previous_hash',
    event_hash: 'event_hash',
  };
}

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}
