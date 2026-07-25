# AgentEra 后台安全加固与正式切换 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为高风险操作增加一次性重新验证，证明审计、密钥、错误、分页和性能边界，完成 Soybean 同源生产入口并删除旧 Payload 演示页面。

**Architecture:** Payload 使用管理员密码重新认证后签发最长 60 秒、绑定管理员/capability/目标的一次性 grant；BFF 在同一数据库事务内消费 grant 并执行高风险上游操作。审计条目增加服务端 HMAC 完整性签名。生产反向代理将 `/admin/*` 指向 Soybean 静态文件、`/api/*` 指向 Payload，原生 Payload Admin 只允许内部网络访问。

**Tech Stack:** Payload 3、Node crypto、SQLite、Vue 3、Playwright、Nginx/Caddy 文档化配置、四仓库既有测试工具链。

## Global Constraints

- 只有 `super_admin` 能执行永久删除用户、退款、支付渠道密钥修改、批量 Runtime 高风险命令、数据库恢复和管理密钥重建。
- Soybean 只把管理员密码发送到 Payload `/reauth`; Payload 不记录密码，不发送给业务 API，不写入审计 before/after。
- grant 只使用一次、最长 60 秒、绑定 capability 和目标；过期、重放、换目标和换管理员全部失败。
- 所有高风险上游请求带幂等键；超时后显示“结果未知，需要查询”，不自动重试。
- 审计导出默认脱敏，只有 `audit:read` 可用；任何导出动作本身也写审计。
- 不删除或重写已完成的大模型充值站。API 旧管理页面可保留为代码级应急回滚路径，但生产平台管理入口只指向 Soybean。
- 删除的是 Payload 自定义平台演示视图和演示数据，不删除标准集合数据或正式内容。

---

### Task 1: 增加一次性 reauthentication grant

**Files:**

- Create: `src/collections/ReauthGrants.ts`
- Create: `src/domain/reauth.ts`
- Create: `src/endpoints/reauth.ts`
- Create: `tests/int/reauth.int.spec.ts`
- Modify: `src/payload.config.ts`

**Interfaces:**

- `POST /api/platform/v1/reauth` body: password, capability, resourceType, resourceId, reason.
- Response: `{ data: { grant: string; expiresAt: string }, meta: {}, requestId }`.
- Stored grant: tokenHash, admin, capability, resourceType, resourceId, reason, expiresAt, consumedAt.

- [ ] **Step 1: 写密码、绑定、过期和重放失败测试**

Assert wrong password returns 401, non-super-admin returns 403, plaintext password/token are absent from DB/logs, a grant cannot be used by another admin/capability/target, expires after 60 seconds, and the second consume returns 409 without an upstream call.

Run `pnpm vitest run --config ./vitest.config.mts tests/int/reauth.int.spec.ts`.

Expected: FAIL because reauthentication does not exist.

- [ ] **Step 2: 实现内部 grant 集合**

`ReauthGrants` REST access returns false for create/read/update/delete. Store only `sha256(grant)`. Add indexes for hash and expiry; set a short retention hook that deletes expired/consumed grants after the audit event exists.

- [ ] **Step 3: 验证密码并签发 grant**

Use Payload's configured `admins` authentication method to verify the current user's email/password. Generate `randomBytes(32).toString('base64url')`; persist only its hash. Accept only a `Capability` that is both high risk and held by `super_admin`.

The public boundary is:

```ts
export type ReauthBinding = {
  adminId: string
  capability: Capability
  resourceType: string
  resourceId: string
}

export async function consumeReauthGrant(
  req: PayloadRequest,
  token: string,
  binding: ReauthBinding,
): Promise<{ reason: string; grantId: string }>
```

The consume implementation must update only a matching unconsumed, unexpired row inside a Payload transaction and require exactly one updated record.

- [ ] **Step 4: 验证并提交**

Run:

```bash
pnpm run generate:types
pnpm vitest run --config ./vitest.config.mts tests/int/reauth.int.spec.ts
pnpm run test:int
git add src/collections/ReauthGrants.ts src/domain/reauth.ts src/endpoints/reauth.ts src/payload.config.ts src/payload-types.ts tests/int/reauth.int.spec.ts
git commit -m "feat: add one-time high-risk reauthentication"
```

Expected: password verification and single-use binding tests pass.

### Task 2: 解锁经过重认证的高风险 BFF 操作

**Files:**

- Modify: `src/platform-api/handler.ts`
- Modify: `src/platform-api/operations.ts`
- Create: `tests/int/high-risk-operations.int.spec.ts`

**Interfaces:**

- High-risk requests require `X-AgentEra-Reauth-Grant` and `Idempotency-Key`.
- Required operations: permanent user delete, refund, payment provider secret mutation, database restore and management-key regeneration.
- Runtime high-risk commands remain unavailable until an instance advertises their exact capability.

- [ ] **Step 1: 写零上游调用、幂等和未知结果失败测试**

Assert missing/invalid grant returns before upstream, valid grant calls once, duplicate idempotency key returns the prior result, upstream timeout is `HIGH_RISK_RESULT_UNKNOWN`, and retry must first query operation status rather than call mutation again.

Run `pnpm vitest run --config ./vitest.config.mts tests/int/high-risk-operations.int.spec.ts`.

Expected: FAIL because phase 3 still returns `REAUTHENTICATION_NOT_AVAILABLE`.

- [ ] **Step 2: 在 mutation 前消费 grant**

For operations where `requiresReauthentication` is true: validate capability, target and idempotency key; consume grant; write an attempt audit; call upstream once; write success/failure/unknown audit. Include both BFF and upstream request IDs.

- [ ] **Step 3: 明确 Runtime capability 门**

Add high-risk runtime command types to the operation registry only as capability-gated definitions. `createRuntimeCommand` must reject any type whose required capability is absent from the selected instance. Do not alter Runtime/Studio clients or advertise unsupported capabilities in this task.

- [ ] **Step 4: 验证并提交**

Run:

```bash
pnpm vitest run --config ./vitest.config.mts tests/int/high-risk-operations.int.spec.ts
pnpm run test:int
git add src/platform-api tests/int/high-risk-operations.int.spec.ts
git commit -m "feat: secure high-risk platform operations"
```

Expected: all high-risk calls are one-time, bound, audited and idempotent.

### Task 3: 在 Soybean 增加统一高风险确认流程

**Files:**

- Create: `admin-web/src/service/reauth.ts`
- Create: `admin-web/src/service/reauth.test.ts`
- Create: `admin-web/src/components/platform/high-risk-confirm.vue`
- Modify: `admin-web/src/views/users/index.vue`
- Modify: `admin-web/src/views/billing/orders/index.vue`
- Modify: `admin-web/src/views/billing/providers/index.vue`
- Modify: `admin-web/src/views/system/data/index.vue`
- Modify: `admin-web/src/views/system/settings/index.vue`
- Modify: `admin-web/src/views/runtime/instances/index.vue`

**Interfaces:**

- Dialog collects current password, mandatory reason and target confirmation.
- Grant is held only in a function-local variable for the immediate request; never Pinia/localStorage/sessionStorage/URL.

- [ ] **Step 1: 写 grant 生命周期和 UI 失败测试**

Assert password uses `type=password`, reason is required, grant is sent once in a header, component state clears on success/failure/unmount, no storage API is called, timeout result directs the operator to status query, and unsupported Runtime actions remain absent.

Run `pnpm --dir admin-web vitest run src/service/reauth.test.ts`.

Expected: FAIL because service/component are absent.

- [ ] **Step 2: 实现单一确认组件并接入五类页面**

Expose:

```ts
export async function executeHighRisk<T>(input: {
  password: string
  reason: string
  capability: Capability
  resourceType: string
  resourceId: string
  execute: (grant: string, idempotencyKey: string) => Promise<T>
}): Promise<T>
```

Generate idempotency key with `crypto.randomUUID()` once per operator attempt. Clear password and grant in `finally`.

- [ ] **Step 3: 验证并提交**

Run:

```bash
pnpm --dir admin-web fmt
pnpm --dir admin-web test
pnpm --dir admin-web typecheck
git add admin-web/src
git commit -m "feat: add soybean high-risk confirmations"
```

Expected: high-risk pages use one shared component and no persistent proof storage.

### Task 4: 为审计日志增加完整性签名、查询和导出

**Files:**

- Modify: `src/collections/AuditLogs.ts`
- Modify: `src/domain/audit.ts`
- Create: `src/endpoints/audit.ts`
- Create: `tests/int/audit-integrity.int.spec.ts`
- Create: `admin-web/src/service/audit.ts`
- Create: `admin-web/src/service/audit.test.ts`
- Create: `admin-web/src/views/audit/index.vue`
- Modify: `admin-web/src/router/elegant/routes.ts`
- Modify: `admin-web/src/router/elegant/imports.ts`

**Interfaces:**

- Each entry has `integrityVersion` and HMAC-SHA256 `integritySignature` over canonical redacted fields.
- `GET /api/platform/v1/audit/verify`, `GET /api/platform/v1/audit/export`.

- [ ] **Step 1: 写篡改、查询和导出失败测试**

Assert canonical field order yields stable signature, any persisted field change fails verification, secret fields are absent from CSV/JSONL, filters include actor/action/resource/outcome/time/requestId, and export creates its own audit event.

Run `pnpm vitest run --config ./vitest.config.mts tests/int/audit-integrity.int.spec.ts`.

Expected: FAIL because signatures/endpoints do not exist.

- [ ] **Step 2: 实现服务端 HMAC 完整性**

Derive a dedicated audit HMAC key from `PAYLOAD_SECRET` with HKDF context `agentera-audit-v1`. Canonicalize a fixed list of redacted fields; never sign database-generated timestamps before they are final. Existing unsigned rows report `legacy_unsigned`, not false success.

- [ ] **Step 3: 实现分页查询、流式导出和 Soybean 页面**

Use server pagination. Export streams CSV or JSONL with a bounded row count and content-disposition filename; page offers filters, detail drawer, verification status and export. The browser never receives `integritySignature` unless needed for verification display.

- [ ] **Step 4: 验证并提交**

Run:

```bash
pnpm run generate:types
pnpm run test:int
pnpm --dir admin-web test
pnpm --dir admin-web typecheck
pnpm --dir admin-web gen-route
pnpm --dir admin-web fmt
git add src/collections/AuditLogs.ts src/domain/audit.ts src/endpoints/audit.ts src/payload-types.ts tests/int/audit-integrity.int.spec.ts admin-web/src
git commit -m "feat: add verifiable platform audit center"
```

Expected: signed entries verify, tampering is detected and exports stay redacted.

### Task 5: 删除旧 Payload 演示视图和正式菜单残留

**Files:**

- Delete: `src/components/admin/platform/PlatformDashboard.tsx`
- Delete: `src/components/admin/platform/PlatformModuleView.tsx`
- Delete: `src/components/admin/platform/PlatformTrendChart.tsx`
- Delete: `src/components/admin/platform/PlatformViewShell.tsx`
- Delete: `src/components/admin/platform/platformAccess.ts`
- Delete: `src/components/admin/platform/platformModules.ts`
- Modify: `src/payload.config.ts`
- Modify: `src/seed.ts`
- Modify: `tests/int/platform-admin.int.spec.ts`

**Interfaces:**

- Payload standard collection UI stays available internally.
- Formal platform navigation and dashboard exist only in Soybean.

- [ ] **Step 1: 写演示视图不存在失败测试**

Assert Payload config contains no custom dashboard/accountReviews/orders/plans/tenants/taskRuns/runtimeVersions/systemSettings demo views, seed creates no demo-only objects, and all real collections remain registered.

Run `pnpm vitest run --config ./vitest.config.mts tests/int/platform-admin.int.spec.ts`.

Expected: FAIL while old custom views remain.

- [ ] **Step 2: 删除演示组件和 config view registrations**

Remove only custom platform views. Keep `Admins`, `Media`, content catalogs, runtime collections, audit and internal auth. Do not delete real SQLite rows automatically.

- [ ] **Step 3: 生成 import map、验证并提交**

Run:

```bash
pnpm run generate:importmap
pnpm run generate:types
pnpm vitest run --config ./vitest.config.mts tests/int/platform-admin.int.spec.ts
pnpm run build
git add src 'src/app/(payload)/admin/importMap.js' tests/int/platform-admin.int.spec.ts
git commit -m "refactor: remove legacy payload platform demos"
```

Expected: Payload builds as an internal control service without formal demo pages.

### Task 6: 生产同源路由、健康检查和运行文档

**Files:**

- Create: `deploy/nginx/agentera-admin.conf`
- Create: `deploy/README.md`
- Create: `docs/operations/platform-admin-runbook.md`
- Modify: `admin-web/vite.config.ts`
- Modify: `.env.example`
- Modify: `package.json`

**Interfaces:**

- `/admin/*` -> Soybean static SPA with fallback to `/admin/index.html`.
- `/api/*` -> Payload; browser and Payload remain same-origin.
- Payload native Admin is internal-only on its service address, not public `/admin`.

- [ ] **Step 1: 写生产路由静态测试**

Create a Vitest or Node test that asserts the config preserves `/api` path, serves hashed assets with immutable cache, serves SPA entry with no-cache, limits request body size, forwards request ID/IP/proto and does not expose Payload native Admin through public `/admin`.

Run `pnpm vitest run --config ./vitest.config.mts tests/int/production-routing.int.spec.ts`.

Expected: FAIL before config/test exists.

- [ ] **Step 2: 添加可直接使用的 Nginx 配置**

Use named upstreams for Payload and a static `root` for `admin-web/dist`. Include security headers, `/api` proxy, `/admin/assets` cache and SPA fallback. Do not embed secrets or absolute developer-machine paths.

- [ ] **Step 3: 写运维 runbook**

Document required secrets, first admin bootstrap, API connectivity, Runtime enrollment, database backup before migration, health checks, audit verification, rotation, rollback to the prior service release and keeping the completed recharge site independently healthy.

- [ ] **Step 4: 验证并提交**

Run:

```bash
pnpm vitest run --config ./vitest.config.mts tests/int/production-routing.int.spec.ts
pnpm run build
pnpm run build:admin
git diff --check
git add deploy docs/operations admin-web/vite.config.ts .env.example package.json tests/int/production-routing.int.spec.ts
git commit -m "ops: add platform admin production cutover"
```

Expected: production routing is same-origin and documented without secrets.

### Task 7: 安全、容量和回归验证

**Files:**

- Create: `tests/int/platform-security.int.spec.ts`
- Create: `tests/int/platform-pagination.int.spec.ts`
- Create: `tests/e2e-soybean/platform-security.e2e.spec.ts`
- Modify: `playwright.soybean.config.ts`

- [ ] **Step 1: 增加凭证和敏感正文扫描测试**

Seed canary values for admin API key, device secret, payment secret, prompt, chat message and terminal output. Exercise list/detail/error/export/log flows and assert none of the canaries appear in HTTP responses, browser storage, console output, screenshots, audit export or built Soybean assets.

Run:

```bash
pnpm vitest run --config ./vitest.config.mts tests/int/platform-security.int.spec.ts
pnpm run test:e2e:admin -- tests/e2e-soybean/platform-security.e2e.spec.ts
```

Expected: no canary escapes its owner.

- [ ] **Step 2: 增加大分页和超时测试**

Generate disposable records at 10k user-equivalent, 10k commands and 100k audit rows. Assert bounded page sizes, indexed filters, no browser full-table load, aggregate timeout, export row cap and p95 targets recorded in the verification artifact.

Run `pnpm vitest run --config ./vitest.config.mts tests/int/platform-pagination.int.spec.ts`.

Expected: pagination and query plans stay bounded; failures identify the exact index/query to fix.

- [ ] **Step 3: 运行代表性高风险 E2E**

Cover wrong password, grant expiry/replay, refund with fixture Provider, restore with disposable database, permanent delete with disposable user, payment-provider write-only secret, idempotency replay and unknown-result recovery. No real payment or production database is permitted.

Run `pnpm run test:e2e:admin`.

Expected: all role, normal, failure and high-risk flows pass.

### Task 8: 四仓库最终验证与正式切换记录

**Files:**

- Create: `docs/superpowers/verification/2026-07-16-agentera-platform-admin-verification.md`
- Modify: `docs/superpowers/specs/2026-07-16-agentera-platform-admin-full-system-design.md`

- [ ] **Step 1: 验证 Admin**

Run:

```bash
cd '/Users/zizimutou/Desktop/agentera claw/agentera-admin'
pnpm run generate:types
pnpm run test:int
pnpm run test:admin
pnpm --dir admin-web typecheck
pnpm --dir admin-web lint
pnpm run build
pnpm run build:admin
pnpm run test:e2e:admin
git diff --check
```

Expected: all commands pass.

- [ ] **Step 2: 验证 API 和已完成充值站**

Run:

```bash
cd '/Users/zizimutou/Desktop/agentera claw/agentera-claw-api'
make -C backend generate
make test
make build
git diff --check
```

Expected: API backend, original frontend, payment critical tests and builds pass.

- [ ] **Step 3: 验证 Runtime 与 Studio 默认无外呼**

Run:

```bash
cd '/Users/zizimutou/Desktop/agentera claw/agentera-claw-runtime'
scripts/run_tests.sh tests/hermes_cli/test_platform_control.py
scripts/run_tests.sh tests

cd '/Users/zizimutou/Desktop/agentera claw/hermes-studio'
npm run test -- tests/server/platform-control-client.test.ts tests/server/platform-control-routes.test.ts tests/server/shutdown.test.ts
npm run harness
npm run build
```

Expected: both clients are silent by default and all targeted/full verification passes.

- [ ] **Step 4: 写真实验收记录**

Record repository SHA, commands/exit codes, browser screenshots, migration backup, secret scan, performance results, rollback points and unresolved non-blockers. Check design-spec boxes only for evidence-backed completion.

- [ ] **Step 5: 提交验收记录**

Run:

```bash
cd '/Users/zizimutou/Desktop/agentera claw/agentera-admin'
git add docs/superpowers/verification/2026-07-16-agentera-platform-admin-verification.md docs/superpowers/specs/2026-07-16-agentera-platform-admin-full-system-design.md
git commit -m "docs: verify soybean platform admin cutover"
```

Expected: the record distinguishes implemented, smoke-verified and fully verified; it does not claim production deployment unless deployment was separately authorized and actually performed.
