import { describe, expect, it } from 'vitest';
import {
  buildOfficialDraftCreatePayload,
  buildOfficialDraftUpdatePayload,
  buildOfficialReviewPayload
} from './official-agent-forms';

const manifest = {
  assets: [],
  dependencies: [],
  identity: { system_prompt: 'You are helpful.' },
  model_constraints: { allowed_models: ['gpt-5'], allowed_providers: ['openai'] },
  runtime_compatibility: { maximum_version_exclusive: null, minimum_version: '0.7.4' },
  schema_version: 1,
  tools: { allowed: ['read'], denied: ['shell'] }
};

const bundle = {
  assets: [{ content: '# Skill', path: 'skills/example.md' }]
};

const manifestV2 = {
  assets: [],
  dependencies: [],
  identity: { system_prompt: 'You are helpful.' },
  model_policy: { allowed_models: [], allowed_providers: [], mode: 'user_select' },
  runtime_compatibility: { minimum_version: '0.7.4' },
  schema_version: 2,
  tools: { allowed: ['read'], denied: ['shell'] }
};

describe('official Agent draft forms', () => {
  it('builds a canonical initial draft and omits base_version_id', () => {
    expect(
      buildOfficialDraftCreatePayload({
        baseVersionId: '',
        bundleJSON: JSON.stringify(bundle),
        definitionId: 'definition-1',
        displayName: ' Example Agent ',
        kind: 'initial',
        manifestJSON: JSON.stringify(manifest)
      })
    ).toEqual({
      ok: true,
      payload: {
        bundle,
        definition_id: 'definition-1',
        display_name: 'Example Agent',
        kind: 'initial',
        manifest
      }
    });
  });

  it('requires a base version for a next draft', () => {
    expect(
      buildOfficialDraftCreatePayload({
        baseVersionId: '  ',
        bundleJSON: JSON.stringify(bundle),
        definitionId: 'definition-1',
        displayName: 'Example Agent',
        kind: 'next',
        manifestJSON: JSON.stringify(manifest)
      })
    ).toEqual({ ok: false, error: '版本更新草稿必须填写基础版本 ID' });
  });

  it('accepts every canonical V2 model policy mode', () => {
    for (const modelPolicy of [
      { allowed_models: [], allowed_providers: [], mode: 'user_select' },
      {
        allowed_models: ['gpt-5.6-sol'],
        allowed_providers: ['petoi'],
        mode: 'fixed'
      },
      {
        allowed_models: ['claude-opus-4-6', 'gpt-5.6-sol'],
        allowed_providers: ['petoi', 'yundu.lat'],
        mode: 'allowlist'
      }
    ]) {
      const candidate = { ...manifestV2, model_policy: modelPolicy };
      expect(
        buildOfficialDraftUpdatePayload({
          baseVersionId: '',
          bundleJSON: JSON.stringify(bundle),
          displayName: 'Example Agent',
          kind: 'initial',
          manifestJSON: JSON.stringify(candidate)
        })
      ).toMatchObject({ ok: true, payload: { manifest: candidate } });
    }
  });

  it('does not apply the V2 route-count limit to a V1 manifest', () => {
    const candidate = {
      ...manifest,
      model_constraints: {
        allowed_models: Array.from({ length: 129 }, (_, index) => `model-${index}`),
        allowed_providers: Array.from({ length: 129 }, (_, index) => `provider-${index}`)
      }
    };
    expect(
      buildOfficialDraftUpdatePayload({
        baseVersionId: '',
        bundleJSON: JSON.stringify(bundle),
        displayName: 'Example Agent',
        kind: 'initial',
        manifestJSON: JSON.stringify(candidate)
      })
    ).toMatchObject({ ok: true, payload: { manifest: candidate } });
  });

  it('rejects noncanonical V2 model policy modes before Cloud submission', () => {
    for (const modelPolicy of [
      { allowed_models: ['gpt-5.6-sol'], allowed_providers: ['petoi'], mode: 'user_select' },
      { allowed_models: [], allowed_providers: ['petoi'], mode: 'allowlist' },
      {
        allowed_models: ['gpt-5.6-sol', 'claude-opus-4-6'],
        allowed_providers: ['petoi'],
        mode: 'fixed'
      }
    ]) {
      expect(
        buildOfficialDraftUpdatePayload({
          baseVersionId: '',
          bundleJSON: JSON.stringify(bundle),
          displayName: 'Example Agent',
          kind: 'initial',
          manifestJSON: JSON.stringify({ ...manifestV2, model_policy: modelPolicy })
        })
      ).toEqual({ ok: false, error: 'Manifest 不符合 AgentManifest V1/V2 结构' });
    }
  });

  it('requires the base version to be a UUID', () => {
    expect(
      buildOfficialDraftCreatePayload({
        baseVersionId: 'version-1',
        bundleJSON: JSON.stringify(bundle),
        definitionId: 'definition-1',
        displayName: 'Example Agent',
        kind: 'next',
        manifestJSON: JSON.stringify(manifest)
      })
    ).toEqual({ ok: false, error: '基础版本 ID 必须是 UUID' });
  });

  it('rejects a base version on an initial draft', () => {
    expect(
      buildOfficialDraftUpdatePayload({
        baseVersionId: 'version-1',
        bundleJSON: JSON.stringify(bundle),
        displayName: 'Example Agent',
        kind: 'initial',
        manifestJSON: JSON.stringify(manifest)
      })
    ).toEqual({ ok: false, error: '全新 Agent 草稿不能设置基础版本 ID' });
  });

  it('rejects JSON objects that do not match the canonical manifest and bundle schemas', () => {
    expect(
      buildOfficialDraftUpdatePayload({
        baseVersionId: '',
        bundleJSON: '{}',
        displayName: 'Example Agent',
        kind: 'initial',
        manifestJSON: '{}'
      })
    ).toEqual({ ok: false, error: 'Manifest 不符合 AgentManifest V1/V2 结构' });
  });
});

describe('official Agent review forms', () => {
  it('builds an approval with canonical nonempty channels', () => {
    expect(
      buildOfficialReviewPayload({
        decision: 'approve',
        initialChannels: ['internal', 'stable'],
        reviewReasonCode: '',
        safeNote: ''
      })
    ).toEqual({
      ok: true,
      payload: { decision: 'approve', initial_channels: ['internal', 'stable'] }
    });
  });

  it('rejects notes that the canonical approval schema prohibits', () => {
    expect(
      buildOfficialReviewPayload({
        decision: 'approve',
        initialChannels: ['stable'],
        reviewReasonCode: '',
        safeNote: 'not allowed on approval'
      })
    ).toEqual({ ok: false, error: '批准提交不能填写审核原因码或审核说明' });
  });

  it('rejects an approval without an initial channel', () => {
    expect(
      buildOfficialReviewPayload({
        decision: 'approve',
        initialChannels: [],
        reviewReasonCode: '',
        safeNote: ''
      })
    ).toEqual({ ok: false, error: '批准提交时至少选择一个首发渠道' });
  });

  it('requires a review reason code for rejection', () => {
    expect(
      buildOfficialReviewPayload({
        decision: 'reject',
        initialChannels: ['stable'],
        reviewReasonCode: '  ',
        safeNote: ''
      })
    ).toEqual({ ok: false, error: '驳回提交时必须填写审核原因码' });
  });

  it('validates the canonical review reason code format', () => {
    expect(
      buildOfficialReviewPayload({
        decision: 'reject',
        initialChannels: [],
        reviewReasonCode: 'Policy Violation',
        safeNote: ''
      })
    ).toEqual({ ok: false, error: '审核原因码格式不符合 Cloud 契约' });
  });

  it('enforces the canonical safe note length', () => {
    expect(
      buildOfficialReviewPayload({
        decision: 'reject',
        initialChannels: [],
        reviewReasonCode: 'policy_violation',
        safeNote: 'x'.repeat(501)
      })
    ).toEqual({ ok: false, error: '审核说明不能超过 500 个字符' });
  });

  it('omits approval channels from a rejection', () => {
    expect(
      buildOfficialReviewPayload({
        decision: 'reject',
        initialChannels: ['internal'],
        reviewReasonCode: 'policy_violation',
        safeNote: ''
      })
    ).toEqual({
      ok: true,
      payload: { decision: 'reject', review_reason_code: 'policy_violation' }
    });
  });
});
