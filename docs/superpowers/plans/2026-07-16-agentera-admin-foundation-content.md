# AgentEra 后台基础与内容生态 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把现有 Payload 内容能力和新插件/宠物目录完整搬到 Soybean 正式后台，并建立五角色 capability、统一审计和可复用页面骨架。

**Architecture:** Payload 标准 REST 继续承载自有集合；Collection access 在服务端使用固定 capability，hooks 将写操作追加到 `audit-logs`；Soybean 使用统一 `http.ts`、列表页、详情抽屉和编辑弹窗模式，不经过额外 BFF 复制 Payload 数据。

**Tech Stack:** Payload 3、Next.js 16、SQLite、Vue 3、Naive UI、TypeScript、Vitest、Playwright。

## Global Constraints

- 只管理 Payload 自有数据；本阶段对 `agentera-claw-api` 仅做只读连接探测，不调用业务管理接口。
- `audit-logs` 只允许系统追加，任何管理员都不能通过 REST 创建、修改或删除。
- 菜单与按钮隐藏只是体验优化；Collection access 必须独立阻止越权。
- 不引入动态角色编辑器、状态管理框架替换、共享 contracts 包或第二套 UI 组件库。
- 插件和宠物集合只保存发布索引与制品引用，不复制 Runtime 源码或用户安装状态。
- 首页只能显示真实集合统计与连接状态；没有数据时显示 0 或空态，不生成演示值。

---

## 页面、数据源与 capability

| Soybean 页面 | 数据源              | 读取                      | 修改                                                |
| ------------ | ------------------- | ------------------------- | --------------------------------------------------- |
| 平台总览     | Payload collections | `dashboard:read`          | 无                                                  |
| 官方智能体   | `agent-templates`   | `content:agents:read`     | `content:agents:write` / `content:agents:publish`   |
| 智能体分类   | `expert-categories` | `content:categories:read` | `content:categories:write`                          |
| 技能目录     | `skill-catalog`     | `content:skills:read`     | `content:skills:write` / `content:skills:publish`   |
| 插件目录     | `plugin-catalog`    | `content:plugins:read`    | `content:plugins:write` / `content:plugins:publish` |
| 媒体资源     | `media`             | `content:media:read`      | `content:media:write`                               |
| 宠物资源     | `pet-assets`        | `content:pets:read`       | `content:pets:write` / `content:pets:publish`       |
| 发布中心     | 上述版本化集合      | `content:publish:read`    | `content:publish:execute`                           |
| 管理员       | `admins`            | `admins:read`             | `admins:write`                                      |

### Task 1: 固定五角色 capability 并迁移管理员字段

**Files:**

- Create: `src/access/capabilities.ts`
- Modify: `src/access/adminAccess.ts`
- Modify: `src/collections/Admins.ts`
- Modify: `tests/int/admin-access.int.spec.ts`
- Modify: `tests/helpers/seedUser.ts`

**Interfaces:**

- Produces: `AdminRole`, `Capability`, `hasCapability()`, `requireCapability()`。
- Migration rule: 现有 `super_admin`、`publisher` 值保持不变；新增角色只是 select 选项，不重写旧数据。

- [ ] **Step 1: 先写角色矩阵失败测试**

Add these assertions to `tests/int/admin-access.int.spec.ts`:

```ts
expect(hasCapability('super_admin', 'system:backup:restore')).toBe(true)
expect(hasCapability('publisher', 'content:agents:publish')).toBe(true)
expect(hasCapability('publisher', 'billing:order:refund')).toBe(false)
expect(hasCapability('finance_admin', 'billing:order:refund')).toBe(true)
expect(hasCapability('auditor', 'audit:read')).toBe(true)
expect(hasCapability('auditor', 'users:balance:update')).toBe(false)
```

Run `pnpm vitest run --config ./vitest.config.mts tests/int/admin-access.int.spec.ts`.

Expected: FAIL because `hasCapability` and the three new roles do not exist.

- [ ] **Step 2: 增加固定类型和映射**

Create `src/access/capabilities.ts` with these public declarations and a literal role map:

```ts
export const adminRoles = [
  'super_admin',
  'operations_admin',
  'publisher',
  'finance_admin',
  'auditor',
] as const
export type AdminRole = (typeof adminRoles)[number]

export type Capability =
  | 'dashboard:read'
  | 'admins:read'
  | 'admins:write'
  | 'content:agents:read'
  | 'content:agents:write'
  | 'content:agents:publish'
  | 'content:categories:read'
  | 'content:categories:write'
  | 'content:skills:read'
  | 'content:skills:write'
  | 'content:skills:publish'
  | 'content:plugins:read'
  | 'content:plugins:write'
  | 'content:plugins:publish'
  | 'content:media:read'
  | 'content:media:write'
  | 'content:pets:read'
  | 'content:pets:write'
  | 'content:pets:publish'
  | 'content:publish:read'
  | 'content:publish:execute'
  | 'users:read'
  | 'users:write'
  | 'users:balance:update'
  | 'ai-resources:read'
  | 'ai-resources:write'
  | 'billing:read'
  | 'billing:write'
  | 'billing:order:refund'
  | 'operations:read'
  | 'operations:write'
  | 'runtime:read'
  | 'runtime:command:create'
  | 'tenants:read'
  | 'tenants:write'
  | 'audit:read'
  | 'system:read'
  | 'system:write'
  | 'system:backup:restore'

export const roleCapabilities: Record<AdminRole, readonly Capability[]> = {
  super_admin: [
    'dashboard:read',
    'admins:read',
    'admins:write',
    'content:agents:read',
    'content:agents:write',
    'content:agents:publish',
    'content:categories:read',
    'content:categories:write',
    'content:skills:read',
    'content:skills:write',
    'content:skills:publish',
    'content:plugins:read',
    'content:plugins:write',
    'content:plugins:publish',
    'content:media:read',
    'content:media:write',
    'content:pets:read',
    'content:pets:write',
    'content:pets:publish',
    'content:publish:read',
    'content:publish:execute',
    'users:read',
    'users:write',
    'users:balance:update',
    'ai-resources:read',
    'ai-resources:write',
    'billing:read',
    'billing:write',
    'billing:order:refund',
    'operations:read',
    'operations:write',
    'runtime:read',
    'runtime:command:create',
    'tenants:read',
    'tenants:write',
    'audit:read',
    'system:read',
    'system:write',
    'system:backup:restore',
  ],
  operations_admin: [
    'dashboard:read',
    'users:read',
    'users:write',
    'users:balance:update',
    'ai-resources:read',
    'ai-resources:write',
    'billing:read',
    'operations:read',
    'operations:write',
    'runtime:read',
    'runtime:command:create',
    'tenants:read',
    'tenants:write',
    'audit:read',
    'system:read',
  ],
  publisher: [
    'dashboard:read',
    'content:agents:read',
    'content:agents:write',
    'content:agents:publish',
    'content:categories:read',
    'content:categories:write',
    'content:skills:read',
    'content:skills:write',
    'content:skills:publish',
    'content:plugins:read',
    'content:plugins:write',
    'content:plugins:publish',
    'content:media:read',
    'content:media:write',
    'content:pets:read',
    'content:pets:write',
    'content:pets:publish',
    'content:publish:read',
    'content:publish:execute',
  ],
  finance_admin: [
    'dashboard:read',
    'users:read',
    'billing:read',
    'billing:write',
    'billing:order:refund',
    'audit:read',
  ],
  auditor: [
    'dashboard:read',
    'users:read',
    'ai-resources:read',
    'billing:read',
    'operations:read',
    'runtime:read',
    'tenants:read',
    'audit:read',
    'system:read',
  ],
}

export function hasCapability(role: AdminRole | undefined, capability: Capability): boolean {
  return role ? roleCapabilities[role].includes(capability) : false
}
```

Modify `Admins.ts` so the select contains all five code values and labels. Modify `adminAccess.ts` to derive `AdminRole` from this file and expose a Payload `Access` factory that calls `hasCapability`.

- [ ] **Step 3: 验证并提交**

Run:

```bash
pnpm run generate:types
pnpm vitest run --config ./vitest.config.mts tests/int/admin-access.int.spec.ts
git add src/access src/collections/Admins.ts src/payload-types.ts tests/int/admin-access.int.spec.ts tests/helpers/seedUser.ts
git commit -m "feat: add fixed platform admin capabilities"
```

Expected: 测试通过，生成的 `Admin.role` 包含五个角色。

### Task 2: 增加只追加的审计集合和内容 hooks

**Files:**

- Create: `src/collections/AuditLogs.ts`
- Create: `src/domain/audit.ts`
- Create: `tests/int/audit-logs.int.spec.ts`
- Modify: `src/payload.config.ts`
- Modify: `src/collections/AgentTemplates.ts`
- Modify: `src/collections/ExpertCategories.ts`
- Modify: `src/collections/SkillCatalog.ts`
- Modify: `src/collections/Media.ts`
- Modify: `src/collections/Admins.ts`

**Interfaces:**

- Produces: `appendAuditLog(req, event)` and `createAuditHooks(resourceType)`.
- Stores: actor, role, capability, action, resourceType, resourceId, requestId, outcome, IP, User-Agent, redacted before/after and timestamp.

- [ ] **Step 1: 写不可篡改与脱敏失败测试**

In `tests/int/audit-logs.int.spec.ts`, assert that a publisher update creates one log, login/logout/password change create authentication audit events, direct REST create/update/delete returns 403, and values under keys matching `/password|secret|token|apiKey/i` are stored as `'[REDACTED]'`.

Run `pnpm vitest run --config ./vitest.config.mts tests/int/audit-logs.int.spec.ts`.

Expected: FAIL because the collection and hooks do not exist.

- [ ] **Step 2: 实现追加写入口和 hooks**

Use this event contract in `src/domain/audit.ts`:

```ts
export type AuditEvent = {
  capability: Capability
  action: string
  resourceType: string
  resourceId?: string
  outcome: 'succeeded' | 'failed'
  requestId: string
  before?: unknown
  after?: unknown
  errorCode?: string
}

export async function appendAuditLog(req: PayloadRequest, event: AuditEvent): Promise<void>
export function redactAuditValue(value: unknown): unknown
```

`appendAuditLog` must call `req.payload.create({ collection: 'audit-logs', data, overrideAccess: true })`; `AuditLogs` access must return `false` for create/update/delete and allow read only with `audit:read`. Attach the same redacted writer to `Admins` authentication hooks so login, logout and password changes are queryable as administrator login history.

- [ ] **Step 3: 注册集合、挂接 hooks、验证并提交**

Run:

```bash
pnpm run generate:types
pnpm vitest run --config ./vitest.config.mts tests/int/audit-logs.int.spec.ts
pnpm run test:int
git add src/collections src/domain/audit.ts src/payload.config.ts src/payload-types.ts tests/int/audit-logs.int.spec.ts
git commit -m "feat: add append-only platform audit logs"
```

Expected: 内容写操作有审计，审计 REST 写入全部被拒绝。

### Task 3: 增加插件与宠物发布目录

**Files:**

- Create: `src/collections/PluginCatalog.ts`
- Create: `src/collections/PetAssets.ts`
- Create: `tests/int/content-catalog.int.spec.ts`
- Modify: `src/payload.config.ts`

**Interfaces:**

- `plugin-catalog`: name, slug, version, summary, installKind, artifactURL, checksum, compatibility, riskLevel, enabled, drafts.
- `pet-assets`: name, slug, version, manifest, spriteMedia, previewMedia, compatibility, enabled, drafts.

- [ ] **Step 1: 写角色、版本和引用约束失败测试**

Assert publisher CRUD succeeds, finance admin write returns 403, duplicate `slug + version` fails, and a published pet requires both `manifest` and `spriteMedia`.

Run `pnpm vitest run --config ./vitest.config.mts tests/int/content-catalog.int.spec.ts`.

Expected: FAIL because both collections are absent.

- [ ] **Step 2: 创建版本化集合并注册统一审计 hooks**

Use these collection-level options in both files:

```ts
versions: { drafts: { autosave: false }, maxPerDoc: 20 },
access: {
  read: capabilityAccess('content:plugins:read'),
  create: capabilityAccess('content:plugins:write'),
  update: capabilityAccess('content:plugins:write'),
  delete: capabilityAccess('content:plugins:write')
}
```

For `PetAssets`, replace plugin capabilities with pet capabilities. Store `manifest` as JSON and media fields as relationships to `media`; never store local absolute paths.

- [ ] **Step 3: 生成类型、验证并提交**

Run:

```bash
pnpm run generate:types
pnpm vitest run --config ./vitest.config.mts tests/int/content-catalog.int.spec.ts
git add src/collections src/payload.config.ts src/payload-types.ts tests/int/content-catalog.int.spec.ts
git commit -m "feat: add plugin and pet publishing catalogs"
```

Expected: 集合 API、版本、权限和审计测试通过。

### Task 4: 建立 BFF 骨架与真实服务连接状态

**Files:**

- Create: `src/collections/IntegrationSettings.ts`
- Create: `src/platform-api/types.ts`
- Create: `src/platform-api/config.ts`
- Create: `src/platform-api/client.ts`
- Create: `src/endpoints/platform-status.ts`
- Create: `tests/int/platform-status.int.spec.ts`
- Modify: `src/payload.config.ts`

**Interfaces:**

- Produces the fixed success/error envelope shared by all later BFF operations.
- `GET /api/platform/v1/status` reports Payload health and whether the configured API admin endpoint responds; it never returns URL credentials or the admin key.
- `integration-settings` stores service type, enabled state, last check time, health status and sanitized error code.

- [ ] **Step 1: 写认证、未配置和密钥泄漏失败测试**

Assert unauthenticated is 401, publisher with `dashboard:read` can read status, missing environment returns `not_configured`, a disposable API `/admin/compliance` response returns `healthy`, and response/log text never contains the canary admin key.

Run `pnpm vitest run --config ./vitest.config.mts tests/int/platform-status.int.spec.ts`.

Expected: FAIL because the status endpoint and BFF types are absent.

- [ ] **Step 2: 实现固定 envelope 和只读探测**

Create these base types in `src/platform-api/types.ts`:

```ts
export type PlatformSuccess<T, M extends Record<string, unknown> = Record<string, never>> = {
  data: T
  meta: M
  requestId: string
}

export type PlatformFailure = {
  error: { code: string; message: string }
  requestId: string
}
```

`config.ts` validates `AGENTERA_API_URL` as HTTP(S) and reads `AGENTERA_API_ADMIN_KEY` without exporting it. `client.ts` implements only `probeAgenteraAPI(requestId)`: a bounded GET to the existing `/admin/compliance` endpoint with `x-api-key`. Status persists only `healthy | unavailable | not_configured` and a sanitized error code.

- [ ] **Step 3: 注册集合/端点、验证并提交**

Run:

```bash
pnpm run generate:types
pnpm vitest run --config ./vitest.config.mts tests/int/platform-status.int.spec.ts
pnpm run test:int
git add src/collections/IntegrationSettings.ts src/platform-api src/endpoints/platform-status.ts src/payload.config.ts src/payload-types.ts tests/int/platform-status.int.spec.ts
git commit -m "feat: add platform bff status foundation"
```

Expected: homepage can consume real service status and later phases can extend the same BFF types/client.

### Task 5: 建立 Soybean capability 守卫和内容页面共用件

**Files:**

- Create: `admin-web/src/constants/capabilities.ts`
- Create: `admin-web/src/composables/use-capability.ts`
- Create: `admin-web/src/components/platform/resource-page-shell.vue`
- Create: `admin-web/src/components/platform/resource-state.vue`
- Create: `admin-web/src/components/platform/confirm-action.vue`
- Create: `admin-web/src/composables/use-capability.test.ts`
- Modify: `admin-web/src/typings/api/auth.d.ts`
- Modify: `admin-web/src/router/guard/route.ts`

**Interfaces:**

- Consumes: authenticated admin `role` from `/api/admins/me`.
- Produces: `can(capability)`, route meta `capability`, standard loading/empty/403/unavailable/error states.

- [ ] **Step 1: 写前端守卫失败测试**

Assert publisher can publish agents but cannot refund, auditor sees read routes but action guard returns false, and a direct navigation without required capability resolves to `403`.

Run `pnpm --dir admin-web vitest run src/composables/use-capability.test.ts`.

Expected: FAIL because capability helpers are absent.

- [ ] **Step 2: 实现与服务端同代码值的只读前端映射**

Export this public API:

```ts
export function useCapability() {
  const authStore = useAuthStore()
  const can = (capability: Capability) => hasCapability(authStore.userInfo.role, capability)
  return { can }
}
```

Add `capability?: Capability` to route meta typing. The route guard must redirect to `403`; it must never make authorization decisions for API requests.

- [ ] **Step 3: 验证并提交**

Run:

```bash
pnpm --dir admin-web test
pnpm --dir admin-web typecheck
git add admin-web/src/constants admin-web/src/composables admin-web/src/components/platform admin-web/src/typings admin-web/src/router/guard/route.ts
git commit -m "feat: add soybean capability and resource page primitives"
```

Expected: capability tests and TypeScript pass。

### Task 6: 完成内容与管理员 Soybean 页面

**Files:**

- Create: `admin-web/src/service/agents.ts`
- Create: `admin-web/src/service/skills.ts`
- Create: `admin-web/src/service/plugins.ts`
- Create: `admin-web/src/service/media.ts`
- Create: `admin-web/src/service/pets.ts`
- Create: `admin-web/src/service/admins.ts`
- Create: `admin-web/src/service/publishing.ts`
- Create: `admin-web/src/views/agents/index.vue`
- Create: `admin-web/src/views/skills/index.vue`
- Create: `admin-web/src/views/plugins/index.vue`
- Create: `admin-web/src/views/media/index.vue`
- Create: `admin-web/src/views/pets/index.vue`
- Create: `admin-web/src/views/publishing/index.vue`
- Create: `admin-web/src/views/admins/index.vue`
- Modify: `admin-web/src/views/categories/index.vue`
- Modify: `admin-web/src/views/home/index.vue`
- Modify: `admin-web/src/router/elegant/routes.ts`
- Modify: `admin-web/src/router/elegant/imports.ts`
- Modify: `admin-web/src/router/elegant/transform.ts`

**Interfaces:**

- All services call Payload REST through `admin-web/src/service/http.ts` with `credentials: 'include'`.
- List functions return `{ docs, page, totalPages, totalDocs }`; mutation functions return the saved Payload document.

- [ ] **Step 1: 为每个 service 写请求形状失败测试**

Create sibling `*.test.ts` files and assert exact collection paths, pagination query, draft/publish query, multipart media upload, and no Authorization header.

Run `pnpm --dir admin-web test`.

Expected: FAIL because the services do not exist.

- [ ] **Step 2: 实现服务与统一页面行为**

Use this service signature consistently:

```ts
export type ResourceQuery = { page: number; limit: number; search?: string; sort?: string }
export function listResources(
  query: ResourceQuery,
  signal?: AbortSignal,
): Promise<PayloadPage<Resource>>
export function createResource(input: ResourceInput): Promise<Resource>
export function updateResource(id: string, input: Partial<ResourceInput>): Promise<Resource>
export function deleteResource(id: string): Promise<void>
```

Each page must render `resource-page-shell`, server pagination, search, permission-aware actions, editor modal, delete confirmation, and `resource-state`. Agents, skills, plugins and pets also expose draft/publish; media exposes upload and reference summary; admins expose role/status/password reset but never echo password. The home page calls `/api/platform/v1/status` and shows `healthy`, `unavailable` or `not_configured` without fallback data.

- [ ] **Step 3: 生成静态路由并加入真实菜单**

Run:

```bash
pnpm --dir admin-web gen-route
pnpm --dir admin-web fmt
pnpm --dir admin-web test
pnpm --dir admin-web typecheck
```

Expected: generated route files include exactly the completed pages and no demo route.

- [ ] **Step 4: 提交 Soybean 内容后台**

Run:

```bash
git add admin-web/src
git commit -m "feat: complete soybean content administration"
```

Expected: commit contains services, tests, views, routes and localized menu labels.

### Task 7: 内容后台 E2E、构建与阶段交付

**Files:**

- Modify: `tests/e2e-soybean/admin-web.e2e.spec.ts`
- Create: `tests/e2e-soybean/content-admin.e2e.spec.ts`
- Modify: `playwright.soybean.config.ts`
- Modify: `docs/superpowers/specs/2026-07-16-agentera-platform-admin-full-system-design.md`

- [ ] **Step 1: 增加五角色、内容 CRUD 和错误态 E2E**

Cover login/session recovery, menu visibility, publisher CRUD/publish, finance 403, auditor read-only, media upload, empty state, backend unavailable, and mobile width without whole-page horizontal overflow.

Run `pnpm run test:e2e:admin`.

Expected: initial failure identifies any unimplemented path; fix product code without weakening assertions.

- [ ] **Step 2: 执行阶段验证**

Run:

```bash
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

- [ ] **Step 3: 更新规格复核项并提交**

Change only verified checklist items in the design spec from `[ ]` to `[x]`, then run:

```bash
git add tests/e2e-soybean playwright.soybean.config.ts docs/superpowers/specs/2026-07-16-agentera-platform-admin-full-system-design.md
git commit -m "test: verify soybean content administration"
```

Expected: 阶段 1 的内容管理验收有自动化证据，未完成阶段仍保持未勾选。
