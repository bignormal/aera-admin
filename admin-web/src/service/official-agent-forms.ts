import type {
  AgentManifest,
  AgentVersionBundleV1,
  OfficialDraftCreatePayload,
  OfficialDraftUpdatePayload,
  OfficialReleaseChannel,
  OfficialReviewDecision,
  OfficialReviewPayload
} from './cloud-official-agents';

type FormResult<T> = { ok: true; payload: T } | { ok: false; error: string };
type DraftKind = OfficialDraftCreatePayload['kind'];

type DraftFormInput = {
  baseVersionId: string;
  bundleJSON: string;
  displayName: string;
  kind: DraftKind;
  manifestJSON: string;
};

type DraftCreateFormInput = DraftFormInput & { definitionId: string };

type ReviewFormInput = {
  decision: OfficialReviewDecision;
  initialChannels: OfficialReleaseChannel[];
  reviewReasonCode: string;
  safeNote: string;
};

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const sha256Pattern = /^[0-9a-f]{64}$/;
const reasonCodePattern = /^[a-z][a-z0-9_]{2,63}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, required: string[], optional: string[] = []): boolean {
  const allowed = new Set([...required, ...optional]);
  return required.every(key => key in value) && Object.keys(value).every(key => allowed.has(key));
}

function isString(value: unknown, minimum = 1, maximum = Number.POSITIVE_INFINITY): value is string {
  return typeof value === 'string' && value.length >= minimum && value.length <= maximum;
}

function isUniqueStringArray(value: unknown, minimum = 0, maximum = Number.POSITIVE_INFINITY): value is string[] {
  return (
    Array.isArray(value) &&
    value.length >= minimum &&
    value.length <= maximum &&
    value.every(item => isString(item)) &&
    new Set(value).size === value.length
  );
}

function isAgentManifest(value: unknown): value is AgentManifest {
  if (
    !isRecord(value) ||
    (value.schema_version !== 1 && value.schema_version !== 2) ||
    !hasOnlyKeys(value, [
      'schema_version',
      'identity',
      'assets',
      value.schema_version === 1 ? 'model_constraints' : 'model_policy',
      'tools',
      'dependencies',
      'runtime_compatibility'
    ])
  ) {
    return false;
  }

  const { identity, assets, tools, dependencies, runtime_compatibility: runtime } = value;
  if (
    !isRecord(identity) ||
    !hasOnlyKeys(identity, ['system_prompt']) ||
    !isString(identity.system_prompt, 1, 262144)
  ) {
    return false;
  }
  if (
    !Array.isArray(assets) ||
    assets.length > 128 ||
    !assets.every(
      asset =>
        isRecord(asset) &&
        hasOnlyKeys(asset, ['path', 'kind', 'media_type', 'sha256']) &&
        isString(asset.path, 1, 512) &&
        (asset.kind === 'skill' || asset.kind === 'sop' || asset.kind === 'knowledge') &&
        (asset.media_type === 'text/markdown' || asset.media_type === 'text/plain') &&
        typeof asset.sha256 === 'string' &&
        sha256Pattern.test(asset.sha256)
    )
  ) {
    return false;
  }
  const models = value.schema_version === 1 ? value.model_constraints : value.model_policy;
  if (!isRecord(models)) return false;
  const modelKeys =
    value.schema_version === 1
      ? ['allowed_providers', 'allowed_models']
      : ['mode', 'allowed_providers', 'allowed_models'];
  const maximumModelEntries =
    value.schema_version === 2 ? 128 : Number.POSITIVE_INFINITY;
  if (
    !hasOnlyKeys(models, modelKeys) ||
    !isUniqueStringArray(models.allowed_providers, 0, maximumModelEntries) ||
    models.allowed_providers.some(item => item.length > 128) ||
    !isUniqueStringArray(models.allowed_models, 0, maximumModelEntries) ||
    models.allowed_models.some(item => item.length > 256)
  ) {
    return false;
  }
  if (value.schema_version === 1) {
    if (models.allowed_providers.length === 0 || models.allowed_models.length === 0) return false;
  } else {
    const providerCount = models.allowed_providers.length;
    const modelCount = models.allowed_models.length;
    if (
      !(
        (models.mode === 'user_select' && providerCount === 0 && modelCount === 0) ||
        (models.mode === 'allowlist' && providerCount > 0 && modelCount > 0) ||
        (models.mode === 'fixed' && providerCount === 1 && modelCount === 1)
      )
    ) {
      return false;
    }
  }
  if (
    !isRecord(tools) ||
    !hasOnlyKeys(tools, ['allowed', 'denied']) ||
    !isUniqueStringArray(tools.allowed) ||
    tools.allowed.some(item => item.length > 256) ||
    !isUniqueStringArray(tools.denied) ||
    tools.denied.some(item => item.length > 256)
  ) {
    return false;
  }
  if (
    !Array.isArray(dependencies) ||
    dependencies.length > 128 ||
    !dependencies.every(
      dependency =>
        isRecord(dependency) &&
        hasOnlyKeys(dependency, ['agent_definition_id', 'agent_version_id']) &&
        typeof dependency.agent_definition_id === 'string' &&
        uuidPattern.test(dependency.agent_definition_id) &&
        typeof dependency.agent_version_id === 'string' &&
        uuidPattern.test(dependency.agent_version_id)
    )
  ) {
    return false;
  }
  return (
    isRecord(runtime) &&
    hasOnlyKeys(runtime, ['minimum_version'], ['maximum_version_exclusive']) &&
    isString(runtime.minimum_version, 1, 64) &&
    (runtime.maximum_version_exclusive === undefined ||
      runtime.maximum_version_exclusive === null ||
      isString(runtime.maximum_version_exclusive, 1, 64))
  );
}

function isAgentVersionBundle(value: unknown): value is AgentVersionBundleV1 {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ['assets']) &&
    Array.isArray(value.assets) &&
    value.assets.length <= 128 &&
    value.assets.every(
      asset =>
        isRecord(asset) &&
        hasOnlyKeys(asset, ['path', 'content']) &&
        isString(asset.path, 1, 512) &&
        typeof asset.content === 'string' &&
        asset.content.length <= 262144
    )
  );
}

function parseJSON(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function parseDraftContent(input: DraftFormInput): FormResult<{
  base_version_id?: string;
  bundle: AgentVersionBundleV1;
  display_name: string;
  kind: DraftKind;
  manifest: AgentManifest;
}> {
  const displayName = input.displayName.trim();
  if (!displayName) return { ok: false, error: '请填写显示名称' };

  const manifest = parseJSON(input.manifestJSON);
  if (!isAgentManifest(manifest)) return { ok: false, error: 'Manifest 不符合 AgentManifest V1/V2 结构' };
  const bundle = parseJSON(input.bundleJSON);
  if (!isAgentVersionBundle(bundle)) return { ok: false, error: 'Bundle 不符合 AgentVersionBundleV1 结构' };

  const baseVersionId = input.baseVersionId.trim();
  if (input.kind === 'next' && !baseVersionId) {
    return { ok: false, error: '版本更新草稿必须填写基础版本 ID' };
  }
  if (input.kind === 'next' && !uuidPattern.test(baseVersionId)) {
    return { ok: false, error: '基础版本 ID 必须是 UUID' };
  }
  if (input.kind === 'initial' && baseVersionId) {
    return { ok: false, error: '全新 Agent 草稿不能设置基础版本 ID' };
  }

  return {
    ok: true,
    payload: {
      ...(input.kind === 'next' ? { base_version_id: baseVersionId } : {}),
      bundle,
      display_name: displayName,
      kind: input.kind,
      manifest
    }
  };
}

export function buildOfficialDraftCreatePayload(input: DraftCreateFormInput): FormResult<OfficialDraftCreatePayload> {
  const definitionId = input.definitionId.trim();
  if (!definitionId) return { ok: false, error: '请选择所属定义' };
  const content = parseDraftContent(input);
  if (!content.ok) return content;
  return { ok: true, payload: { ...content.payload, definition_id: definitionId } };
}

export function buildOfficialDraftUpdatePayload(input: DraftFormInput): FormResult<OfficialDraftUpdatePayload> {
  return parseDraftContent(input);
}

export function buildOfficialReviewPayload(input: ReviewFormInput): FormResult<OfficialReviewPayload> {
  const reviewReasonCode = input.reviewReasonCode.trim();
  const safeNote = input.safeNote.trim();
  if (input.decision === 'approve') {
    if (reviewReasonCode || safeNote) {
      return { ok: false, error: '批准提交不能填写审核原因码或审核说明' };
    }
    if (input.initialChannels.length === 0) {
      return { ok: false, error: '批准提交时至少选择一个首发渠道' };
    }
    if (input.initialChannels.length > 2 || new Set(input.initialChannels).size !== input.initialChannels.length) {
      return { ok: false, error: '首发渠道不符合 Cloud 契约' };
    }
    return {
      ok: true,
      payload: {
        decision: 'approve',
        initial_channels: [...input.initialChannels]
      }
    };
  }
  if (!reviewReasonCode) return { ok: false, error: '驳回提交时必须填写审核原因码' };
  if (!reasonCodePattern.test(reviewReasonCode)) return { ok: false, error: '审核原因码格式不符合 Cloud 契约' };
  if (safeNote.length > 500) return { ok: false, error: '审核说明不能超过 500 个字符' };
  return {
    ok: true,
    payload: {
      decision: 'reject',
      review_reason_code: reviewReasonCode,
      ...(safeNote ? { safe_note: safeNote } : {})
    }
  };
}
