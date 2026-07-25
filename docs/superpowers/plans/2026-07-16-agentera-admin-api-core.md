# AgentEra 用户与 AI 资源统一后台 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 通过 Payload allowlist BFF，把 `agentera-claw-api` 已有的用户与 AI 资源管理能力安全接入 Soybean，不改造已经完成的大模型充值网站。

**Architecture:** Soybean 请求 `/api/platform/v1/*`；Payload 验证管理员 Cookie 和 capability 后，由服务端适配器使用 `AGENTERA_API_ADMIN_KEY` 调用 `/api/v1/admin/*`，统一分页、错误、字段和脱敏，再写审计。BFF 每个操作显式注册 method/path/capability，不接受任意上游 URL。

**Tech Stack:** Payload 3、TypeScript、Vue 3、Naive UI、Vitest、Playwright、Go/Gin 既有 Admin API。

## Global Constraints

- `agentera-claw-api` 是用户、余额、API Key、渠道、账号、路由组、代理和监控的唯一数据源。
- 本阶段不修改用户充值前台、支付回调、订单表、支付 Provider 或用户登录流程。
- Admin API Key 只能从 Payload 服务端环境读取；任何异常对象、日志和响应都不得包含其值。
- GET 最多重试一次网络错误或 502/503/504；POST/PUT/DELETE 不自动重试。
- BFF 返回固定 `{ data, meta, requestId }` 或 `{ error, requestId }`；不透传 Gin 原始错误堆栈。
- 上游未配置返回 `503 UPSTREAM_NOT_CONFIGURED`；超时返回 `504 UPSTREAM_TIMEOUT`；权限不足由 Payload 返回 403。
- API 现有 Vue 管理后台继续可用，直到本阶段全部 E2E 通过。

---

## 页面、上游路径与 capability

| Soybean 页面 | BFF 前缀                              | 上游 Admin API                                                      | capability                                 |
| ------------ | ------------------------------------- | ------------------------------------------------------------------- | ------------------------------------------ |
| 平台用户     | `/users`                              | `/admin/users`                                                      | `users:read` / `users:write`               |
| 用户额度     | `/users/:id/balance`                  | `/admin/users/:id/balance`                                          | `users:balance:update`                     |
| 用户属性     | `/user-attributes`                    | `/admin/user-attributes`                                            | `users:read` / `users:write`               |
| 模型渠道     | `/ai/groups`                          | `/admin/groups`                                                     | `ai-resources:read` / `ai-resources:write` |
| 上游账号     | `/ai/accounts`                        | `/admin/accounts`                                                   | `ai-resources:read` / `ai-resources:write` |
| 代理节点     | `/ai/proxies`                         | `/admin/proxies`                                                    | `ai-resources:read` / `ai-resources:write` |
| 渠道         | `/ai/channels`                        | `/admin/channels`                                                   | `ai-resources:read` / `ai-resources:write` |
| 渠道监控     | `/ai/channel-monitors`                | `/admin/channel-monitors`                                           | `ai-resources:read` / `ai-resources:write` |
| 定时测试     | `/ai/scheduled-tests`                 | `/admin/scheduled-tests`                                            | `ai-resources:read` / `ai-resources:write` |
| 高级网络     | `/ai/tls-profiles`, `/ai/error-rules` | `/admin/tls-fingerprint-profiles`, `/admin/error-passthrough-rules` | `ai-resources:read` / `ai-resources:write` |

Before implementation, verify exact route spellings with:

```bash
cd '/Users/zizimutou/Desktop/agentera claw/agentera-claw-api'
rg -n 'Group\("/(users|user-attributes|groups|accounts|proxies|channels|channel-monitors|scheduled-tests|tls-fingerprint|error-passthrough)' backend/internal/server/routes
```

If a spelling differs, update this plan's operation registry test and mapping together; do not add an alias to the business API merely to match the table.

### Task 1: 建立 BFF 契约、配置和上游客户端

**Files:**

- Modify: `src/platform-api/types.ts`
- Modify: `src/platform-api/config.ts`
- Modify: `src/platform-api/client.ts`
- Create: `src/platform-api/redaction.ts`
- Create: `tests/int/platform-api-client.int.spec.ts`

**Interfaces:**

- `getPlatformAPIConfig(env)` validates URL/key without exposing the key.
- `requestUpstream<T>(request)` sets `x-api-key`, timeout, request ID and read-only retry.
- `redactExternalData(value)` recursively removes or masks credential fields.

- [ ] **Step 1: 写配置、重试和密钥泄漏失败测试**

Use an in-process HTTP server in `tests/int/platform-api-client.int.spec.ts` and assert:

```ts
expect(await requestCountForGet503Then200()).toBe(2)
expect(await requestCountForPost503()).toBe(1)
expect(JSON.stringify(result)).not.toContain('admin-secret-value')
expect(redactExternalData({ access_token: 'abc', email: 'a@example.com' })).toEqual({
  access_token: '[REDACTED]',
  email: 'a@example.com',
})
```

Run `pnpm vitest run --config ./vitest.config.mts tests/int/platform-api-client.int.spec.ts`.

Expected: FAIL because the phase-1 client only supports the connection probe, not typed business requests, retry or recursive redaction.

- [ ] **Step 2: 实现最小客户端**

Use this request boundary:

```ts
export type UpstreamRequest = {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE'
  path: string
  query?: URLSearchParams
  body?: unknown
  requestId: string
  idempotencyKey?: string
  signal?: AbortSignal
}

export async function requestUpstream<T>(request: UpstreamRequest): Promise<{
  data: T
  upstreamRequestId?: string
}>
```

Use native `fetch`, an `AbortController` timeout, `x-api-key`, `x-request-id`, JSON content type and `Idempotency-Key` only when provided. Do not add a new HTTP dependency.

- [ ] **Step 3: 验证并提交**

Run:

```bash
pnpm vitest run --config ./vitest.config.mts tests/int/platform-api-client.int.spec.ts
pnpm run lint
git add src/platform-api tests/int/platform-api-client.int.spec.ts
git commit -m "feat: add secure platform api upstream client"
```

Expected: retry, timeout, error mapping and secret-redaction tests pass.

### Task 2: 建立显式操作注册表和 Payload BFF 端点

**Files:**

- Create: `src/platform-api/operations.ts`
- Create: `src/platform-api/handler.ts`
- Create: `src/endpoints/platform.ts`
- Create: `tests/int/platform-bff.int.spec.ts`
- Modify: `src/payload.config.ts`

**Interfaces:**

- Operation key resolves to method, path builder, capability, mutation flag and sanitizer.
- Endpoint consumes authenticated `req.user`, path/query/body and emits the fixed envelope.

- [ ] **Step 1: 写 allowlist、鉴权和响应失败测试**

Assert an unauthenticated request is 401, publisher reading users is 403, operations admin succeeds, unknown operation is 404 without an upstream request, and upstream credentials are redacted.

Run `pnpm vitest run --config ./vitest.config.mts tests/int/platform-bff.int.spec.ts`.

Expected: FAIL because `/api/platform/v1/*` is absent.

- [ ] **Step 2: 实现第一批显式操作**

Create a registry with this type:

```ts
export type PlatformOperation = {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE'
  capability: Capability
  upstreamPath: (params: Record<string, string>) => string
  mutation: boolean
  idempotent?: boolean
  sanitizeBody?: (value: unknown) => unknown
}

export const platformOperations = {
  listUsers: {
    method: 'GET',
    capability: 'users:read',
    upstreamPath: () => '/admin/users',
    mutation: false,
  },
  getUser: {
    method: 'GET',
    capability: 'users:read',
    upstreamPath: ({ id }) => `/admin/users/${id}`,
    mutation: false,
  },
  createUser: {
    method: 'POST',
    capability: 'users:write',
    upstreamPath: () => '/admin/users',
    mutation: true,
  },
  updateUser: {
    method: 'PUT',
    capability: 'users:write',
    upstreamPath: ({ id }) => `/admin/users/${id}`,
    mutation: true,
  },
  updateUserBalance: {
    method: 'POST',
    capability: 'users:balance:update',
    upstreamPath: ({ id }) => `/admin/users/${id}/balance`,
    mutation: true,
  },
  listAccounts: {
    method: 'GET',
    capability: 'ai-resources:read',
    upstreamPath: () => '/admin/accounts',
    mutation: false,
  },
  testAccount: {
    method: 'POST',
    capability: 'ai-resources:write',
    upstreamPath: ({ id }) => `/admin/accounts/${id}/test`,
    mutation: true,
  },
  listGroups: {
    method: 'GET',
    capability: 'ai-resources:read',
    upstreamPath: () => '/admin/groups',
    mutation: false,
  },
  listProxies: {
    method: 'GET',
    capability: 'ai-resources:read',
    upstreamPath: () => '/admin/proxies',
    mutation: false,
  },
} satisfies Record<string, PlatformOperation>
```

Complete the registry for every path in the page table by reading `backend/internal/server/routes/admin.go`; preserve the business API's existing request bodies. Reject path params that do not match `/^[A-Za-z0-9_-]+$/`.

- [ ] **Step 3: 增加 BFF 端点和统一审计**

Expose explicit endpoint patterns under `/platform/v1`, resolve only registered operations, call `hasCapability`, sanitize input, call upstream, redact output, and invoke `appendAuditLog` for mutations. Generate `requestId` with `crypto.randomUUID()` when the caller did not provide a valid one.

- [ ] **Step 4: 验证并提交**

Run:

```bash
pnpm run generate:types
pnpm vitest run --config ./vitest.config.mts tests/int/platform-bff.int.spec.ts
pnpm run test:int
git add src/platform-api src/endpoints/platform.ts src/payload.config.ts src/payload-types.ts tests/int/platform-bff.int.spec.ts
git commit -m "feat: add allowlisted platform admin bff"
```

Expected: BFF contract, capability, audit and redaction tests pass.

### Task 3: 建立 Soybean Platform BFF 客户端和用户管理页

**Files:**

- Create: `admin-web/src/service/platform.ts`
- Create: `admin-web/src/service/platform.test.ts`
- Create: `admin-web/src/service/users.ts`
- Create: `admin-web/src/service/users.test.ts`
- Create: `admin-web/src/views/users/index.vue`
- Create: `admin-web/src/views/users/modules/user-detail-drawer.vue`
- Create: `admin-web/src/views/users/modules/balance-dialog.vue`
- Modify: `admin-web/src/router/elegant/routes.ts`
- Modify: `admin-web/src/router/elegant/imports.ts`

**Interfaces:**

- `callPlatform<T>(operation, options)` parses the fixed BFF envelope and preserves `requestId` in errors.
- User detail combines user, API Keys, usage, balance history, subscription summary, attributes and quotas; raw API Key values are never requested.

- [ ] **Step 1: 写统一 envelope 和用户动作失败测试**

Assert 503 maps to `backend-unavailable`, 403 maps to `forbidden`, request ID survives, pagination becomes `PayloadPage`, and balance mutation sends notes plus operation.

Run `pnpm --dir admin-web vitest run src/service/platform.test.ts src/service/users.test.ts`.

Expected: FAIL because services are absent.

- [ ] **Step 2: 实现服务和页面**

Use this client boundary:

```ts
export async function callPlatform<T>(
  operation: string,
  options: {
    method?: 'GET' | 'POST' | 'PUT' | 'DELETE'
    params?: Record<string, string | number | boolean>
    body?: unknown
    signal?: AbortSignal
  },
): Promise<{ data: T; meta: Record<string, unknown>; requestId: string }>
```

The page must provide server search/filter/sort/pagination, status toggle, create/edit, concurrency and RPM, balance adjustment with notes, and a detail drawer. Permanent delete is not shown in this phase.

- [ ] **Step 3: 生成路由、验证并提交**

Run:

```bash
pnpm --dir admin-web gen-route
pnpm --dir admin-web fmt
pnpm --dir admin-web vitest run src/service/platform.test.ts src/service/users.test.ts
pnpm --dir admin-web typecheck
git add admin-web/src
git commit -m "feat: add soybean platform user management"
```

Expected: user services and page compile with no direct `agentera-claw-api` URL.

### Task 4: 完成 AI 资源页面

**Files:**

- Create: `admin-web/src/service/ai-resources.ts`
- Create: `admin-web/src/service/ai-resources.test.ts`
- Create: `admin-web/src/views/ai-resources/groups/index.vue`
- Create: `admin-web/src/views/ai-resources/accounts/index.vue`
- Create: `admin-web/src/views/ai-resources/proxies/index.vue`
- Create: `admin-web/src/views/ai-resources/channels/index.vue`
- Create: `admin-web/src/views/ai-resources/monitoring/index.vue`
- Create: `admin-web/src/views/ai-resources/network/index.vue`
- Modify: `admin-web/src/router/elegant/routes.ts`
- Modify: `admin-web/src/router/elegant/imports.ts`

**Interfaces:**

- Reuse request and response field knowledge from `agentera-claw-api/frontend/src/api/admin/*.ts`; do not copy its Vue page components.
- Credential fields render masked values only; replacement secrets are write-only form fields.

- [ ] **Step 1: 写分页、动作和脱敏失败测试**

Cover groups, accounts, proxies, channels, monitors, scheduled tests, TLS profiles and error passthrough. Assert account test/refresh are POST, delete asks confirmation, and service never exposes `access_token`, `refresh_token`, `client_secret` or proxy password.

Run `pnpm --dir admin-web vitest run src/service/ai-resources.test.ts`.

Expected: FAIL because the service is absent.

- [ ] **Step 2: 实现六个合并页面**

Use tabs to keep the side menu small: groups include price/rate/RPM; accounts include OAuth/test/refresh/quota; monitoring includes task/template/history/scheduled test; network includes TLS/error rules. Each mutation must show the BFF request ID on failure.

- [ ] **Step 3: 生成路由、验证并提交**

Run:

```bash
pnpm --dir admin-web gen-route
pnpm --dir admin-web fmt
pnpm --dir admin-web test
pnpm --dir admin-web typecheck
git add admin-web/src
git commit -m "feat: add soybean ai resource administration"
```

Expected: all AI resource services and pages pass tests/typecheck.

### Task 5: 真实上游契约、E2E 和阶段验收

**Files:**

- Create: `tests/int/platform-api-contract.int.spec.ts`
- Create: `tests/e2e-soybean/api-core.e2e.spec.ts`
- Modify: `playwright.soybean.config.ts`

- [ ] **Step 1: 建立非生产 API fixture**

Start a disposable `agentera-claw-api` test instance or an HTTP fixture captured from its typed handlers. Assert every registered BFF operation uses an existing method/path and maps the actual pagination envelope; do not snapshot secrets.

Run `pnpm vitest run --config ./vitest.config.mts tests/int/platform-api-contract.int.spec.ts`.

Expected: PASS only when the adapter and real API agree.

- [ ] **Step 2: 增加代表性浏览器流程**

E2E must cover user list/detail/status/balance, group list/edit, account test, proxy list, auditor read-only, publisher 403, upstream unconfigured and upstream unavailable. Inspect browser requests and local storage for the absence of the API admin key.

Run `pnpm run test:e2e:admin -- tests/e2e-soybean/api-core.e2e.spec.ts`.

Expected: all flows pass against disposable data.

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
git add tests/int/platform-api-contract.int.spec.ts tests/e2e-soybean/api-core.e2e.spec.ts playwright.soybean.config.ts
git commit -m "test: verify platform api core integration"
```

Expected: user and AI resources are managed through real APIs; the completed recharge site remains unchanged.
