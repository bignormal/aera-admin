# AgentEra 商业运营与 API 运维统一后台 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将已完成的大模型充值网站背后的套餐、订阅、订单、支付、营销和 API 运维能力接入 Soybean，让平台管理员统一运营而不改写用户充值产品。

**Architecture:** 延续阶段 2 的 allowlist BFF 和固定 envelope；只扩展操作注册表、类型化适配器、Soybean service 与页面。`agentera-claw-api` 继续处理支付状态机、履约、账务、监控、备份和设置，Payload 只做身份、capability、输入收敛、脱敏和审计。

**Tech Stack:** Payload 3、Vue 3、Naive UI、TypeScript、Vitest、Playwright、既有 Go/Gin Admin API。

## Global Constraints

- 不修改用户充值页面、收银台、支付回调、订单状态机、余额入账或支付 Provider 实现。
- 不把套餐、订单、订阅、兑换码、公告、运维日志或设置复制为 Payload Collection。
- 本阶段开放普通和重要操作；退款、数据库恢复、支付渠道密钥修改等高风险写操作只接入读取与校验，不在 Soybean 暴露执行按钮，待阶段 6 重新验证完成后启用。
- 所有金额使用上游既有字符串/decimal 表达，不在浏览器用二进制浮点重新计算账务结果。
- 导出使用服务端生成或流式转发；不得把整库数据先载入浏览器。
- 生产支付服务不得用于自动化测试；使用 `agentera-claw-api` 测试 fixture 和无外呼 Provider。

---

## 页面、数据源与 capability

| Soybean 页面 | 上游域                      | capability                             | 本阶段写操作                     |
| ------------ | --------------------------- | -------------------------------------- | -------------------------------- |
| 商业总览     | payment dashboard           | `billing:read`                         | 无                               |
| 套餐管理     | payment plans               | `billing:read` / `billing:write`       | 创建、编辑、启停                 |
| 订阅管理     | subscriptions               | `billing:read` / `billing:write`       | 分配、延期、重置额度、撤销、恢复 |
| 订单中心     | payment orders              | `billing:read` / `billing:write`       | 取消、重试履约；退款仅查询       |
| 支付渠道     | payment providers/config    | `billing:read`                         | 只读与连通状态                   |
| 营销工具     | redeem/promo                | `billing:read` / `billing:write`       | 生成、导出、失效                 |
| 邀请返利     | affiliates                  | `billing:read` / `billing:write`       | 现有非资金高风险动作             |
| 公告运营     | announcements               | `operations:read` / `operations:write` | 创建、编辑、发布、删除           |
| 运维总览     | ops/dashboard               | `operations:read`                      | 无                               |
| 请求诊断     | ops requests/errors         | `operations:read` / `operations:write` | 标记处理                         |
| 告警中心     | ops alerts                  | `operations:read` / `operations:write` | 规则、状态、静默                 |
| 风控中心     | risk-control                | `operations:read` / `operations:write` | 配置、解封、哈希清理             |
| 使用与日志   | usage/system logs           | `operations:read` / `operations:write` | 清理任务                         |
| 数据与设置   | backup/data/settings/system | `system:read` / `system:write`         | 非高风险设置；恢复延后           |

### Task 1: 扩展商业操作 allowlist

**Files:**

- Modify: `src/platform-api/operations.ts`
- Create: `src/platform-api/billing.ts`
- Create: `tests/int/platform-billing.int.spec.ts`

**Interfaces:**

- Consumes existing routes from `backend/internal/server/routes/payment.go` and `admin.go`.
- Produces normalized order/plan/subscription/marketing/announcement DTOs without credentials.

- [ ] **Step 1: 核对真实商业路由并写失败测试**

Run:

```bash
cd '/Users/zizimutou/Desktop/agentera claw/agentera-claw-api'
rg -n 'adminGroup\.(GET|POST|PUT|DELETE)|plans\.(GET|POST|PUT|DELETE)|adminOrders\.(GET|POST)|register(Subscription|RedeemCode|PromoCode|Affiliate|Announcement)Routes' backend/internal/server/routes
```

Then test these required mappings in `tests/int/platform-billing.int.spec.ts`:

```ts
expect(operation('listPaymentOrders').upstreamPath({})).toBe('/admin/payment/orders')
expect(operation('listPaymentPlans').upstreamPath({})).toBe('/admin/payment/plans')
expect(operation('listPaymentProviders').upstreamPath({})).toBe('/admin/payment/providers')
expect(operation('processRefund').capability).toBe('billing:order:refund')
expect(operation('processRefund').requiresReauthentication).toBe(true)
```

Run `pnpm vitest run --config ./vitest.config.mts tests/int/platform-billing.int.spec.ts`.

Expected: FAIL because the operations are not registered.

- [ ] **Step 2: 增加商业操作与高风险锁**

Extend `PlatformOperation` with:

```ts
risk: 'normal' | 'important' | 'high'
requiresReauthentication?: boolean
```

Register dashboard/config/orders/plans/providers, subscriptions, redeem codes, promo codes, affiliates and announcements. Set `processRefund`, provider secret mutation and any money transfer operation to `{ risk: 'high', requiresReauthentication: true }`. Until phase 6, `handler.ts` must return `409 REAUTHENTICATION_NOT_AVAILABLE` for such operations before making an upstream request.

- [ ] **Step 3: 实现金额与凭证适配器**

In `src/platform-api/billing.ts`, expose:

```ts
export function normalizeMoney(value: string | number): string
export function sanitizePaymentProvider<T>(provider: T): T
export function normalizePagination<T>(value: unknown): {
  data: T[]
  meta: { page: number; pageSize: number; total: number }
}
```

`sanitizePaymentProvider` must replace secret-bearing values with masked status fields such as `{ configured: true, masked: '****7A9F' }` and never return ciphertext.

- [ ] **Step 4: 验证并提交**

Run:

```bash
cd '/Users/zizimutou/Desktop/agentera claw/agentera-admin'
pnpm vitest run --config ./vitest.config.mts tests/int/platform-billing.int.spec.ts
pnpm run test:int
git add src/platform-api tests/int/platform-billing.int.spec.ts
git commit -m "feat: add commercial admin bff operations"
```

Expected: commercial mappings, amount normalization, redaction and high-risk lock tests pass.

### Task 2: 完成商业与营销 Soybean 页面

**Files:**

- Create: `admin-web/src/service/billing.ts`
- Create: `admin-web/src/service/billing.test.ts`
- Create: `admin-web/src/views/billing/overview/index.vue`
- Create: `admin-web/src/views/billing/plans/index.vue`
- Create: `admin-web/src/views/billing/subscriptions/index.vue`
- Create: `admin-web/src/views/billing/orders/index.vue`
- Create: `admin-web/src/views/billing/providers/index.vue`
- Create: `admin-web/src/views/marketing/index.vue`
- Create: `admin-web/src/views/announcements/index.vue`
- Modify: `admin-web/src/router/elegant/routes.ts`
- Modify: `admin-web/src/router/elegant/imports.ts`

**Interfaces:**

- Reuse API field knowledge from `agentera-claw-api/frontend/src/api/admin/payment.ts`, `subscriptions.ts`, `redeem.ts`, `promo.ts`, `affiliates.ts`, `announcements.ts`.
- Pages call only `/api/platform/v1/*`; no import or runtime dependency on the API frontend.

- [ ] **Step 1: 写金额、状态和动作失败测试**

Assert money remains a string, order status maps to a known tag or safe `unknown` tag, cancellation and retry are POST, refund button is absent, provider secrets never populate a form, and unavailable upstream shows the shared error state.

Run `pnpm --dir admin-web vitest run src/service/billing.test.ts`.

Expected: FAIL because the service does not exist.

- [ ] **Step 2: 实现四个商业页面和两个合并页面**

Use server pagination and detail drawers. Merge redeem/promo/affiliate into the marketing page with tabs. Orders provide detail/cancel/retry and refund status query; providers show type, enabled state, connectivity and masked configuration only. Announcements retain the upstream as the sole source.

- [ ] **Step 3: 生成路由、验证并提交**

Run:

```bash
pnpm --dir admin-web gen-route
pnpm --dir admin-web fmt
pnpm --dir admin-web test
pnpm --dir admin-web typecheck
git add admin-web/src
git commit -m "feat: add soybean commercial operations"
```

Expected: completed recharge site's management data is available in Soybean without copying its frontend.

### Task 3: 扩展运维、风控和日志操作 allowlist

**Files:**

- Modify: `src/platform-api/operations.ts`
- Create: `src/platform-api/operations-adapter.ts`
- Create: `tests/int/platform-operations.int.spec.ts`

**Interfaces:**

- Covers `/admin/ops/*`, `/admin/risk-control/*`, usage, data management, backup, settings and system routes.
- WebSocket QPS is not proxied in V1; Soybean polls the existing snapshot/realtime HTTP endpoints.

- [ ] **Step 1: 核对路由并写失败测试**

Run:

```bash
cd '/Users/zizimutou/Desktop/agentera claw/agentera-claw-api'
rg -n 'ops\.(GET|POST|PUT|DELETE)|risk\.(GET|POST|PUT|DELETE)|register(Usage|DataManagement|Backup|Settings|System)Routes' backend/internal/server/routes
```

Test that every mutating operation has `operations:write` or `system:write`, `restoreBackup` requires `system:backup:restore` plus reauthentication, and no registered path contains `/ws/`.

Run `pnpm vitest run --config ./vitest.config.mts tests/int/platform-operations.int.spec.ts`.

Expected: FAIL because these operations are absent.

- [ ] **Step 2: 注册 HTTP 运维操作并归一化错误**

Expose this DTO boundary in `src/platform-api/operations-adapter.ts`:

```ts
export type DiagnosticSummary = {
  requestId: string
  occurredAt: string
  model?: string
  channel?: string
  status: string
  latencyMs?: number
  errorCode?: string
  errorSummary?: string
}

export function sanitizeDiagnostic(value: unknown): DiagnosticSummary
```

Remove request/response bodies, prompt text, raw headers, cookies, authorization and tokens. Preserve only structured metadata required by the design spec.

- [ ] **Step 3: 锁定恢复和密钥类高风险操作**

Register backup list/create/download/delete as permitted according to upstream semantics, but mark restore as `requiresReauthentication`. Mark system admin-key regeneration and payment configuration mutation the same way. The phase-3 handler must reject them locally with zero upstream calls.

- [ ] **Step 4: 验证并提交**

Run:

```bash
cd '/Users/zizimutou/Desktop/agentera claw/agentera-admin'
pnpm vitest run --config ./vitest.config.mts tests/int/platform-operations.int.spec.ts
pnpm run test:int
git add src/platform-api tests/int/platform-operations.int.spec.ts
git commit -m "feat: add operational admin bff operations"
```

Expected: operational mappings, diagnostic redaction and high-risk locks pass.

### Task 4: 完成运维、安全、数据与系统 Soybean 页面

**Files:**

- Create: `admin-web/src/service/operations.ts`
- Create: `admin-web/src/service/operations.test.ts`
- Create: `admin-web/src/views/operations/overview/index.vue`
- Create: `admin-web/src/views/operations/traffic/index.vue`
- Create: `admin-web/src/views/operations/diagnostics/index.vue`
- Create: `admin-web/src/views/operations/alerts/index.vue`
- Create: `admin-web/src/views/security/risk/index.vue`
- Create: `admin-web/src/views/operations/usage-logs/index.vue`
- Create: `admin-web/src/views/system/data/index.vue`
- Create: `admin-web/src/views/system/settings/index.vue`
- Modify: `admin-web/src/router/elegant/routes.ts`
- Modify: `admin-web/src/router/elegant/imports.ts`

**Interfaces:**

- Reuse field knowledge from `agentera-claw-api/frontend/src/api/admin/ops.ts`, `riskControl.ts`, `usage.ts`, `backup.ts`, `dataManagement.ts`, `settings.ts`, `system.ts`.
- Dashboard uses HTTP snapshot polling with cancellation on route leave.

- [ ] **Step 1: 写轮询、脱敏、错误和取消失败测试**

Use fake timers and mocked fetch. Assert only one poll is active, route disposal aborts it, diagnostics omit raw bodies and headers, unknown status is safe, 429 displays backoff, and high-risk actions are not rendered.

Run `pnpm --dir admin-web vitest run src/service/operations.test.ts`.

Expected: FAIL because service and pages are absent.

- [ ] **Step 2: 实现八个运维页面**

Keep charts limited to overview/traffic; use standard tables/drawers elsewhere. Diagnostics show request metadata and sanitized error chain. Alerts support rule/event/status/silence. Data page shows backups and cleanup tasks but no restore action. Settings uses grouped tabs and write-only secret replacement fields.

- [ ] **Step 3: 生成路由、验证并提交**

Run:

```bash
pnpm --dir admin-web gen-route
pnpm --dir admin-web fmt
pnpm --dir admin-web test
pnpm --dir admin-web typecheck
git add admin-web/src
git commit -m "feat: add soybean platform operations"
```

Expected: all completed operational modules are reachable from consolidated menu groups.

### Task 5: 商业与运维契约 E2E 和阶段验收

**Files:**

- Create: `tests/int/platform-commerce-ops-contract.int.spec.ts`
- Create: `tests/e2e-soybean/commerce-ops.e2e.spec.ts`
- Modify: `playwright.soybean.config.ts`

- [ ] **Step 1: 运行非生产上游契约测试**

Cover a representative GET and mutation for each domain: dashboard, plan, subscription, order, marketing, announcement, ops, alert, risk, usage, backup and settings. Assert refund/restore/provider-secret writes do not reach upstream before reauthentication exists.

Run `pnpm vitest run --config ./vitest.config.mts tests/int/platform-commerce-ops-contract.int.spec.ts`.

Expected: all registered paths and envelopes agree with the real Admin API.

- [ ] **Step 2: 运行浏览器流程**

Cover business dashboard, plan edit, subscription action, order detail/cancel/retry, marketing generation, announcement publish, traffic refresh, diagnostic detail, alert silence, risk unban, backup list and settings failure state. Assert no refund/restore/provider-secret action is visible.

Run `pnpm run test:e2e:admin -- tests/e2e-soybean/commerce-ops.e2e.spec.ts`.

Expected: all flows pass using disposable upstream data.

- [ ] **Step 3: 全阶段验证并提交**

Run:

```bash
pnpm run test:int
pnpm run test:admin
pnpm --dir admin-web typecheck
pnpm --dir admin-web lint
pnpm run build
pnpm run build:admin
pnpm run test:e2e:admin
git diff --check
git add tests/int/platform-commerce-ops-contract.int.spec.ts tests/e2e-soybean/commerce-ops.e2e.spec.ts playwright.soybean.config.ts
git commit -m "test: verify commercial and operations admin"
```

Expected: platform administrators can operate existing commerce and API systems through Soybean, while high-risk actions remain safely locked until phase 6.
