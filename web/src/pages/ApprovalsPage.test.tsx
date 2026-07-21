import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type {
  AdminRole,
  ApprovalRequest,
  ApprovalStatus,
  ApprovalExecutionStatus,
  SessionDocument,
} from '../api/contracts';
import { AuthProvider } from '../auth/AuthProvider';
import { ApprovalsPage } from './ApprovalsPage';

const requesterID = '019f0000-0000-7000-8000-000000000061';
const reviewerID = '019f0000-0000-7000-8000-000000000062';
const operationID = '019f0000-0000-7000-8000-000000000063';

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
  sessionStorage.clear();
});

describe('ApprovalsPage', () => {
  it('shows approved and reconciling as different states without success language', async () => {
    const approval = approvalFixture({ approval_status: 'approved', execution_status: 'reconciling' });
    stubApprovalFetch('super_admin', reviewerID, approval);
    renderApprovals();

    expect(await screen.findByText('已批准')).toBeVisible();
    expect(screen.getByText('状态未知，正在对账')).toBeVisible();
    expect(screen.queryByText('执行成功')).not.toBeInTheDocument();
  });

  it('lets an operator cancel its own pending request but never approve it', async () => {
    const approval = approvalFixture({ approval_status: 'pending_review', execution_status: 'not_started' });
    stubApprovalFetch('operator', requesterID, approval);
    renderApprovals();

    expect(await screen.findByRole('button', { name: '撤回申请' })).toBeVisible();
    expect(screen.queryByRole('button', { name: '批准' })).not.toBeInTheDocument();
  });

  it('uses one stable idempotency key and remains queued after HTTP 202', async () => {
    const approval = approvalFixture({ approval_status: 'pending_review', execution_status: 'not_started' });
    const calls: RequestInit[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url === '/api/v1/me') return jsonResponse(sessionFor('super_admin', reviewerID), 200);
        if (url.endsWith('/approve')) {
          calls.push(init ?? {});
          return jsonResponse(
            {
              ...approval,
              approval_status: 'approved',
              execution_status: 'queued',
              operation_id: operationID,
              version: approval.version + 1,
            },
            202,
          );
        }
        if (url.startsWith('/api/v1/approval-requests?')) return jsonResponse({ items: [approval] }, 200);
        throw new Error(`unexpected request: ${url}`);
      }),
    );
    renderApprovals();
    const user = userEvent.setup();

    await user.click(await screen.findByRole('button', { name: '批准' }));
    const confirm = screen.getByRole('button', { name: '确认批准' });
    await user.dblClick(confirm);

    await waitFor(() => expect(calls).toHaveLength(1));
    expect(new Headers(calls[0]?.headers).get('Idempotency-Key')).toMatch(/^[0-9a-f-]{36}$/);
    expect(await screen.findByText('待执行')).toBeVisible();
    expect(screen.queryByText('执行成功')).not.toBeInTheDocument();
  });

  it('renders a stable review error without replacing the pending state', async () => {
    const approval = approvalFixture({ approval_status: 'pending_review', execution_status: 'not_started' });
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url === '/api/v1/me') return jsonResponse(sessionFor('super_admin', reviewerID), 200);
        if (url.endsWith('/approve')) {
          return jsonResponse({ error: { code: 'APPROVAL_EXPIRED', message: '审批已过期' } }, 409);
        }
        if (url.startsWith('/api/v1/approval-requests?')) return jsonResponse({ items: [approval] }, 200);
        throw new Error(`unexpected request: ${url}`);
      }),
    );
    renderApprovals();
    const user = userEvent.setup();

    await user.click(await screen.findByRole('button', { name: '批准' }));
    await user.click(screen.getByRole('button', { name: '确认批准' }));

    expect(await screen.findByText('审批已过期')).toBeVisible();
    expect(screen.getByText('待审批')).toBeVisible();
    expect(screen.queryByText('已批准')).not.toBeInTheDocument();
  });
});

function renderApprovals(): void {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <MemoryRouter>
          <ApprovalsPage />
        </MemoryRouter>
      </AuthProvider>
    </QueryClientProvider>,
  );
}

function stubApprovalFetch(
  role: AdminRole,
  adminID: string,
  approval: ApprovalRequest,
): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === '/api/v1/me') return jsonResponse(sessionFor(role, adminID), 200);
      if (url.startsWith('/api/v1/approval-requests?')) return jsonResponse({ items: [approval] }, 200);
      throw new Error(`unexpected request: ${url}`);
    }),
  );
}

function approvalFixture(overrides: {
  approval_status: ApprovalStatus;
  execution_status: ApprovalExecutionStatus;
}): ApprovalRequest {
  return {
    id: '019f0000-0000-7000-8000-000000000064',
    action: 'disable_user',
    target_user_id: '019f0000-0000-7000-8000-000000000065',
    target_snapshot: {
      user_id: '019f0000-0000-7000-8000-000000000065',
      masked_email: 'c***@example.test',
      status: 'active',
      administratively_disabled: false,
      administrative_revision: 3,
      device_count: 1,
      active_device_count: 1,
      active_session_count: 1,
      created_at: '2026-07-20T08:00:00Z',
    },
    requested_by_admin_id: requesterID,
    requested_by_role: 'operator',
    reason_code: 'policy_violation',
    ticket_reference: 'CASE-2026-007',
    note: '已完成内部复核',
    expected_revision: 3,
    approval_status: overrides.approval_status,
    execution_status: overrides.execution_status,
    operation_id: overrides.execution_status === 'not_started' ? undefined : operationID,
    expires_at: '2026-07-22T12:00:00Z',
    created_at: '2026-07-22T08:00:00Z',
    updated_at: '2026-07-22T08:01:00Z',
    version: 1,
  };
}

function sessionFor(role: AdminRole, adminID: string): SessionDocument {
  return {
    csrf_token: 'csrf-in-memory-only',
    administrator: {
      admin_id: adminID,
      session_id: '019f0000-0000-7000-8000-000000000066',
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

function jsonResponse(value: unknown, status: number): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
