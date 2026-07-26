import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AuthProvider } from '../auth/AuthProvider';
import { rolePermissions } from '../api/contracts';
import { OfficialAgentReviewsPage } from './OfficialAgentReviewsPage';

afterEach(() => vi.unstubAllGlobals());

describe('OfficialAgentReviewsPage', () => {
  it('shows immutable review evidence and explicit initial channels to Super Admin', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === '/api/v1/me') return jsonResponse(session());
      if (url === '/api/v1/official-agent-submissions?status=pending&limit=50') {
        return jsonResponse({ items: [submission()] });
      }
      if (url === '/api/v1/official-agent-rollback-requests?view=pending_for_me&limit=50') {
        return jsonResponse({ items: [] });
      }
      throw new Error(`unexpected request: ${url}`);
    }));
    renderPage();

    expect(await screen.findByRole('heading', { name: '官方 Agent 审核' })).toBeVisible();
    expect(await screen.findByText(/bbbbbbbbbbbbbbbb/)).toBeVisible();
    expect(screen.getByText('策略快照将在 Cloud 原子发布时固定')).toBeVisible();
    expect(screen.getByLabelText('内部渠道')).toBeEnabled();
    expect(screen.getByLabelText('稳定渠道')).toBeEnabled();
    expect(screen.getByRole('button', { name: '批准发布' })).toBeVisible();
    expect(screen.getByRole('button', { name: '拒绝提交' })).toBeVisible();
  });
});

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <AuthProvider><MemoryRouter><OfficialAgentReviewsPage /></MemoryRouter></AuthProvider>
    </QueryClientProvider>,
  );
}

function session() {
  return {
    csrf_token: 'csrf-in-memory-only',
    administrator: {
      admin_id: '019f0000-0000-7000-8000-000000000221', session_id: '019f0000-0000-7000-8000-000000000222',
      role: 'super_admin', permissions: [...(rolePermissions.super_admin ?? [])], security_version: 1, mfa_authenticated_at: '2026-07-22T08:00:00Z',
      totp_authenticated_at: '2026-07-22T08:00:00Z', mfa_method: 'totp',
    }, display_name: '超级管理员', absolute_expires_at: '2026-07-22T18:00:00Z',
  };
}

function submission() {
  const digest = 'b'.repeat(64);
  return {
    submission_id: '019f0000-0000-7000-8000-000000000223', platform_id: '019f0000-0000-7000-8000-000000000224',
    draft_id: '019f0000-0000-7000-8000-000000000225', draft_revision: 4,
    definition_id: '019f0000-0000-7000-8000-000000000226', kind: 'initial', display_name: '官方研究助手',
    manifest: {
      schema_version: 1, identity: { system_prompt: '已冻结。' }, assets: [],
      model_constraints: { allowed_providers: ['openai'], allowed_models: ['gpt-5'] },
      tools: { allowed: [], denied: [] }, dependencies: [], runtime_compatibility: { minimum_version: 'v0.18.0' },
    }, bundle: { assets: [] }, manifest_digest: digest, bundle_digest: digest, content_digest: digest,
    submitted_by_admin_id: '019f0000-0000-7000-8000-000000000227', submitted_by_role: 'developer',
    status: 'pending', revision: 1, submitted_at: '2026-07-22T08:00:00Z', updated_at: '2026-07-22T08:00:00Z',
  };
}

function jsonResponse(value: unknown) {
  return new Response(JSON.stringify(value), { status: 200, headers: { 'Content-Type': 'application/json' } });
}
