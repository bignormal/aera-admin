# 内容目录 → Cloud → Desktop 消费闭环 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将官方智能体、分类、技能目录和发布中心从 Admin 本地 CRUD 接成 Cloud 官方 Agent 真实发布链路，并用真实 Beta Desktop 验证目录读取、签名校验、安装和激活；官方插件在没有消费合同前保持明确的 `contract_pending` 状态。

**Architecture:** Payload 继续保存运营草稿和审计；Admin BFF 通过现有 Cloud 内部管理合同同步 definition/draft、校验、审核和 Release；Cloud 是官方 Agent 发布事实源；Desktop 通过公共 Cloud API 读取可用版本并在主进程完成验证/安装。Admin 只保存外部 ID、摘要、状态和脱敏回执，不复制 Cloud 私密正文或 Desktop 本地内容。

**Tech Stack:** Payload + SQLite + TypeScript；Vue 3/Soybean + Naive UI；aera-cloud Go/OpenAPI；Desktop Electron/TypeScript；Vitest、Node contract tests、Playwright 真实 Beta E2E。

---

## 文件变更地图

### `aera-admin`

- Create: `src/collections/ContentDeliveryLinks.ts` — 内容资源到 Cloud 外部对象的管理元数据和状态。
- Create: `src/migrations/20260812_000001_content_delivery_links.ts` 与 JSON snapshot — SQLite migration。
- Modify: `src/payload.config.ts`、`src/migrations/index.ts` — 注册集合和 migration。
- Create: `src/domain/content-delivery.ts` — stable key、digest、状态转换和插件合同守门逻辑。
- Create: `src/endpoints/content-delivery.ts` — 草稿同步、校验、提交以及交付状态读取的 Payload BFF 端点。
- Modify: `src/endpoints/cloud.ts`、`src/platform-api/cloud/operations.ts`、`src/platform-api/cloud/handler.ts` — 复用 Cloud BFF、注册所需读取/写操作并保留 capability、幂等和审计。
- Modify: `src/collections/AgentTemplates.ts`、`src/collections/SkillCatalog.ts`、`src/collections/ExpertCategories.ts`、`src/collections/PluginCatalog.ts` — 发布约束和分发字段。
- Create: `src/domain/content-delivery.test.ts`、`src/endpoints/content-delivery.int.spec.ts` — 领域和 BFF 集成测试。
- Modify: `admin-web/src/service/publishing.ts`、`admin-web/src/service/cloud-official-agents.ts` — 内容同步和交付状态 DTO。
- Modify: `admin-web/src/views/agents/index.vue`、`categories/index.vue`、`skills/index.vue`、`plugins/index.vue`、`publishing/index.vue`、`publishing/modules/official-agents-panel.vue` — P0 页面真实状态和动作。
- Create/modify: `admin-web/src/service/content-delivery.test.ts`、`admin-web/src/views/publishing/content-delivery.test.ts` — 请求映射和页面状态测试。

### `aera-cloud`

- Modify: `api/openapi/internal-admin.yaml` — 只在 Admin 缺少已存在的字段或回执合同字段时做窄范围合同变更。
- Modify: `internal/admin/...` 对应 handler/service — 接收 `content_digest`、Runtime manifest 摘要和 Desktop 验证摘要；不接受提示词或知识正文回执。
- Create/modify: Cloud 合同测试和数据库 migration — 保证幂等、revision、角色和回执 DTO。

### Desktop `aera`

- Modify: `contracts/agentera-cloud.openapi.yaml`、`src/shared/agentera-cloud-api.generated.ts` — 若回执合同缺失，增加最小的验证回执接口。
- Modify: `src/main/agentera-agent-control/*` — 在真实安装/激活成功或失败后发送脱敏回执；不把原文、文件、私钥交给 Renderer。
- Modify: `tests/e2e/agentera-official-managed-agent.e2e.ts` 或新增 `tests/e2e/agentera-official-delivery-receipt.e2e.ts` — 验证目录可见、安装、激活和回执。

---

## Task 1: 建立内容交付关联记录和状态机

**Files:**
- Create: `aera-admin/src/collections/ContentDeliveryLinks.ts`
- Create: `aera-admin/src/domain/content-delivery.ts`
- Create: `aera-admin/src/domain/content-delivery.test.ts`
- Create: `aera-admin/src/migrations/20260812_000001_content_delivery_links.ts`
- Create: `aera-admin/src/migrations/20260812_000001_content_delivery_links.json`
- Modify: `aera-admin/src/payload.config.ts`
- Modify: `aera-admin/src/migrations/index.ts`

- [ ] **Step 1: Write the failing state-machine tests**

```ts
import { describe, expect, it } from 'vitest';
import { canAdvanceDeliveryStatus, deliveryStatusFor } from './content-delivery';

describe('content delivery state machine', () => {
  it('does not call a local Payload publish a Cloud release', () => {
    expect(deliveryStatusFor({ payloadPublished: true, cloudReleaseId: null, desktopVerified: false }))
      .toBe('local_only');
  });
  it('requires a Cloud release before Desktop verification', () => {
    expect(canAdvanceDeliveryStatus('approved', 'desktop_verified')).toBe(false);
    expect(canAdvanceDeliveryStatus('released', 'desktop_verified')).toBe(true);
  });
  it('accepts only forward transitions except an explicit failure reset', () => {
    expect(canAdvanceDeliveryStatus('released', 'draft_synced')).toBe(false);
    expect(canAdvanceDeliveryStatus('validation_failed', 'draft_synced')).toBe(true);
  });
});
```

- [ ] **Step 2: Run the focused test and verify it fails**

Run: `pnpm --dir aera-admin exec vitest run src/domain/content-delivery.test.ts`

Expected: FAIL because `content-delivery.ts` and the status functions do not exist.

- [ ] **Step 3: Implement the minimal status model**

```ts
export type DeliveryStatus =
  | 'local_only' | 'draft_synced' | 'validation_failed' | 'submitted'
  | 'approved' | 'released' | 'desktop_verified' | 'failed';

const transitions: Record<DeliveryStatus, readonly DeliveryStatus[]> = {
  local_only: ['draft_synced', 'failed'],
  draft_synced: ['validation_failed', 'submitted', 'failed'],
  validation_failed: ['draft_synced', 'failed'],
  submitted: ['approved', 'failed'],
  approved: ['released', 'failed'],
  released: ['desktop_verified', 'failed'],
  desktop_verified: ['released', 'failed'],
  failed: ['draft_synced', 'failed']
};

export function canAdvanceDeliveryStatus(from: DeliveryStatus, to: DeliveryStatus): boolean {
  return transitions[from].includes(to);
}

export function deliveryStatusFor(input: {
  payloadPublished: boolean;
  cloudReleaseId: string | null;
  desktopVerified: boolean;
}): DeliveryStatus {
  if (input.desktopVerified && input.cloudReleaseId) return 'desktop_verified';
  if (input.cloudReleaseId) return 'released';
  return 'local_only';
}
```

Create the Payload collection with required `resourceType`, `payloadDocumentId`, `stableKey`, `syncStatus`, `contentDigest`, timestamps, and optional Cloud IDs, operation/request IDs, runtime manifest digest, and sanitized error fields. Deny direct public create/update/delete; controlled endpoints use `overrideAccess`.

- [ ] **Step 4: Add the SQLite migration and register the collection**

Run: `pnpm --dir aera-admin payload migrate:create content_delivery_links` only if the repository generator produces the checked-in naming format; otherwise add the migration using the existing `20260804_034936_admin_operation_reconciliation` shape. Register `ContentDeliveryLinks` in `src/payload.config.ts` and the migration in `src/migrations/index.ts`.

Expected: generated JSON snapshot contains the collection fields and `pnpm --dir aera-admin exec vitest run src/domain/content-delivery.test.ts` passes.

- [ ] **Step 5: Commit the data-model slice**

```bash
git -C aera-admin add src/collections/ContentDeliveryLinks.ts src/domain/content-delivery.ts src/domain/content-delivery.test.ts src/migrations/20260812_000001_content_delivery_links.* src/payload.config.ts src/migrations/index.ts
git -C aera-admin commit -m "feat: add content delivery linkage state"
```

## Task 2: Connect P0 read states to the real Cloud workbench

**Files:**
- Modify: `aera-admin/src/platform-api/cloud/operations.ts`
- Modify: `aera-admin/admin-web/src/service/cloud-official-agents.ts`
- Modify: `aera-admin/admin-web/src/views/publishing/modules/official-agents-panel.vue`
- Modify: `aera-admin/admin-web/src/views/publishing/index.vue`
- Test: `aera-admin/admin-web/src/service/cloud-p7.test.ts`
- Test: `aera-admin/admin-web/src/service/cloud-official-agents.contract.test.ts`

- [ ] **Step 1: Add failing tests for definition-to-delivery projection**

```ts
it('keeps Cloud empty distinct from backend unavailable', async () => {
  mockCloud({ items: [], next_cursor: undefined });
  await expect(listOfficialDefinitions({ limit: 50 })).resolves.toEqual({ items: [], next_cursor: undefined });
});

it('maps Cloud operation request IDs without exposing actor credentials', async () => {
  const outcome = await createOfficialDraft(input);
  expect(outcome.operation_id).toMatch(/[0-9a-f-]{36}/);
  expect(JSON.stringify(outcome)).not.toContain('api_key');
});
```

- [ ] **Step 2: Run the web service tests and verify the new assertions fail**

Run: `pnpm --dir aera-admin/admin-web test -- cloud-p7 cloud-official-agents`

Expected: FAIL for the missing delivery projection/empty-vs-unavailable behavior.

- [ ] **Step 3: Implement typed Cloud delivery projection**

Add `ContentDeliveryLink` and `DeliveryStatus` DTOs to the web service, expose `getContentDeliveryStatus` through the Payload endpoint, and keep Cloud list functions typed from generated OpenAPI. Do not add a second fetch client; all requests continue through `callCloud` and `/api/cloud/v1/:operation`.

- [ ] **Step 4: Update the workbench state rendering**

Render separate cards for definitions, drafts, submissions, versions, releases, audits, and delivery links. Use `暂无真实数据（请求成功）` for empty pages, `服务不可用` plus request ID for Cloud failures, and never replace a failed request with `[]`.

- [ ] **Step 5: Verify and commit**

Run: `pnpm --dir aera-admin/admin-web test -- cloud-p7 cloud-official-agents publishing`

Expected: PASS. Commit:

```bash
git -C aera-admin add src/platform-api/cloud/operations.ts admin-web/src/service/cloud-official-agents.ts admin-web/src/views/publishing
git -C aera-admin commit -m "feat: show real cloud delivery states"
```

## Task 3: Add the controlled Payload-to-Cloud draft synchronization endpoint

**Files:**
- Create: `aera-admin/src/endpoints/content-delivery.ts`
- Modify: `aera-admin/src/payload.config.ts`
- Modify: `aera-admin/src/collections/AgentTemplates.ts`
- Modify: `aera-admin/src/domain/content-delivery.ts`
- Create: `aera-admin/src/endpoints/content-delivery.int.spec.ts`
- Modify: `aera-admin/admin-web/src/service/publishing.ts`
- Create: `aera-admin/admin-web/src/service/content-delivery.test.ts`

- [ ] **Step 1: Write failing BFF tests for sync, validation and capability gates**

```ts
it('rejects a sync from a role without official agent draft capability', async () => {
  const response = await requestDeliveryEndpoint({ role: 'auditor', action: 'sync-agent' });
  expect(response.status).toBe(403);
  expect(await response.json()).toMatchObject({ error: { code: 'FORBIDDEN' } });
});

it('persists Cloud IDs and digest after an idempotent draft sync', async () => {
  const response = await requestDeliveryEndpoint({ role: 'publisher', action: 'sync-agent', fixture: validAgentFixture() });
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ syncStatus: 'draft_synced', contentDigest: expect.stringMatching(/^[a-f0-9]{64}$/) });
});
```

- [ ] **Step 2: Run the integration test and verify the endpoint is absent**

Run: `pnpm --dir aera-admin exec vitest run src/endpoints/content-delivery.int.spec.ts`

Expected: FAIL with a missing endpoint or 404.

- [ ] **Step 3: Implement the endpoint with allowlisted actions**

Register `POST /content-delivery/sync-agent/:id`, `POST /content-delivery/validate/:id`, `POST /content-delivery/submit/:id`, and `GET /content-delivery/:resourceType/:id`. Each handler must:

1. require a logged-in Admin and the exact capability;
2. load Payload data with `overrideAccess` only after capability validation;
3. derive the stable key and canonical content digest server-side;
4. call the existing Cloud operation registry, passing `reason_code`, `expected_revision`, and an idempotency key;
5. persist only external IDs/status/digests/request IDs/error summaries in `content-delivery-links`;
6. append an Admin audit event;
7. map Cloud 400/403/409/422/503 and timeout to stable Chinese messages and request IDs.

Use the existing `createCloudHandler` preparation and receipt logic rather than storing Cloud credentials or calling Cloud from Vue.

- [ ] **Step 4: Replace local “publish” with “同步 Cloud/准备发布”**

`admin-web/src/service/publishing.ts` should expose:

```ts
export function syncAgentToCloud(id: ResourceID): Promise<ContentDeliveryLink>;
export function validateAgentCloud(id: ResourceID): Promise<ContentDeliveryLink>;
export function submitAgentForReview(id: ResourceID, reasonCode: string): Promise<ContentDeliveryLink>;
```

The existing `publishResource` remains available only for non-Cloud local resources until each consumer contract is proven, and the Agent page must not call it for an official Agent.

- [ ] **Step 5: Run tests and commit**

Run: `pnpm --dir aera-admin exec vitest run src/endpoints/content-delivery.int.spec.ts && pnpm --dir aera-admin/admin-web test -- content-delivery publishing`

Expected: PASS, including no key/prompt/body leakage assertions. Commit:

```bash
git -C aera-admin add src/endpoints/content-delivery.ts src/payload.config.ts src/collections/AgentTemplates.ts src/domain/content-delivery.ts src/endpoints/content-delivery.int.spec.ts admin-web/src/service/publishing.ts admin-web/src/service/content-delivery.test.ts
git -C aera-admin commit -m "feat: sync official agent drafts to cloud"
```

## Task 4: Enforce category and Runtime skill publication constraints

**Files:**
- Modify: `aera-admin/src/collections/SkillCatalog.ts`
- Modify: `aera-admin/src/collections/ExpertCategories.ts`
- Modify: `aera-admin/src/collections/AgentTemplates.ts`
- Modify: `aera-admin/src/domain/publishing.ts`
- Modify: `aera-admin/admin-web/src/views/skills/index.vue`
- Modify: `aera-admin/admin-web/src/service/skills.ts`
- Test: `aera-admin/src/domain/publishing.test.ts` (create if absent)
- Test: `aera-admin/admin-web/src/service/skills.test.ts`

- [ ] **Step 1: Write failing validation tests**

```ts
it('rejects a proprietary skill in a Desktop-deliverable official Agent', async () => {
  await expect(validateAgentPublish({ skill: { active: true, distributionClass: 'cloud_proprietary' } }))
    .rejects.toThrow('第一版官方 Agent 只能使用 runtime_public 技能');
});

it('requires an enabled category and runtime skill identifier', async () => {
  await expect(validateAgentPublish({ category: { active: false }, skill: { active: true, distributionClass: 'runtime_public', runtimeSkillId: '' } }))
    .rejects.toThrow('分类必须启用');
});
```

- [ ] **Step 2: Run focused tests and verify failure**

Run: `pnpm --dir aera-admin exec vitest run src/domain/publishing.test.ts`

Expected: FAIL because `distributionClass` and the new constraints are not implemented.

- [ ] **Step 3: Add the field and enforce the rule**

Add `distributionClass` with default `runtime_public`; require `runtimeSkillId` when public and reject proprietary skills in `validateAgentPublish`. Canonicalize the sorted public skill IDs and persist `runtimeManifestSha256` in the delivery link. Keep the existing category active check and add a stable field path to the error.

- [ ] **Step 4: Update the Skill page without changing the UI language**

Add a select for “分发类别”, a read-only manifest hash/status column, and a warning state for proprietary skills. Do not add an install button. The existing Naive UI table, modal, tags and spacing remain unchanged.

- [ ] **Step 5: Verify and commit**

Run: `pnpm --dir aera-admin exec vitest run src/domain/publishing.test.ts && pnpm --dir aera-admin/admin-web test -- skills`

Expected: PASS. Commit:

```bash
git -C aera-admin add src/collections/SkillCatalog.ts src/collections/ExpertCategories.ts src/collections/AgentTemplates.ts src/domain/publishing.ts src/domain/publishing.test.ts admin-web/src/views/skills/index.vue admin-web/src/service/skills.ts admin-web/src/service/skills.test.ts
git -C aera-admin commit -m "feat: enforce official agent skill compatibility"
```

## Task 5: Implement Cloud review and internal Release actions with existing gates

**Files:**
- Modify: `aera-admin/admin-web/src/views/publishing/modules/official-agents-panel.vue`
- Modify: `aera-admin/admin-web/src/service/cloud-official-agents.ts`
- Modify: `aera-admin/src/platform-api/cloud/operations.ts` only if a generated operation is missing
- Test: `aera-admin/admin-web/src/service/cloud-official-agents.contract.test.ts`
- Test: `aera-admin/admin-web/src/service/cloud-p7.test.ts`

- [ ] **Step 1: Add failing tests for role and revision boundaries**

```ts
it('does not render release actions without official release capability', () => {
  expect(releaseActionsFor({ role: 'publisher', status: 'approved' })).toEqual([]);
});

it('requires a current Cloud revision for activation', async () => {
  await expect(activateOfficialRelease('release-1', { expected_revision: 1, payload: {}, reason_code: 'activate_release' }))
    .rejects.toMatchObject({ status: 409 });
});
```

- [ ] **Step 2: Run the focused tests and verify failure**

Run: `pnpm --dir aera-admin/admin-web test -- cloud-official-agents.contract cloud-p7`

Expected: FAIL for the new capability-aware action projection.

- [ ] **Step 3: Implement the controlled action projection**

Keep existing Cloud operations and `officialRoleAllowed` mappings. Expose only:

- developer: create/update/validate/submit draft;
- different super admin: approve/reject;
- operator: activate/rollout/pause/resume;
- rollback: hidden/disabled until a separate approved rollback slice.

Every mutation sends `reason_code`, expected revision, and operation ID through the existing BFF; after success the panel reloads the Cloud object and delivery link instead of assuming success.

- [ ] **Step 4: Verify and commit**

Run: `pnpm --dir aera-admin/admin-web test -- cloud-official-agents.contract cloud-p7 publishing`

Expected: PASS. Commit:

```bash
git -C aera-admin add admin-web/src/views/publishing/modules/official-agents-panel.vue admin-web/src/service/cloud-official-agents.ts src/platform-api/cloud/operations.ts admin-web/src/service/cloud-official-agents.contract.test.ts admin-web/src/service/cloud-p7.test.ts
git -C aera-admin commit -m "feat: gate official agent cloud release actions"
```

## Task 6: Keep official plugins fail-closed until a real Desktop contract exists

**Files:**
- Modify: `aera-admin/src/collections/PluginCatalog.ts`
- Modify: `aera-admin/src/domain/content-delivery.ts`
- Modify: `aera-admin/admin-web/src/views/plugins/index.vue`
- Modify: `aera-admin/admin-web/src/views/publishing/index.vue`
- Create: `aera-admin/src/domain/plugin-delivery.test.ts`
- Test: `aera-admin/admin-web/src/service/plugins.test.ts`

- [ ] **Step 1: Write the guard test**

```ts
it('never reports a plugin as delivered without a verified Desktop contract', () => {
  expect(pluginDeliveryStatus({ cloudReleaseId: 'release-1', desktopContract: false, desktopVerified: false }))
    .toBe('contract_pending');
});
```

- [ ] **Step 2: Run the guard test and verify failure**

Run: `pnpm --dir aera-admin exec vitest run src/domain/plugin-delivery.test.ts`

Expected: FAIL because the status guard does not exist.

- [ ] **Step 3: Add the explicit status and UI guard**

Add a server-derived status field with `registered`, `contract_pending`, `cloud_published`, and `desktop_verified`. Until a checked-in Cloud/Desktop signed plugin manifest contract exists, force any plugin with a Cloud ID but no verified contract to `contract_pending`; hide install/available actions and show “等待 Desktop 插件消费协议”。

- [ ] **Step 4: Verify and commit**

Run: `pnpm --dir aera-admin exec vitest run src/domain/plugin-delivery.test.ts && pnpm --dir aera-admin/admin-web test -- plugins publishing`

Expected: PASS. Commit:

```bash
git -C aera-admin add src/collections/PluginCatalog.ts src/domain/content-delivery.ts src/domain/plugin-delivery.test.ts admin-web/src/views/plugins/index.vue admin-web/src/views/publishing/index.vue admin-web/src/service/plugins.test.ts
git -C aera-admin commit -m "feat: keep plugins fail closed without desktop contract"
```

## Task 7: Add the minimal Desktop verification receipt contract

**Files:**
- Modify: `aera/contracts/agentera-cloud.openapi.yaml`
- Modify: `aera/src/shared/agentera-cloud-api.generated.ts`
- Modify: `aera/src/main/agentera-agent-control/client.ts`
- Modify: `aera/src/main/agentera-agent-control/installation-manager.ts`
- Create/modify: `aera/src/main/agentera-agent-control/verification-receipt.ts`
- Test: `aera/src/main/agentera-agent-control/client.test.ts`
- Test: `aera/src/main/agentera-agent-control/installation-manager.test.ts`

- [ ] **Step 1: Verify whether a receipt endpoint already exists**

Run: `rg -n "verification.*receipt|catalog_visible|signature_verified|activated|delivery" aera/contracts aera-cloud/api aera/src/main/agentera-agent-control`

Expected: if an existing endpoint and DTO are found, reuse them and skip contract changes; otherwise continue with the following minimal contract.

- [ ] **Step 2: Add the failing receipt serialization test**

```ts
it('serializes only safe official delivery fields', () => {
  const body = buildVerificationReceipt({
    definitionId: 'd', versionId: 'v', releaseRevisionId: 'r', contentDigest: 'a'.repeat(64),
    status: 'activated', runtimeVersion: '1.0.0', desktopVersion: '1.0.0'
  });
  expect(body).toEqual(expect.objectContaining({ definition_id: 'd', version_id: 'v', verification_status: 'activated' }));
  expect(JSON.stringify(body)).not.toMatch(/prompt|token|secret|path|content/i);
});
```

- [ ] **Step 3: Implement the narrow receipt path**

The request may contain only definition/version/release IDs, content digest, runtime/desktop versions, stable verification status, sanitized error code, timestamp and request ID. It must never contain prompt text, bundle assets, local filesystem paths, credentials or raw logs. Send after catalog visibility, signature verification, compatibility, installation and activation; failed states are sent with stable error codes.

- [ ] **Step 4: Run Desktop focused tests and commit**

Run: `npm --prefix aera test -- --run src/main/agentera-agent-control/client.test.ts src/main/agentera-agent-control/installation-manager.test.ts`

Expected: PASS. Commit:

```bash
git -C aera add contracts/agentera-cloud.openapi.yaml src/shared/agentera-cloud-api.generated.ts src/main/agentera-agent-control/verification-receipt.ts src/main/agentera-agent-control/client.ts src/main/agentera-agent-control/installation-manager.ts src/main/agentera-agent-control/client.test.ts src/main/agentera-agent-control/installation-manager.test.ts
git -C aera commit -m "feat: report official agent delivery verification"
```

## Task 8: Persist and display Desktop verification in Admin

**Files:**
- Modify: `aera-admin/src/endpoints/content-delivery.ts`
- Modify: `aera-admin/src/collections/ContentDeliveryLinks.ts`
- Modify: `aera-admin/admin-web/src/service/publishing.ts`
- Modify: `aera-admin/admin-web/src/views/publishing/index.vue`
- Create: `aera-admin/src/endpoints/content-delivery-receipt.int.spec.ts`
- Test: `aera-admin/admin-web/src/views/publishing/content-delivery.test.ts`

- [ ] **Step 1: Write failing receipt tests**

```ts
it('marks delivery verified only for a matching released digest', async () => {
  const response = await postReceipt({ releaseId: 'release-1', contentDigest: 'a'.repeat(64), verificationStatus: 'activated' });
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ syncStatus: 'desktop_verified' });
});

it('rejects a receipt for an unknown release or mismatched digest', async () => {
  const response = await postReceipt({ releaseId: 'unknown', contentDigest: 'b'.repeat(64), verificationStatus: 'activated' });
  expect(response.status).toBe(409);
});
```

- [ ] **Step 2: Implement server-side matching**

Match the receipt against the Cloud release/version and stored digest before updating the link. Accept only the enumerated statuses; ignore duplicate receipts idempotently; store device ID only in a redacted form and store no local path or content.

- [ ] **Step 3: Add the delivery timeline UI**

Show `Cloud 已发布`, `Desktop 已看到目录`, `签名已验证`, `已安装`, `已激活` as separate tags with last-seen time, runtime/desktop versions, digest prefix, device count and request ID. A missing receipt remains “已发布，等待 Desktop 验证”, never “已交付”。

- [ ] **Step 4: Verify and commit**

Run: `pnpm --dir aera-admin exec vitest run src/endpoints/content-delivery-receipt.int.spec.ts && pnpm --dir aera-admin/admin-web test -- publishing/content-delivery`

Expected: PASS. Commit:

```bash
git -C aera-admin add src/endpoints/content-delivery.ts src/endpoints/content-delivery-receipt.int.spec.ts src/collections/ContentDeliveryLinks.ts admin-web/src/service/publishing.ts admin-web/src/views/publishing/index.vue admin-web/src/views/publishing/content-delivery.test.ts
git -C aera-admin commit -m "feat: show desktop delivery verification"
```

## Task 9: Real Beta end-to-end acceptance

**Files:**
- Create: `aera-admin/tests/e2e/content-cloud-desktop-live.e2e.ts`
- Modify: `aera-admin/playwright.platform-live.config.ts` only for stable fixture/test routing if required.
- Verify: `aera/docs/verification/` evidence entry and Admin live verification docs.

- [ ] **Step 1: Prepare isolated real test data and service evidence**

Confirm the Admin BFF and aera-cloud internal admin endpoint are running in the internal Beta, the Cloud contract mirror is exact, and a real Beta Desktop has a valid user session. Do not save credentials, keys, or tokens in the repository, command history, screenshots, or evidence.

Run:

```bash
pnpm --dir aera-admin run check:cloud-admin-contract
test -n "$AGENTERA_CLOUD_ADMIN_BASE_URL"
test -n "$AGENTERA_ADMIN_LIVE_URL"
test -n "$AGENTERA_ADMIN_LIVE_EMAIL"
test -n "$AGENTERA_ADMIN_LIVE_PASSWORD"
```

Expected: contract check passes; secrets exist only in the runtime environment.

- [ ] **Step 2: Add the browser journey assertions**

The test must create or select a disposable category, runtime-public skill, and official Agent; sync the draft; validate; submit; approve with a different actor; activate an internal release; then assert the Admin shows Cloud IDs and “等待 Desktop 验证”. It must not assert “已交付” yet.

- [ ] **Step 3: Drive the real Desktop journey**

With the same test release, assert Desktop calls the official catalog endpoint, renders the Agent, verifies the digest/signature, installs and activates it. The test then waits for the receipt and asserts Admin transitions to `desktop_verified` with matching version/digest.

- [ ] **Step 4: Exercise failure paths and cleanup**

Cover a disabled category, proprietary skill, stale revision, duplicate operation ID, Cloud unavailable state, incompatible Desktop version and receipt digest mismatch. Clean all disposable records after the run and preserve only sanitized request IDs, external IDs, statuses and timestamps.

- [ ] **Step 5: Run the full proportional verification**

Run:

```bash
pnpm --dir aera-admin run test:int
pnpm --dir aera-admin run test:admin
pnpm --dir aera-admin run test:e2e:admin
pnpm --dir aera-admin run test:e2e:live:platform
npm --prefix aera test -- --run
```

Expected: all relevant suites pass; live evidence explicitly separates code completion, verification closure and Beta deployment availability.

## Task 10: Final review and delivery gate

- [ ] **Step 1: Run repository checks**

```bash
git -C aera-admin diff --check
pnpm --dir aera-admin run lint
pnpm --dir aera-admin run build:platform
git -C aera status --short --branch
git -C aera-admin status --short --branch
git -C aera-cloud status --short --branch
```

- [ ] **Step 2: Scan sensitive output**

Search only generated test output and sanitized evidence for `AGENTERA_API_ADMIN_KEY`, `AGENTERA_CLOUD_ADMIN`, `PAYLOAD_SECRET`, private key markers, prompt fields, bundle content and local filesystem paths. Remove any accidental secret before reporting.

- [ ] **Step 3: Confirm the release claims**

Report separately:

1. which commits and exact heads contain the implementation;
2. which tests passed locally and against real Beta services;
3. whether Cloud and Desktop deployment candidates are running;
4. which pages are truly real and which remain intentionally disabled;
5. that Aera API upstream remains a separate not-configured area;
6. that plugin delivery remains `contract_pending` unless the signed Cloud/Desktop contract and real Desktop verification exist.

- [ ] **Step 4: Commit any final documentation only after evidence exists**

```bash
git -C aera-admin add docs/verification docs/operations
git -C aera-admin commit -m "docs: record content delivery beta verification"
```

## Self-review checklist

- Spec coverage: architecture/data ownership (Tasks 1, 3, 7, 8); P0 pages (Tasks 2–6, 8); capability/security (Tasks 3, 5, 7, 8); errors (Tasks 2, 3, 8); implementation slices (Tasks 1–8); acceptance/testing (Task 9); completion boundaries (Task 10).
- Placeholder scan: the only conditional wording is the explicit “reuse an existing receipt endpoint if found” check in Task 7; no open-ended TODO/TBD steps are present.
- Type consistency: `DeliveryStatus`, `ContentDeliveryLink`, Cloud IDs, `contentDigest`, `runtimeManifestSha256`, and `desktop_verified` are introduced in Task 1 and reused consistently in Tasks 2, 3, 8 and 9.
- Safety: no task enables Aera API business mutations, Desktop restart/upgrade/config push, or plugin installation without a real signed consumer contract.
