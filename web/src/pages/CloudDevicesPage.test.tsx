import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AdminRole, CloudDevice, CloudUser, SessionDocument } from '../api/contracts';
import { AuthProvider } from '../auth/AuthProvider';
import { CloudDevicesPage } from './CloudDevicesPage';

const operationID = '019f0000-0000-7000-8000-000000000091';

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
  sessionStorage.clear();
});

describe('CloudDevicesPage', () => {
  it('uses one idempotency key and never reports accepted as succeeded', async () => {
    const revokeCalls: RequestInit[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url === '/api/v1/me') return jsonResponse(sessionFor('support'), 200);
        if (url.endsWith('/devices?limit=100')) return jsonResponse({ items: [activeDevice()] }, 200);
        if (url.endsWith('/sessions?limit=100')) return jsonResponse({ items: [] }, 200);
        if (url.endsWith('/revoke')) {
          revokeCalls.push(init ?? {});
          return jsonResponse(
            { operation_id: operationID, state: 'queued', updated_at: '2026-07-22T08:00:00Z' },
            202,
          );
        }
        if (url.endsWith(`/operations/${operationID}`)) {
          return jsonResponse(
            {
              operation_id: operationID,
              state: 'reconciling',
              error_code: 'OPERATION_STATUS_UNKNOWN',
              updated_at: '2026-07-22T08:00:01Z',
            },
            200,
          );
        }
        if (url.endsWith(activeUser().user_id)) return jsonResponse(activeUser(), 200);
        throw new Error(`unexpected request: ${url}`);
      }),
    );
    renderDevices();
    const user = userEvent.setup();

    await user.type(await screen.findByLabelText('Cloud 用户 ID'), activeUser().user_id);
    await user.click(screen.getByRole('button', { name: '加载设备与会话' }));
    await user.click(await screen.findByRole('button', { name: '撤销设备' }));
    await user.click(screen.getByLabelText('标准原因'));
    await user.click(await screen.findByText('设备遗失'));
    const confirm = screen.getByRole('button', { name: '确认撤销' });
    fireEvent.click(confirm);
    fireEvent.click(confirm);

    await waitFor(() => expect(revokeCalls).toHaveLength(1));
    expect(new Headers(revokeCalls[0]?.headers).get('Idempotency-Key')).toMatch(/^[0-9a-f-]{36}$/);
    expect(await screen.findByText('状态未知，正在对账')).toBeVisible();
    expect(screen.queryByText('执行成功')).not.toBeInTheDocument();
  });

  it('lets developer inspect but never renders revoke controls', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url === '/api/v1/me') return jsonResponse(sessionFor('developer'), 200);
        if (url.endsWith('/devices?limit=100')) return jsonResponse({ items: [activeDevice()] }, 200);
        if (url.endsWith('/sessions?limit=100')) return jsonResponse({ items: [] }, 200);
        if (url.endsWith(activeUser().user_id)) return jsonResponse(activeUser(), 200);
        throw new Error(`unexpected request: ${url}`);
      }),
    );
    renderDevices();
    const user = userEvent.setup();

    await user.type(await screen.findByLabelText('Cloud 用户 ID'), activeUser().user_id);
    await user.click(screen.getByRole('button', { name: '加载设备与会话' }));

    expect(await screen.findByText('测试设备')).toBeVisible();
    expect(screen.queryByRole('button', { name: /撤销/ })).not.toBeInTheDocument();
  });
});

function renderDevices(): void {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <MemoryRouter>
          <CloudDevicesPage />
        </MemoryRouter>
      </AuthProvider>
    </QueryClientProvider>,
  );
}

function activeUser(): CloudUser {
  return {
    user_id: '019f0000-0000-7000-8000-000000000092',
    masked_email: 'd***@example.test',
    status: 'active',
    administratively_disabled: false,
    administrative_revision: 4,
    device_count: 1,
    active_device_count: 1,
    active_session_count: 0,
    created_at: '2026-07-20T08:00:00Z',
  };
}

function activeDevice(): CloudDevice {
  return {
    device_id: '019f0000-0000-7000-8000-000000000093',
    user_id: activeUser().user_id,
    display_name: '测试设备',
    platform: 'macOS',
    client_version: '1.0.0',
    status: 'active',
    last_seen_at: '2026-07-22T07:30:00Z',
  };
}

function sessionFor(role: AdminRole): SessionDocument {
  return {
    csrf_token: 'csrf-in-memory-only',
    administrator: {
      admin_id: '019f0000-0000-7000-8000-000000000094',
      session_id: '019f0000-0000-7000-8000-000000000095',
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
  return new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
}
