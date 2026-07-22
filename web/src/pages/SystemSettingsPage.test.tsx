import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AdminRole, SessionDocument } from '../api/contracts';
import { AuthProvider } from '../auth/AuthProvider';
import { SystemSettingsPage } from './SystemSettingsPage';

afterEach(() => vi.unstubAllGlobals());

describe('SystemSettingsPage', () => {
  it('renders the policy and full reason catalog read-only for auditors', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === '/api/v1/me') return jsonResponse(sessionFor('auditor'), 200);
      if (url === '/api/v1/system/settings') return jsonResponse(policy(4), 200);
      if (url === '/api/v1/system/reason-codes?include_inactive=true') {
        return jsonResponse({
          items: [reason('staff_change', 'administrator', '人员变更', false)],
          settings_revision: 4,
        }, 200);
      }
      throw new Error(`unexpected request: ${url}`);
    }));

    renderSettings();

    expect(await screen.findByText('只读模式')).toBeVisible();
    expect(await screen.findByLabelText('会话空闲超时（分钟）')).toHaveValue('30');
    expect(screen.getByText('设置修订号：4')).toBeVisible();
    expect(screen.getByText('人员变更')).toBeVisible();
    expect(screen.getByText('已停用')).toBeVisible();
    expect(screen.queryByRole('button', { name: '保存安全策略' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /新增原因码/ })).not.toBeInTheDocument();
  });

  it('replays the same idempotent policy mutation after step-up and clears a revoked session', async () => {
    const policyWrites: Array<{ key: string | null; body: Record<string, unknown> }> = [];
    let writeCalls = 0;
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === '/api/v1/me') return jsonResponse(sessionFor('super_admin'), 200);
      if (url === '/api/v1/system/settings' && (!init?.method || init.method === 'GET')) return jsonResponse(policy(4), 200);
      if (url === '/api/v1/system/reason-codes?include_inactive=true') {
        return jsonResponse({ items: [reason('security_policy_change', 'security', '安全策略调整')], settings_revision: 4 }, 200);
      }
      if (url === '/api/v1/system/reason-codes?usage=settings') {
        return jsonResponse({ items: [reason('security_policy_change', 'security', '安全策略调整')], settings_revision: 4 }, 200);
      }
      if (url === '/api/v1/system/settings/security-policy') {
        policyWrites.push({
          key: new Headers(init?.headers).get('Idempotency-Key'),
          body: JSON.parse(String(init?.body)) as Record<string, unknown>,
        });
        writeCalls += 1;
        if (writeCalls === 1) {
          return jsonResponse({ error: { code: 'STEP_UP_REQUIRED', message: '需要二次验证' } }, 403);
        }
        return jsonResponse({ operation_id: '019f0000-0000-7000-8000-000000000099', policy: policy(5, 45), sessions_revoked: true }, 200);
      }
      if (url === '/api/v1/auth/step-up') return jsonResponse(sessionFor('super_admin'), 200);
      throw new Error(`unexpected request: ${url}`);
    }));
    const user = userEvent.setup();
    renderSettings();

    expect(await screen.findByText('会话时长变更会撤销全部管理员会话')).toBeVisible();
    const idle = screen.getByLabelText('会话空闲超时（分钟）');
    await user.clear(idle);
    await user.type(idle, '45');
    await chooseSelectOption(user, '策略变更原因', '安全策略调整');
    await user.click(screen.getByRole('button', { name: '保存安全策略' }));
    await user.type(await screen.findByLabelText('二次验证动态验证码'), '123456');
    await user.click(screen.getByRole('button', { name: '验证并继续' }));

    expect(await screen.findByText('LOGIN_TARGET')).toBeVisible();
    expect(policyWrites).toHaveLength(2);
    expect(policyWrites[0]?.key).toMatch(/^[0-9a-f-]{36}$/);
    expect(policyWrites[1]?.key).toBe(policyWrites[0]?.key);
    expect(policyWrites[0]?.body).toMatchObject({
      expected_revision: 4,
      session_idle_minutes: 45,
      session_absolute_hours: 12,
      audit_retention_days: 730,
      reason_code: 'security_policy_change',
    });
  });

  it('refreshes both policy and catalog after a revision conflict', async () => {
    let policyReads = 0;
    let catalogReads = 0;
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === '/api/v1/me') return jsonResponse(sessionFor('super_admin'), 200);
      if (url === '/api/v1/system/settings') {
        policyReads += 1;
        return jsonResponse(policy(policyReads === 1 ? 4 : 5), 200);
      }
      if (url === '/api/v1/system/reason-codes?include_inactive=true') {
        catalogReads += 1;
        return jsonResponse({ items: [reason('security_policy_change', 'security', '安全策略调整')], settings_revision: policyReads === 1 ? 4 : 5 }, 200);
      }
      if (url === '/api/v1/system/reason-codes?usage=settings') {
        return jsonResponse({ items: [reason('security_policy_change', 'security', '安全策略调整')], settings_revision: policyReads === 1 ? 4 : 5 }, 200);
      }
      if (url === '/api/v1/system/settings/security-policy') {
        return jsonResponse({ error: { code: 'SETTINGS_REVISION_CONFLICT', message: '版本冲突' } }, 409);
      }
      throw new Error(`unexpected request: ${url}`);
    }));
    const user = userEvent.setup();
    renderSettings();

    await chooseSelectOption(user, '策略变更原因', '安全策略调整');
    await user.click(screen.getByRole('button', { name: '保存安全策略' }));

    expect(await screen.findByText('设置版本已变化，已刷新最新策略和原因目录')).toBeVisible();
    await waitFor(() => expect(screen.getByText('设置修订号：5')).toBeVisible());
    expect(policyReads).toBeGreaterThanOrEqual(2);
    expect(catalogReads).toBeGreaterThanOrEqual(2);
  });

  it('creates and updates reason codes with revision-bound idempotent requests', async () => {
    const writes: Array<{ url: string; method: string; key: string | null; body: Record<string, unknown> }> = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      if (url === '/api/v1/me') return jsonResponse(sessionFor('super_admin'), 200);
      if (url === '/api/v1/system/settings') return jsonResponse(policy(4), 200);
      if (url === '/api/v1/system/reason-codes?include_inactive=true') {
        return jsonResponse({
          items: [
            reason('reason_catalog_change', 'security', '原因目录调整'),
            reason('staff_change', 'administrator', '人员变更'),
          ],
          settings_revision: 4,
        }, 200);
      }
      if (url === '/api/v1/system/reason-codes?usage=settings') {
        return jsonResponse({ items: [reason('reason_catalog_change', 'security', '原因目录调整')], settings_revision: 4 }, 200);
      }
      if (url === '/api/v1/system/reason-codes' && method === 'POST') {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        writes.push({ url, method, key: new Headers(init?.headers).get('Idempotency-Key'), body });
        return jsonResponse({
          operation_id: '019f0000-0000-7000-8000-000000000081',
          reason: reason(String(body.code), String(body.category), String(body.label)),
          settings_revision: 5,
        }, 201);
      }
      if (url === '/api/v1/system/reason-codes/staff_change' && method === 'PUT') {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        writes.push({ url, method, key: new Headers(init?.headers).get('Idempotency-Key'), body });
        return jsonResponse({
          operation_id: '019f0000-0000-7000-8000-000000000082',
          reason: { ...reason('staff_change', 'administrator', String(body.label)), active: body.active, revision: 2 },
          settings_revision: 5,
        }, 200);
      }
      throw new Error(`unexpected request: ${url} ${method}`);
    }));
    const user = userEvent.setup();
    renderSettings();

    await screen.findByText('人员变更', {}, { timeout: 3_000 });
    await user.click(screen.getByRole('button', { name: /新增原因码/ }));
    await user.type(screen.getByLabelText('原因码'), 'account_review');
    await chooseSelectOption(user, '原因分类', '账号');
    await user.type(screen.getByLabelText('显示名称'), '账号复核');
    await chooseSelectOption(user, '目录变更原因', '原因目录调整');
    await user.click(screen.getByRole('button', { name: '确认创建' }));
    await waitFor(() => expect(writes).toHaveLength(1));

    await user.click(screen.getByRole('button', { name: '编辑 staff_change' }));
    const label = screen.getByLabelText('显示名称');
    await user.clear(label);
    await user.type(label, '人员职责变更');
    await chooseSelectOption(user, '目录变更原因', '原因目录调整');
    await user.click(screen.getByRole('button', { name: '确认更新' }));
    await waitFor(() => expect(writes).toHaveLength(2));

    expect(writes[0]).toMatchObject({
      url: '/api/v1/system/reason-codes',
      method: 'POST',
      body: { code: 'account_review', category: 'account', expected_settings_revision: 4, reason_code: 'reason_catalog_change' },
    });
    expect(writes[1]).toMatchObject({
      url: '/api/v1/system/reason-codes/staff_change',
      method: 'PUT',
      body: { expected_settings_revision: 4, expected_reason_revision: 1, label: '人员职责变更', active: true, reason_code: 'reason_catalog_change' },
    });
    expect(writes.every((write) => /^[0-9a-f-]{36}$/.test(write.key ?? ''))).toBe(true);
  });
});

async function chooseSelectOption(user: ReturnType<typeof userEvent.setup>, label: string, option: string) {
  await user.click(await screen.findByRole('combobox', { name: label }, { timeout: 3_000 }));
  await user.click((await screen.findAllByText(option)).at(-1)!);
}

function renderSettings(): QueryClient {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <MemoryRouter initialEntries={['/system/settings']}>
          <Routes>
            <Route path="/system/settings" element={<SystemSettingsPage />} />
            <Route path="/login" element={<div>LOGIN_TARGET</div>} />
          </Routes>
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
      admin_id: '019f0000-0000-7000-8000-000000000071',
      session_id: '019f0000-0000-7000-8000-000000000072',
      role,
      security_version: 1,
      mfa_authenticated_at: '2026-07-22T08:00:00Z',
      totp_authenticated_at: '2026-07-22T08:00:00Z',
      mfa_method: 'totp',
    },
    display_name: role === 'auditor' ? '审计人员' : '超级管理员',
    absolute_expires_at: '2026-07-22T18:00:00Z',
  };
}

function policy(revision: number, idle = 30) {
  return {
    session_idle_minutes: idle,
    session_absolute_hours: 12,
    audit_retention_days: 730,
    revision,
    updated_by_admin_id: '019f0000-0000-7000-8000-000000000071',
    updated_at: '2026-07-22T08:00:00Z',
  };
}

function reason(code: string, category: string, label: string, active = true) {
  return {
    code,
    category,
    label,
    active,
    revision: 1,
    created_at: '2026-07-22T08:00:00Z',
    updated_at: '2026-07-22T08:00:00Z',
  };
}

function jsonResponse(value: unknown, status: number): Response {
  return new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
}
