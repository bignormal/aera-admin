# AgentEra Platform Real Read Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Connect the existing Soybean + Payload BFF stack to real AgentEra API read resources, validate live response contracts, and prove the primary administration pages without fixtures.

**Architecture:** Keep AgentEra API as the business source of truth and Payload as the authenticated, redacting BFF. Add a machine-readable read-probe catalog, an opt-in live contract suite, and strict frontend response normalization; do not add duplicate business storage or new AgentEra API endpoints in this phase.

**Tech Stack:** Payload 3, TypeScript 5/6, Vue 3, Vitest 4, Playwright 1.58, Go/Gin AgentEra API, native `fetch`.

## Global Constraints

- `personal-dev` remains the frozen Soybean baseline; implementation stays on `codex/platform-backend-integration`.
- The browser never receives `AGENTERA_API_ADMIN_KEY`; only Payload reads it from server environment variables.
- AgentEra API remains the source of truth for users, AI resources, billing, operations, security, and system data.
- Payload does not persist a second copy of upstream business records.
- Read probes return only health metadata; they never return sampled business rows.
- Fixture-backed tests remain useful for errors and edge cases but do not count as live-integration evidence.
- No mutation or high-risk action is enabled in this phase.
- No `agentera-claw-api` source file changes are planned unless the live suite proves a specific upstream defect.

---

## Current Evidence

- `GET http://127.0.0.1:8080/health` returns `200 {"status":"ok"}`.
- Authenticated `GET /api/platform/v1/status` on Payload reports `agenteraAPI.status = "not_configured"` and `errorCode = "missing_configuration"`.
- `tests/int/platform-api-contract.int.spec.ts` proves every current BFF operation maps to a registered Go admin route.
- Baseline verification is green: Payload integration `83/83` and Soybean unit `52/52`.

This plan therefore starts with connection evidence and live contracts, not speculative endpoint development.

### Task 1: Add the machine-readable real-read probe catalog

**Files:**

- Create: `src/platform-api/read-probes.ts`
- Create: `tests/int/platform-read-probes.int.spec.ts`

**Interfaces:**

- Produces: `PlatformReadProbe`, `PlatformReadProbeKey`, and `platformReadProbes`.
- Consumes: `platformOperations` from `src/platform-api/operations.ts`.
- Later tasks use the catalog for live contract tests and readiness reporting.

- [x] **Step 1: Write the failing catalog contract test**

```ts
import { describe, expect, it } from 'vitest'

import { platformOperations } from '../../src/platform-api/operations'
import { platformReadProbes } from '../../src/platform-api/read-probes'

describe('platform real-read probe catalog', () => {
  it('covers every real administration read domain with a registered GET operation', () => {
    expect(platformReadProbes.map((probe) => probe.key)).toEqual([
      'users',
      'accounts',
      'groups',
      'proxies',
      'channels',
      'billing',
      'orders',
      'subscriptions',
      'operations',
      'alerts',
      'risk',
      'usage',
      'system',
    ])

    for (const probe of platformReadProbes) {
      const operation = platformOperations[probe.operation]
      expect(operation).toBeDefined()
      expect(operation.method).toBe('GET')
      expect(operation.mutation).toBe(false)
      expect(operation.params || []).toEqual([])
      expect(operation.upstreamPath({})).toMatch(/^\/admin\//)
    }
  })
})
```

- [x] **Step 2: Run the test and verify RED**

Run:

```bash
pnpm vitest run --config ./vitest.config.mts tests/int/platform-read-probes.int.spec.ts
```

Expected: FAIL because `src/platform-api/read-probes.ts` does not exist.

- [x] **Step 3: Implement the probe catalog**

```ts
import type { platformOperations } from './operations'

export type PlatformReadProbeKey =
  | 'accounts'
  | 'alerts'
  | 'billing'
  | 'channels'
  | 'groups'
  | 'operations'
  | 'orders'
  | 'proxies'
  | 'risk'
  | 'subscriptions'
  | 'system'
  | 'usage'
  | 'users'

export type PlatformReadProbe = {
  key: PlatformReadProbeKey
  label: string
  operation: keyof typeof platformOperations
  query?: Readonly<Record<string, string>>
  shape: 'array' | 'page' | 'record'
}

export const platformReadProbes: readonly PlatformReadProbe[] = [
  {
    key: 'users',
    label: '平台用户',
    operation: 'listUsers',
    query: { page: '1', page_size: '1' },
    shape: 'page',
  },
  {
    key: 'accounts',
    label: 'AI 账号',
    operation: 'listAccounts',
    query: { page: '1', page_size: '1' },
    shape: 'page',
  },
  {
    key: 'groups',
    label: '资源分组',
    operation: 'listGroups',
    query: { page: '1', page_size: '1' },
    shape: 'page',
  },
  {
    key: 'proxies',
    label: '代理资源',
    operation: 'listProxies',
    query: { page: '1', page_size: '1' },
    shape: 'page',
  },
  {
    key: 'channels',
    label: '模型渠道',
    operation: 'listChannels',
    query: { page: '1', page_size: '1' },
    shape: 'page',
  },
  { key: 'billing', label: '商业总览', operation: 'getPaymentDashboard', shape: 'record' },
  {
    key: 'orders',
    label: '支付订单',
    operation: 'listPaymentOrders',
    query: { page: '1', page_size: '1' },
    shape: 'page',
  },
  {
    key: 'subscriptions',
    label: '订阅',
    operation: 'listSubscriptions',
    query: { page: '1', page_size: '1' },
    shape: 'page',
  },
  { key: 'operations', label: '运营总览', operation: 'getOpsDashboardOverview', shape: 'record' },
  {
    key: 'alerts',
    label: '告警事件',
    operation: 'listAlertEvents',
    query: { limit: '1' },
    shape: 'array',
  },
  { key: 'risk', label: '风险状态', operation: 'getRiskStatus', shape: 'record' },
  {
    key: 'usage',
    label: '用量日志',
    operation: 'listUsage',
    query: { page: '1', page_size: '1' },
    shape: 'page',
  },
  { key: 'system', label: '系统版本', operation: 'getSystemVersion', shape: 'record' },
] as const
```

- [x] **Step 4: Run the focused and contract tests**

Run:

```bash
pnpm vitest run --config ./vitest.config.mts \
  tests/int/platform-read-probes.int.spec.ts \
  tests/int/platform-api-contract.int.spec.ts
```

Expected: 2 files PASS and no operation points outside `/admin`.

- [x] **Step 5: Commit**

```bash
git add src/platform-api/read-probes.ts tests/int/platform-read-probes.int.spec.ts
git commit -m "test: catalog real platform read probes"
```

### Task 2: Add an explicit live AgentEra API contract suite

**Files:**

- Create: `vitest.live.config.mts`
- Create: `tests/live/platform-read.live.spec.ts`
- Modify: `package.json`

**Interfaces:**

- Consumes: `platformReadProbes`, `platformOperations`, and `requestUpstream`.
- Produces: `pnpm run test:live:platform`.
- Requires runtime-only `AGENTERA_API_URL` and `AGENTERA_API_ADMIN_KEY`; neither value is committed.

- [x] **Step 1: Write the live test before adding its configuration**

```ts
import { describe, expect, it } from 'vitest'

import { requestUpstream } from '../../src/platform-api/client'
import { platformOperations } from '../../src/platform-api/operations'
import { platformReadProbes } from '../../src/platform-api/read-probes'

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

describe('live AgentEra API read contracts', () => {
  for (const probe of platformReadProbes) {
    it(`${probe.key} returns the real success envelope and expected shape`, async () => {
      const operation = platformOperations[probe.operation]
      const result = await requestUpstream<unknown>({
        method: 'GET',
        path: operation.upstreamPath({}),
        query: new URLSearchParams(probe.query),
        requestId: `live-${probe.key}`,
      })

      expect(record(result.data)).toBe(true)
      const envelope = result.data as Record<string, unknown>
      expect(envelope.code).toBe(0)
      expect(envelope).toHaveProperty('data')

      if (probe.shape === 'array') {
        expect(Array.isArray(envelope.data)).toBe(true)
      } else if (probe.shape === 'page') {
        expect(record(envelope.data)).toBe(true)
        expect(Array.isArray((envelope.data as Record<string, unknown>).items)).toBe(true)
      } else {
        expect(record(envelope.data)).toBe(true)
      }
    })
  }
})
```

- [x] **Step 2: Add the isolated live Vitest config**

```ts
import { defineConfig } from 'vitest/config'

if (!process.env.AGENTERA_API_URL || !process.env.AGENTERA_API_ADMIN_KEY) {
  throw new Error('Live platform tests require AGENTERA_API_URL and AGENTERA_API_ADMIN_KEY')
}

export default defineConfig({
  test: {
    environment: 'node',
    fileParallelism: false,
    include: ['tests/live/**/*.live.spec.ts'],
    pool: 'forks',
    sequence: { concurrent: false },
  },
})
```

- [x] **Step 3: Register the explicit script**

Add to `package.json` scripts:

```json
"test:live:platform": "cross-env NODE_OPTIONS=--no-deprecation vitest run --config ./vitest.live.config.mts"
```

- [x] **Step 4: Prove missing credentials fail clearly**

Run:

```bash
env -u AGENTERA_API_URL -u AGENTERA_API_ADMIN_KEY pnpm run test:live:platform
```

Expected: FAIL before tests with `Live platform tests require AGENTERA_API_URL and AGENTERA_API_ADMIN_KEY`.

- [x] **Step 5: Run against the local real API**

Export the existing key from the local secret store in the current shell, then run:

```bash
test -n "$AGENTERA_API_ADMIN_KEY"
AGENTERA_API_URL=http://127.0.0.1:8080 pnpm run test:live:platform
```

Expected: 13 live tests PASS. Any route or response-shape failure becomes a narrowly scoped upstream defect before continuing.

- [x] **Step 6: Commit**

```bash
git add vitest.live.config.mts tests/live/platform-read.live.spec.ts package.json
git commit -m "test: verify live platform read contracts"
```

### Task 3: Add strict shared upstream response parsing

**Files:**

- Create: `admin-web/src/service/upstream-contract.ts`
- Create: `admin-web/src/service/upstream-contract.test.ts`

**Interfaces:**

- Produces: `ContractError`, `unwrapUpstream`, `normalizeUpstreamPage`, `asResourceRecord`.
- Consumed by user, AI-resource, billing, and operations services in later tasks.

- [x] **Step 1: Write failing parser tests**

```ts
import { describe, expect, it } from 'vitest'
import {
  ContractError,
  asResourceRecord,
  normalizeUpstreamPage,
  unwrapUpstream,
} from './upstream-contract'

describe('upstream contract parsing', () => {
  it('unwraps a success envelope and rejects malformed or failed envelopes', () => {
    expect(unwrapUpstream({ code: 0, data: { id: 1 }, message: 'success' })).toEqual({ id: 1 })
    expect(() => unwrapUpstream({ code: 500, data: null, message: 'failed' })).toThrow(
      ContractError,
    )
    expect(() => unwrapUpstream({ data: [] })).toThrow(ContractError)
  })

  it('normalizes a real page and rejects non-array items', () => {
    expect(
      normalizeUpstreamPage(
        { items: [{ id: 1 }], page: 2, page_size: 10, pages: 3, total: 21 },
        { page: 2, limit: 10 },
        asResourceRecord,
      ),
    ).toMatchObject({ docs: [{ id: 1 }], page: 2, limit: 10, totalDocs: 21, totalPages: 3 })

    expect(() =>
      normalizeUpstreamPage({ items: null }, { page: 1, limit: 10 }, asResourceRecord),
    ).toThrow(ContractError)
  })
})
```

- [x] **Step 2: Run and verify RED**

Run:

```bash
pnpm --dir admin-web test src/service/upstream-contract.test.ts
```

Expected: FAIL because the module does not exist.

- [x] **Step 3: Implement the minimal parser**

```ts
import type { PayloadPage } from './resources'

export class ContractError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ContractError'
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

export function asResourceRecord(value: unknown): Record<string, unknown> {
  if (!record(value) || !['number', 'string'].includes(typeof value.id)) {
    throw new ContractError('AgentEra API 资源缺少合法 id')
  }
  return value
}

export function unwrapUpstream(value: unknown): unknown {
  if (!record(value) || typeof value.code !== 'number' || !('data' in value)) {
    throw new ContractError('AgentEra API 响应格式不合法')
  }
  if (value.code !== 0) {
    throw new ContractError(
      typeof value.message === 'string' ? value.message : 'AgentEra API 返回异常',
    )
  }
  return value.data
}

export function normalizeUpstreamPage<T>(
  value: unknown,
  query: { limit: number; page: number },
  parseItem: (item: unknown) => T,
): PayloadPage<T> {
  if (!record(value) || !Array.isArray(value.items)) {
    throw new ContractError('AgentEra API 分页格式不合法')
  }
  const page = typeof value.page === 'number' ? value.page : query.page
  const limit = typeof value.page_size === 'number' ? value.page_size : query.limit
  const totalDocs = typeof value.total === 'number' ? value.total : value.items.length
  const totalPages =
    typeof value.pages === 'number' ? value.pages : Math.max(1, Math.ceil(totalDocs / limit))
  return {
    docs: value.items.map(parseItem),
    hasNextPage: page < totalPages,
    hasPrevPage: page > 1,
    limit,
    page,
    totalDocs,
    totalPages,
  }
}
```

- [x] **Step 4: Run focused tests and typecheck**

Run:

```bash
pnpm --dir admin-web test src/service/upstream-contract.test.ts
pnpm --dir admin-web typecheck
```

Expected: parser tests PASS and `vue-tsc` exits 0.

- [x] **Step 5: Commit**

```bash
git add admin-web/src/service/upstream-contract.ts admin-web/src/service/upstream-contract.test.ts
git commit -m "feat: validate upstream response contracts"
```

### Task 4: Convert platform-user reads to the strict real contract

**Files:**

- Modify: `admin-web/src/service/users.ts`
- Modify: `admin-web/src/service/users.test.ts`

**Interfaces:**

- Consumes: `unwrapUpstream` and `normalizeUpstreamPage`.
- Produces: validated `PlatformUser`, `PayloadPage<PlatformUser>`, and typed user detail sections.

- [x] **Step 1: Add malformed-response and real-page tests**

Extend `admin-web/src/service/users.test.ts` with:

```ts
it('parses the real user page and rejects malformed users', async () => {
  vi.mocked(callPlatform)
    .mockResolvedValueOnce({
      data: {
        code: 0,
        data: {
          items: [{ id: 1, email: 'member@example.com', role: 'user', status: 'active' }],
          page: 1,
          page_size: 20,
          pages: 1,
          total: 1,
        },
        message: 'success',
      },
      meta: {},
      requestId: 'users-live-shape',
    })
    .mockResolvedValueOnce({
      data: { code: 0, data: { items: [{ email: 'missing-id' }] }, message: 'success' },
      meta: {},
      requestId: 'users-invalid-shape',
    })

  await expect(listUsers({ page: 1, pageSize: 20 })).resolves.toMatchObject({ totalDocs: 1 })
  await expect(listUsers({ page: 1, pageSize: 20 })).rejects.toThrow('资源缺少合法 id')
})
```

- [x] **Step 2: Run and verify RED**

Run:

```bash
pnpm --dir admin-web test src/service/users.test.ts
```

Expected: the malformed user currently passes through instead of throwing.

- [x] **Step 3: Replace local envelope/page parsing with the shared parser**

In `admin-web/src/service/users.ts`:

```ts
import {
  ContractError,
  asResourceRecord,
  normalizeUpstreamPage,
  unwrapUpstream,
} from './upstream-contract'

function parsePlatformUser(value: unknown): PlatformUser {
  const user = asResourceRecord(value)
  if (
    typeof user.email !== 'string' ||
    !['admin', 'user'].includes(String(user.role)) ||
    !['active', 'disabled'].includes(String(user.status))
  ) {
    throw new ContractError('AgentEra API 用户格式不合法')
  }
  return user as PlatformUser
}

// listUsers:
return normalizeUpstreamPage(
  unwrapUpstream(result.data),
  { page: query.page, limit: query.pageSize },
  parsePlatformUser,
)

// getUser/createUser/updateUser/updateUserBalance:
return parsePlatformUser(unwrapUpstream(result.data))
```

- [x] **Step 4: Run user tests, all frontend tests, and typecheck**

Run:

```bash
pnpm --dir admin-web test src/service/users.test.ts
pnpm --dir admin-web test
pnpm --dir admin-web typecheck
```

Expected: user tests and the complete Soybean suite PASS.

- [x] **Step 5: Commit**

```bash
git add admin-web/src/service/users.ts admin-web/src/service/users.test.ts
git commit -m "feat: validate real platform user reads"
```

### Task 5: Convert AI-resource reads to the strict real contract

**Files:**

- Modify: `admin-web/src/service/ai-resources.ts`
- Modify: `admin-web/src/service/ai-resources.test.ts`

**Interfaces:**

- Consumes: shared upstream parsing.
- Produces: strict declared list contracts: paginated accounts, groups, proxies, channels, monitors, and monitor templates; array-based TLS profiles and error rules.

- [x] **Step 1: Add a real page matrix and malformed-item tests**

Add to `admin-web/src/service/ai-resources.test.ts`:

```ts
it.each(['accounts', 'groups', 'proxies', 'channels'] as const)(
  'parses the real %s page shape',
  async (kind) => {
    vi.mocked(callPlatform).mockResolvedValueOnce({
      data: {
        code: 0,
        data: { items: [{ id: 1, name: `${kind}-1` }], page: 1, page_size: 10, pages: 1, total: 1 },
        message: 'success',
      },
      meta: {},
      requestId: `live-${kind}`,
    })
    await expect(listAIResources(kind, { page: 1, limit: 10 })).resolves.toMatchObject({
      totalDocs: 1,
    })
  },
)

it('rejects an AI resource without an id', async () => {
  vi.mocked(callPlatform).mockResolvedValueOnce({
    data: { code: 0, data: { items: [{ name: 'invalid' }] }, message: 'success' },
    meta: {},
    requestId: 'invalid-ai-resource',
  })
  await expect(listAIResources('accounts', { page: 1, limit: 10 })).rejects.toThrow(
    '资源缺少合法 id',
  )
})
```

- [x] **Step 2: Run and verify RED**

Run:

```bash
pnpm --dir admin-web test src/service/ai-resources.test.ts
```

Expected: the missing-ID case does not throw.

- [x] **Step 3: Replace permissive page handling**

Use `unwrapUpstream`, `normalizeUpstreamPage`, `normalizeUpstreamArray`, and `asResourceRecord`. Keep client-side sanitization as defense in depth, but treat the Payload BFF redaction as authoritative. Accept a top-level array only for the explicitly declared TLS profile and error-rule routes; paginated routes must expose an `items` array.

- [x] **Step 4: Run focused tests, full frontend tests, typecheck, and build**

Run:

```bash
pnpm --dir admin-web test src/service/ai-resources.test.ts
pnpm --dir admin-web test
pnpm --dir admin-web typecheck
pnpm --dir admin-web build
```

Expected: all commands exit 0.

- [x] **Step 5: Commit**

```bash
git add admin-web/src/service/ai-resources.ts admin-web/src/service/ai-resources.test.ts
git commit -m "feat: validate real AI resource reads"
```

### Task 6: Convert commerce, operations, risk, and system reads

**Files:**

- Modify: `admin-web/src/service/billing.ts`
- Modify: `admin-web/src/service/billing.test.ts`
- Modify: `admin-web/src/service/operations.ts`
- Modify: `admin-web/src/service/operations.test.ts`

**Interfaces:**

- Consumes: shared upstream parsing.
- Produces: strict page/record contracts for the remaining AgentEra API-backed read pages.

- [x] **Step 1: Add read-contract tests for both page and record responses**

For `billing.test.ts`, add real page tests for orders and subscriptions, array tests for plans and providers, plus record tests for the payment dashboard. For `operations.test.ts`, add array tests for alert events/rules, page tests for usage, and record tests for operations overview, risk status, and system settings.

Use these exact malformed cases:

```ts
// billing.test.ts
vi.mocked(callPlatform).mockResolvedValueOnce({
  data: { code: 0, data: { items: 'not-an-array' }, message: 'success' },
  meta: {},
  requestId: 'invalid-page',
})
await expect(listBillingResources('orders', { page: 1, limit: 10 })).rejects.toThrow(
  '分页格式不合法',
)

// operations.test.ts
vi.mocked(callPlatform).mockResolvedValueOnce({
  data: { code: 0, data: { items: 'not-an-array' }, message: 'success' },
  meta: {},
  requestId: 'invalid-page',
})
await expect(listOperationalResources('usage', { page: 1, limit: 10 })).rejects.toThrow(
  '分页格式不合法',
)
```

- [x] **Step 2: Run and verify RED**

Run:

```bash
pnpm --dir admin-web test src/service/billing.test.ts src/service/operations.test.ts
```

Expected: at least the malformed-page assertions FAIL because the current services accept permissive values.

- [x] **Step 3: Implement strict parsing and explicit empty states**

Replace each local `unwrap`/`page` implementation with shared parsing. Record endpoints must require a non-array object; page endpoints must require `items`. Keep diagnostic redaction for error summaries and cap displayed error text at 500 characters.

- [x] **Step 4: Run focused and complete frontend verification**

Run:

```bash
pnpm --dir admin-web test src/service/billing.test.ts src/service/operations.test.ts
pnpm --dir admin-web test
pnpm --dir admin-web typecheck
pnpm --dir admin-web build
```

Expected: tests, typecheck, and production build PASS.

- [x] **Step 5: Commit**

```bash
git add admin-web/src/service/billing.ts admin-web/src/service/billing.test.ts \
  admin-web/src/service/operations.ts admin-web/src/service/operations.test.ts
git commit -m "feat: validate real commerce and operations reads"
```

### Task 7: Expose domain readiness without returning sampled data

**Files:**

- Create: `src/endpoints/platform-readiness.ts`
- Create: `tests/int/platform-readiness.int.spec.ts`
- Modify: `src/payload.config.ts`
- Modify: `admin-web/src/service/platform.ts`
- Modify: `admin-web/src/service/platform.test.ts`
- Modify: `admin-web/src/views/home/index.vue`

**Interfaces:**

- Produces: authenticated `GET /api/platform/v1/readiness`.
- Response: `{ data: { domains: Array<{ key, label, status, latencyMs, errorCode? }> }, meta: { generatedAt }, requestId }`.
- The endpoint reports only probe metadata and discards response bodies.

- [x] **Step 1: Write endpoint failure and redaction tests**

```ts
it('reports per-domain health without exposing sampled data or credentials', async () => {
  const upstream = vi.fn().mockResolvedValue({
    data: { code: 0, data: { items: [{ email: 'private@example.com' }] }, message: 'success' },
  })
  const response = await createPlatformReadinessHandler(upstream)({
    headers: new Headers(),
    user: { id: 1, email: 'admin@agentera.local', role: 'super_admin' },
  } as never)
  const text = await response.text()
  expect(response.status).toBe(200)
  expect(text).not.toContain('private@example.com')
  expect(JSON.parse(text).data.domains).toHaveLength(13)
})
```

Also assert anonymous is 401, non-`super_admin` is 403, one failed probe does not hide other results, and no response contains `AGENTERA_API_ADMIN_KEY`.

- [x] **Step 2: Run and verify RED**

Run:

```bash
pnpm vitest run --config ./vitest.config.mts tests/int/platform-readiness.int.spec.ts
```

Expected: FAIL because the handler does not exist.

- [x] **Step 3: Implement bounded probe execution**

Implement `createPlatformReadinessHandler(upstream = requestUpstream)` with at most four concurrent requests. For each catalog entry, call only its registered GET path/query, measure elapsed time, discard `result.data`, and return `healthy` or `unavailable` with the normalized `PlatformAPIError.code`.

Register:

```ts
export const platformReadinessEndpoint: Endpoint = {
  path: '/platform/v1/readiness',
  method: 'get',
  handler: createPlatformReadinessHandler(),
}
```

Add it to `src/payload.config.ts` immediately after `platformStatusEndpoint`.

- [x] **Step 4: Add the Soybean service and dashboard matrix**

In `admin-web/src/service/platform.ts`:

```ts
export type PlatformDomainReadiness = {
  errorCode?: string
  key: string
  label: string
  latencyMs: number
  status: 'healthy' | 'unavailable'
}

export function getPlatformReadiness(signal?: AbortSignal) {
  return apiRequest<{
    data: { domains: PlatformDomainReadiness[] }
    meta: { generatedAt: string }
    requestId: string
  }>('/platform/v1/readiness', { signal })
}
```

On the home page, add a super-admin-only “验证真实资源” button and a compact readiness table. Do not call this endpoint automatically on every page load.

- [x] **Step 5: Run backend and frontend verification**

Run:

```bash
pnpm vitest run --config ./vitest.config.mts tests/int/platform-readiness.int.spec.ts
pnpm --dir admin-web test src/service/platform.test.ts
pnpm run test:int
pnpm --dir admin-web test
pnpm --dir admin-web typecheck
```

Expected: Payload `84+` tests and Soybean `53+` tests PASS.

- [x] **Step 6: Commit**

```bash
git add src/endpoints/platform-readiness.ts src/payload.config.ts \
  tests/int/platform-readiness.int.spec.ts admin-web/src/service/platform.ts \
  admin-web/src/service/platform.test.ts admin-web/src/views/home/index.vue
git commit -m "feat: report real platform resource readiness"
```

### Task 8: Add fixture-free browser acceptance and record the real result

**Files:**

- Create: `playwright.platform-live.config.ts`
- Create: `tests/e2e-live/platform-read.e2e.spec.ts`
- Create: `docs/verification/platform-live-read.md`
- Modify: `package.json`
- Modify: `docs/operations/platform-admin-runbook.md`

**Interfaces:**

- Produces: `pnpm run test:e2e:live:platform`.
- Runtime-only inputs: `AGENTERA_ADMIN_LIVE_URL`, `AGENTERA_ADMIN_LIVE_EMAIL`, `AGENTERA_ADMIN_LIVE_PASSWORD`.
- The suite never intercepts `/api/platform/v1/*` and never performs mutations.

- [x] **Step 1: Write the fixture-free browser test**

```ts
import { expect, test } from '@playwright/test'

const email = process.env.AGENTERA_ADMIN_LIVE_EMAIL
const password = process.env.AGENTERA_ADMIN_LIVE_PASSWORD
if (!email || !password) throw new Error('Live browser tests require admin live credentials')

test('reads real platform domains through Soybean and Payload', async ({ page }) => {
  await page.goto('/admin/login')
  await page.getByTestId('admin-email').fill(email)
  await page.getByTestId('admin-password').fill(password)
  await page.getByRole('button', { name: '登录', exact: true }).click()
  await expect(page).toHaveURL(/\/admin\/home/)
  await expect(page.getByText('健康', { exact: true })).toBeVisible()

  const pages = [
    ['/admin/users', '平台用户'],
    ['/admin/ai-resources/accounts', '上游账号'],
    ['/admin/ai-resources/groups', '模型分组'],
    ['/admin/billing/orders', '订单中心'],
    ['/admin/operations/overview', '运营总览'],
    ['/admin/security/risk', '风控中心'],
    ['/admin/system/settings', '系统设置'],
  ] as const

  for (const [path, heading] of pages) {
    await page.goto(path)
    await expect(page.getByRole('heading', { name: heading, exact: true })).toBeVisible()
    await expect(page.getByText('AgentEra API 管理服务暂时无法完成该操作。')).toHaveCount(0)
  }
})
```

- [x] **Step 2: Add the live Playwright config**

```ts
import { defineConfig, devices } from '@playwright/test'

export default defineConfig({
  testDir: './tests/e2e-live',
  workers: 1,
  retries: 0,
  use: {
    baseURL: process.env.AGENTERA_ADMIN_LIVE_URL || 'http://127.0.0.1:9527',
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chrome', use: { ...devices['Desktop Chrome'], channel: 'chrome' } }],
})
```

Register:

```json
"test:e2e:live:platform": "cross-env NODE_OPTIONS=--no-deprecation playwright test --config=playwright.platform-live.config.ts"
```

- [x] **Step 3: Run with the real local stack**

Start Payload with `AGENTERA_API_URL=http://127.0.0.1:8080` and the existing admin key injected. Export the local test credentials from the secret store, then run:

```bash
test -n "$AGENTERA_ADMIN_LIVE_EMAIL"
test -n "$AGENTERA_ADMIN_LIVE_PASSWORD"
AGENTERA_ADMIN_LIVE_URL=http://127.0.0.1:9527 pnpm run test:e2e:live:platform
```

Expected: fixture-free browser test PASS; network logs show real Payload BFF requests and no intercepted platform route.

- [x] **Step 4: Record actual evidence, not expected evidence**

Write `docs/verification/platform-live-read.md` with:

- Admin SHA and API SHA;
- local service URLs without credentials;
- exact commands and pass/fail counts;
- per-domain readiness result;
- any domain excluded and the concrete reason;
- statement that no mutation was executed.

Update the runbook to reference the live commands. Do not mark Phase 1 complete if any planned domain is unavailable.

- [x] **Step 5: Run the complete phase gate**

Run:

```bash
pnpm run test:int
pnpm --dir admin-web test
pnpm --dir admin-web typecheck
pnpm --dir admin-web build
pnpm run test:live:platform
pnpm run test:e2e:live:platform
git diff --check
```

Expected: all commands PASS with the real API configured.

- [x] **Step 6: Commit**

```bash
git add playwright.platform-live.config.ts tests/e2e-live/platform-read.e2e.spec.ts \
  docs/verification/platform-live-read.md docs/operations/platform-admin-runbook.md package.json
git commit -m "test: verify fixture-free platform reads"
```

## Phase Boundary

This plan intentionally ends after read integration. The following work receives separate plans only after the live read gate is green:

1. ordinary real mutations with audit and idempotency;
2. one-time reauthentication for high-risk actions;
3. audit integrity/export and large-volume capacity testing;
4. any proven `agentera-claw-api` endpoint defect.
