import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AuthProvider } from '../auth/AuthProvider';
import { OfficialAgentsPage } from './OfficialAgentsPage';

afterEach(() => vi.unstubAllGlobals());

describe('OfficialAgentsPage', () => {
  it('shows Developer draft actions without presenting queued work as published', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === '/api/v1/me') return jsonResponse(session('developer'));
      if (url === '/api/v1/official-agents?limit=50') {
        return jsonResponse({ items: [definition()] });
      }
      throw new Error(`unexpected request: ${url}`);
    }));
    renderPage();

    expect(await screen.findByRole('heading', { name: '官方 Agent' })).toBeVisible();
    expect(screen.getByText('平台只管理定义、版本、发布与审计，不接收用户运行数据。')).toBeVisible();
    expect(await screen.findByRole('button', { name: '创建官方 Agent' })).toBeVisible();
    expect(screen.getByRole('link', { name: '编辑草稿' })).toBeVisible();
    expect(screen.queryByText('发布成功')).not.toBeInTheDocument();
  });
});

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <AuthProvider><MemoryRouter><OfficialAgentsPage /></MemoryRouter></AuthProvider>
    </QueryClientProvider>,
  );
}

function session(role: string) {
  return {
    csrf_token: 'csrf-in-memory-only',
    administrator: {
      admin_id: '019f0000-0000-7000-8000-000000000201',
      session_id: '019f0000-0000-7000-8000-000000000202',
      role,
      security_version: 1,
      mfa_authenticated_at: '2026-07-22T08:00:00Z',
      totp_authenticated_at: '2026-07-22T08:00:00Z',
      mfa_method: 'totp',
    },
    display_name: '开发人员',
    absolute_expires_at: '2026-07-22T18:00:00Z',
  };
}

function definition() {
  return {
    definition_id: '019f0000-0000-7000-8000-000000000211',
    platform_id: '019f0000-0000-7000-8000-000000000212',
    display_name: '官方研究助手',
    status: 'active',
    created_by_admin_id: '019f0000-0000-7000-8000-000000000201',
    created_at: '2026-07-22T08:00:00Z',
    updated_at: '2026-07-22T08:00:00Z',
  };
}

function jsonResponse(value: unknown) {
  return new Response(JSON.stringify(value), { status: 200, headers: { 'Content-Type': 'application/json' } });
}
