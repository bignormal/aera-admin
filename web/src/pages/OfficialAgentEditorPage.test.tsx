import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AuthProvider } from '../auth/AuthProvider';
import { rolePermissions } from '../api/contracts';
import { OfficialAgentEditorPage } from './OfficialAgentEditorPage';

const definitionID = '019f0000-0000-7000-8000-000000000211';

afterEach(() => vi.unstubAllGlobals());

describe('OfficialAgentEditorPage', () => {
  it('binds editable content to the current immutable digest and revision', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === '/api/v1/me') return jsonResponse(session());
      if (url === `/api/v1/official-agents/${definitionID}`) return jsonResponse(definition());
      if (url === '/api/v1/official-agent-drafts?limit=100') return jsonResponse({ items: [draft()] });
      throw new Error(`unexpected request: ${url}`);
    }));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <AuthProvider>
          <MemoryRouter initialEntries={[`/official-agents/${definitionID}/edit`]}>
            <Routes><Route path="/official-agents/:definitionID/edit" element={<OfficialAgentEditorPage />} /></Routes>
          </MemoryRouter>
        </AuthProvider>
      </QueryClientProvider>,
    );

    expect(await screen.findByRole('heading', { name: '编辑官方 Agent 草稿' })).toBeVisible();
    expect(await screen.findByDisplayValue('你是经过审核的官方研究助手。')).toHaveValue('你是经过审核的官方研究助手。');
    expect(screen.getByText('草稿修订号：3')).toBeVisible();
    expect(screen.getByText(/aaaaaaaaaaaaaaaa/)).toBeVisible();
    expect(screen.getByRole('button', { name: '运行安全校验' })).toBeVisible();
    expect(screen.getByRole('button', { name: '提交审核' })).toBeVisible();
  });
});

function session() {
  return {
    csrf_token: 'csrf-in-memory-only',
    administrator: {
      admin_id: '019f0000-0000-7000-8000-000000000201',
      session_id: '019f0000-0000-7000-8000-000000000202', role: 'developer', permissions: [...(rolePermissions.developer ?? [])], security_version: 1,
      mfa_authenticated_at: '2026-07-22T08:00:00Z', totp_authenticated_at: '2026-07-22T08:00:00Z', mfa_method: 'totp',
    },
    display_name: '开发人员', absolute_expires_at: '2026-07-22T18:00:00Z',
  };
}

function definition() {
  return {
    definition_id: definitionID, platform_id: '019f0000-0000-7000-8000-000000000212',
    display_name: '官方研究助手', status: 'active',
    created_by_admin_id: '019f0000-0000-7000-8000-000000000201',
    created_at: '2026-07-22T08:00:00Z', updated_at: '2026-07-22T08:00:00Z',
  };
}

function draft() {
  const digest = 'a'.repeat(64);
  return {
    draft_id: '019f0000-0000-7000-8000-000000000213', platform_id: '019f0000-0000-7000-8000-000000000212',
    definition_id: definitionID, kind: 'initial', display_name: '官方研究助手',
    manifest: {
      schema_version: 1, identity: { system_prompt: '你是经过审核的官方研究助手。' }, assets: [],
      model_constraints: { allowed_providers: ['openai'], allowed_models: ['gpt-5'] },
      tools: { allowed: [], denied: [] }, dependencies: [], runtime_compatibility: { minimum_version: 'v0.18.0' },
    },
    bundle: { assets: [] }, manifest_digest: digest, bundle_digest: digest, content_digest: digest,
    revision: 3, status: 'active', last_editor_admin_id: '019f0000-0000-7000-8000-000000000201',
    last_editor_role: 'developer', created_at: '2026-07-22T08:00:00Z', updated_at: '2026-07-22T08:00:00Z',
  };
}

function jsonResponse(value: unknown) {
  return new Response(JSON.stringify(value), { status: 200, headers: { 'Content-Type': 'application/json' } });
}
