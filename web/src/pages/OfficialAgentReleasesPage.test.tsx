import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AuthProvider } from '../auth/AuthProvider';
import { OfficialAgentReleasesPage } from './OfficialAgentReleasesPage';

afterEach(() => vi.unstubAllGlobals());

describe('OfficialAgentReleasesPage', () => {
  it('shows bounded rollout and rollback controls to Operator without exposing a full allowlist', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === '/api/v1/me') return jsonResponse(session());
      if (url === '/api/v1/official-agent-versions?limit=100') return jsonResponse({ items: [version()] });
      if (url === '/api/v1/official-agent-releases?limit=50') return jsonResponse({ items: [release()] });
      if (url === '/api/v1/official-agent-rollback-requests?view=mine&limit=50') return jsonResponse({ items: [] });
      throw new Error(`unexpected request: ${url}`);
    }));
    renderPage();

    expect(await screen.findByRole('heading', { name: '官方 Agent 发布' })).toBeVisible();
    expect(await screen.findByLabelText('灰度百分比')).toHaveValue('10');
    expect(screen.getByLabelText('最低桌面版本')).toHaveValue('v0.18.0');
    expect(screen.getByLabelText('精确查找灰度账号')).toBeVisible();
    expect(screen.getByRole('button', { name: '更新灰度' })).toBeVisible();
    expect(screen.getByRole('button', { name: '暂停发布' })).toBeVisible();
    expect(screen.getByRole('button', { name: '申请回滚' })).toBeVisible();
    expect(document.body.textContent).not.toContain('allowlisted_user_ids');
  });
});

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <AuthProvider><MemoryRouter><OfficialAgentReleasesPage /></MemoryRouter></AuthProvider>
    </QueryClientProvider>,
  );
}

function session() {
  return {
    csrf_token: 'csrf-in-memory-only',
    administrator: {
      admin_id: '019f0000-0000-7000-8000-000000000231', session_id: '019f0000-0000-7000-8000-000000000232',
      role: 'operator', security_version: 1, mfa_authenticated_at: '2026-07-22T08:00:00Z',
      totp_authenticated_at: '2026-07-22T08:00:00Z', mfa_method: 'totp',
    }, display_name: '运营人员', absolute_expires_at: '2026-07-22T18:00:00Z',
  };
}

function manifest() {
  return {
    schema_version: 1, identity: { system_prompt: '已发布。' }, assets: [],
    model_constraints: { allowed_providers: ['openai'], allowed_models: ['gpt-5'] },
    tools: { allowed: [], denied: [] }, dependencies: [], runtime_compatibility: { minimum_version: 'v0.18.0' },
  };
}

function version() {
  return {
    version_id: '019f0000-0000-7000-8000-000000000233', definition_id: '019f0000-0000-7000-8000-000000000234',
    version_number: 1, manifest: manifest(), bundle: { assets: [] }, content_digest: 'c'.repeat(64),
    runtime_minimum_version: 'v0.18.0', published_at: '2026-07-22T08:00:00Z',
  };
}

function release() {
  return {
    release_id: '019f0000-0000-7000-8000-000000000235', platform_id: '019f0000-0000-7000-8000-000000000236',
    definition_id: '019f0000-0000-7000-8000-000000000234', channel: 'stable',
    current_revision_id: '019f0000-0000-7000-8000-000000000237', head_revision: 2,
    agent_version_id: '019f0000-0000-7000-8000-000000000233', state: 'active', rollout_basis_points: 1000,
    minimum_desktop_version: 'v0.18.0', action: 'activate', actor_admin_id: '019f0000-0000-7000-8000-000000000231',
    actor_admin_role: 'operator', reason_code: 'official_release_change', audience_count: 0,
    created_at: '2026-07-22T08:00:00Z', updated_at: '2026-07-22T08:00:00Z',
  };
}

function jsonResponse(value: unknown) {
  return new Response(JSON.stringify(value), { status: 200, headers: { 'Content-Type': 'application/json' } });
}
