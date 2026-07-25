# AgentEra 租户、账号审核与跨系统聚合 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在不破坏已完成充值站的前提下，为业务 API 增加最小租户和可选账号审核模型，并在 Soybean 聚合用户、套餐、用量、Runtime 和异常形成真实平台总览。

**Architecture:** 租户、成员和用户审核仍由 `agentera-claw-api`/PostgreSQL 持有；Payload Runtime 实例只保存稳定 `tenantId` 字符串，不建跨数据库外键。Payload 聚合服务并发读取 API dashboard/tenant/user 数据与本地 Runtime/content 统计，返回可部分成功的固定 DTO；Soybean 只渲染真实值和明确的 unavailable 状态。

**Tech Stack:** Go、Gin、Ent、PostgreSQL、Payload 3、TypeScript、Vue 3、Vitest、Playwright。

## Global Constraints

- 充值站现有用户注册、登录、充值和支付默认行为必须保持不变。
- 新增 `registration_review_enabled` 默认 false；迁移后所有既有用户 `review_status = approved`。
- 只有启用审核开关后，新注册用户才进入 pending/disabled；关闭开关时新用户仍直接 approved/active。
- 租户只是平台组织关系，不接管支付订单或本地 Runtime 数据。
- 跨系统只使用稳定外部 ID；不建跨数据库外键，不复制用户、订单、用量或实例表。
- 聚合请求单个来源超时不能让整个首页 500；必须返回 source status 和可用分区。
- 任何聚合 DTO 都不得包含聊天、记忆、文件、提示词、回复、原始日志或凭证。

---

## 最小业务模型

```go
const (
	ReviewPending  = "pending"
	ReviewApproved = "approved"
	ReviewRejected = "rejected"
)

const (
	TenantRoleOwner  = "owner"
	TenantRoleAdmin  = "admin"
	TenantRoleMember = "member"
)
```

`tenants.external_id` is a UUID string used by Payload. `tenant_memberships` uniquely indexes `(tenant_id, user_id)`.

### Task 1: 在 API 增加 Tenant 与 Membership Ent schema

**Repository:** `/Users/zizimutou/Desktop/agentera claw/agentera-claw-api`

**Files:**

- Create: `backend/ent/schema/tenant.go`
- Create: `backend/ent/schema/tenant_membership.go`
- Modify: `backend/ent/schema/user.go`
- Create: `backend/migrations/177_add_tenants.sql`
- Create: `backend/migrations/tenant_migration_test.go`
- Modify: `backend/migrations/migrations.go`

**Interfaces:**

- Tenant fields: external_id, name, status, notes, created_at, updated_at.
- Membership fields: role, status, tenant edge, user edge, created_at, updated_at.

- [ ] **Step 1: 写 schema 和迁移失败测试**

Test that external ID is unique, membership pair is unique, deleting a tenant cascades memberships but not users, and role/status constraints reject invalid values.

Run:

```bash
cd backend
go test ./ent/schema ./migrations -run 'Tenant|Membership'
```

Expected: FAIL because schemas and migration are absent.

- [ ] **Step 2: 实现 Ent schema**

Use these validation values:

```go
field.String("external_id").Unique().NotEmpty().MaxLen(64)
field.String("status").Default("active").Validate(func(v string) error {
	if v != "active" && v != "disabled" { return fmt.Errorf("invalid tenant status") }
	return nil
})
field.String("role").Validate(func(v string) error {
	if v != "owner" && v != "admin" && v != "member" { return fmt.Errorf("invalid tenant role") }
	return nil
})
```

Add `memberships` edges to Tenant and User. Use an explicit unique index across tenant/user edges.

- [ ] **Step 3: 实现向前兼容 SQL migration**

Create both tables, indexes and foreign keys in `177_add_tenants.sql`. Do not assign existing users to an implicit tenant. The down path is not run automatically; document rollback SQL in migration comments.

- [ ] **Step 4: 生成 Ent、验证并提交**

Run:

```bash
make -C backend generate
go -C backend test ./ent/schema ./migrations -run 'Tenant|Membership'
git diff --check
git add backend/ent backend/migrations
git commit -m "feat: add tenant and membership data model"
```

Expected: generated client exposes Tenant and TenantMembership without modifying payment models.

### Task 2: 在 API 增加租户 repository、service、handler 和路由

**Files:**

- Create: `backend/internal/service/tenant.go`
- Create: `backend/internal/repository/tenant_repo.go`
- Create: `backend/internal/repository/tenant_repo_test.go`
- Create: `backend/internal/handler/admin/tenant_handler.go`
- Create: `backend/internal/handler/admin/tenant_handler_test.go`
- Modify: `backend/internal/handler/handler.go`
- Modify: `backend/internal/handler/wire.go`
- Modify: `backend/internal/service/wire.go`
- Modify: `backend/internal/repository/wire.go`
- Modify: `backend/internal/server/routes/admin.go`
- Modify: `backend/cmd/server/wire_gen.go`

**Interfaces:**

- `GET/POST /api/v1/admin/tenants`
- `GET/PUT/DELETE /api/v1/admin/tenants/:id`
- `GET/POST /api/v1/admin/tenants/:id/members`
- `PUT/DELETE /api/v1/admin/tenants/:id/members/:user_id`

- [ ] **Step 1: 写 owner 约束和分页失败测试**

Assert create requires a name and owner user ID, the initial owner membership is created atomically, a tenant cannot lose its last owner, duplicate membership returns 409, list supports page/page_size/status/search, and delete is soft/disabled rather than deleting users.

Run:

```bash
cd backend
go test ./internal/repository ./internal/handler/admin -run Tenant
```

Expected: FAIL because tenant layers are absent.

- [ ] **Step 2: 实现 service contract**

Create these public inputs:

```go
type CreateTenantInput struct {
	Name        string
	OwnerUserID int64
	Notes       string
}

type TenantService interface {
	List(context.Context, int, int, string, string) ([]Tenant, int64, error)
	Get(context.Context, int64) (*Tenant, error)
	Create(context.Context, CreateTenantInput) (*Tenant, error)
	Update(context.Context, int64, UpdateTenantInput) (*Tenant, error)
	Disable(context.Context, int64) error
	ListMembers(context.Context, int64) ([]TenantMembership, error)
	AddMember(context.Context, int64, int64, string) (*TenantMembership, error)
	UpdateMember(context.Context, int64, int64, string, string) (*TenantMembership, error)
	RemoveMember(context.Context, int64, int64) error
}
```

Repository transactions enforce the last-owner invariant.

- [ ] **Step 3: 实现薄 handler、路由与 Wire**

Handlers only parse/validate, call service and use existing `response.Success/Paginated/ErrorFrom`. Register under the existing admin auth/compliance middleware. Run Wire generation rather than hand-maintaining inconsistent constructors.

- [ ] **Step 4: 验证并提交**

Run:

```bash
make -C backend generate
go -C backend test ./internal/repository ./internal/service ./internal/handler/admin ./internal/server -run Tenant
make test-backend
git diff --check
git add backend
git commit -m "feat: add tenant administration api"
```

Expected: tenant CRUD/member routes pass and existing API tests remain green.

### Task 3: 增加默认关闭的账号审核状态

**Repository:** `/Users/zizimutou/Desktop/agentera claw/agentera-claw-api`

**Files:**

- Modify: `backend/ent/schema/user.go`
- Create: `backend/migrations/178_add_user_review_status.sql`
- Create: `backend/migrations/user_review_migration_test.go`
- Modify: `backend/migrations/migrations.go`
- Modify: `backend/internal/service/user.go`
- Modify: `backend/internal/repository/user_repo.go`
- Modify: `backend/internal/handler/dto/types.go`
- Modify: `backend/internal/handler/dto/mappers.go`
- Create: `backend/internal/service/account_review.go`
- Create: `backend/internal/handler/admin/account_review_handler.go`
- Create: `backend/internal/handler/admin/account_review_handler_test.go`
- Modify: `backend/internal/handler/handler.go`
- Modify: `backend/internal/handler/wire.go`
- Modify: `backend/internal/server/routes/admin.go`
- Modify: `backend/cmd/server/wire_gen.go`

**Interfaces:**

- User fields: review_status, review_reason, reviewed_at, reviewed_by.
- Admin routes: `GET /api/v1/admin/account-reviews`, `POST /api/v1/admin/account-reviews/:user_id/approve`, `POST /api/v1/admin/account-reviews/:user_id/reject`.

- [ ] **Step 1: 写迁移默认值与审核转换失败测试**

Assert existing rows become approved, migration does not change user status, approve transitions pending -> approved/active, reject requires a reason and transitions pending -> rejected/disabled, terminal state cannot be silently overwritten, and list never returns password hash/TOTP secret.

Run:

```bash
cd backend
go test ./migrations ./internal/handler/admin -run 'Review|AccountReview'
```

Expected: FAIL because fields and endpoints are absent.

- [ ] **Step 2: 增加字段与 repository mapping**

Use Ent validation for pending/approved/rejected. Migration uses:

```sql
ALTER TABLE users ADD COLUMN IF NOT EXISTS review_status varchar(20) NOT NULL DEFAULT 'approved';
ALTER TABLE users ADD COLUMN IF NOT EXISTS review_reason text NOT NULL DEFAULT '';
ALTER TABLE users ADD COLUMN IF NOT EXISTS reviewed_at timestamptz NULL;
ALTER TABLE users ADD COLUMN IF NOT EXISTS reviewed_by bigint NULL REFERENCES users(id) ON DELETE SET NULL;
```

Do not change `status` for existing users.

- [ ] **Step 3: 实现审核 service 与 Admin routes**

Use transactions and row locking so only pending can transition. Return 409 for a stale decision. Record reviewer ID when JWT admin identity exists; keep it null for an authenticated system Admin API Key and rely on Payload audit for the platform actor.

- [ ] **Step 4: 验证并提交**

Run:

```bash
make -C backend generate
go -C backend test ./migrations ./internal/repository ./internal/service ./internal/handler/admin -run 'Review|AccountReview'
make test-backend
git diff --check
git add backend
git commit -m "feat: add optional account review workflow"
```

Expected: review endpoints exist while the live registration behavior remains unchanged.

### Task 4: 用默认关闭设置接入注册流程

**Files:**

- Modify: `backend/internal/service/auth_service.go`
- Create: `backend/internal/service/auth_service_registration_review_test.go`
- Modify: `backend/internal/handler/admin/setting_handler.go`
- Modify: `frontend/src/api/admin/settings.ts`
- Modify: `frontend/src/views/admin/SettingsView.vue`

**Interfaces:**

- Setting key: `registration_review_enabled`, default false.
- The existing API admin UI gets the same switch temporarily until Soybean cutover, so operators are not forced to edit the DB.

- [ ] **Step 1: 写注册兼容性失败测试**

Assert false/missing creates active+approved exactly as today, true creates disabled+pending, login for pending is denied with a stable code, and approve allows login. Cover email plus one OAuth registration path.

Run:

```bash
cd backend
go test ./internal/service -run RegistrationReview
```

Expected: FAIL because auth service ignores the setting.

- [ ] **Step 2: 实现一个分支，不复制注册逻辑**

Immediately before persisting a newly constructed user, call one helper:

```go
func applyRegistrationReviewPolicy(user *User, enabled bool) {
	if enabled {
		user.Status = StatusDisabled
		user.ReviewStatus = ReviewPending
		return
	}
	user.ReviewStatus = ReviewApproved
}
```

All registration sources must reach this helper. Existing users and payment behavior are untouched.

- [ ] **Step 3: 验证充值站关键测试和提交**

Run:

```bash
go -C backend test ./internal/service -run 'RegistrationReview|Register|Payment'
pnpm --dir frontend exec vitest run src/views/user/__tests__/PaymentView.spec.ts src/views/user/__tests__/PaymentResultView.spec.ts src/views/admin/__tests__/SettingsView.spec.ts
make test-backend
make test-frontend
git diff --check
git add backend frontend
git commit -m "feat: gate new registrations behind optional review"
```

Expected: default-off registration and completed recharge UI remain green.

### Task 5: 接入租户/审核 BFF 和 Soybean 页面

**Repository:** `/Users/zizimutou/Desktop/agentera claw/agentera-admin`

**Files:**

- Modify: `src/platform-api/operations.ts`
- Create: `tests/int/platform-tenants.int.spec.ts`
- Create: `admin-web/src/service/tenants.ts`
- Create: `admin-web/src/service/tenants.test.ts`
- Create: `admin-web/src/views/tenants/index.vue`
- Create: `admin-web/src/views/account-reviews/index.vue`
- Modify: `admin-web/src/router/elegant/routes.ts`
- Modify: `admin-web/src/router/elegant/imports.ts`

**Interfaces:**

- `tenants:read/write` for tenant routes; `users:read/write` for review routes.
- Runtime instance link uses tenant `external_id`, not API database primary key.

- [ ] **Step 1: 写 BFF capability 和页面 service 失败测试**

Assert operations admin can manage tenants/reviews, finance admin can read linked subscription summary but cannot approve, publisher gets 403, approve/reject are audited, and reject requires reason.

Run:

```bash
pnpm vitest run --config ./vitest.config.mts tests/int/platform-tenants.int.spec.ts
pnpm --dir admin-web vitest run src/service/tenants.test.ts
```

Expected: FAIL because operations/services are absent.

- [ ] **Step 2: 注册 allowlist 并实现两个页面**

Tenant page uses list/detail drawer/member table. Review page has pending/approved/rejected tabs, identity source, approve/reject confirmation and reason. No credential or identity metadata blob is displayed.

- [ ] **Step 3: 生成路由、验证并提交**

Run:

```bash
pnpm --dir admin-web gen-route
pnpm --dir admin-web fmt
pnpm run test:int
pnpm --dir admin-web test
pnpm --dir admin-web typecheck
git add src/platform-api tests/int/platform-tenants.int.spec.ts admin-web/src
git commit -m "feat: add tenant and account review administration"
```

Expected: real tenant/review data is manageable through Soybean.

### Task 6: 建立可部分成功的平台聚合服务和总览

**Files:**

- Create: `src/platform-api/dashboard.ts`
- Create: `src/endpoints/platform-dashboard.ts`
- Create: `tests/int/platform-dashboard.int.spec.ts`
- Create: `admin-web/src/service/dashboard.ts`
- Create: `admin-web/src/service/dashboard.test.ts`
- Modify: `admin-web/src/views/home/index.vue`

**Interfaces:**

- `GET /api/platform/v1/dashboard/overview`
- `GET /api/platform/v1/dashboard/todos`
- Each section includes `source: { status: 'ok' | 'unavailable'; updatedAt?: string; requestId?: string }`.

- [ ] **Step 1: 写真实值、部分失败和隐私失败测试**

Mock API dashboard, tenants/reviews and local Payload counts. Assert values are not synthesized, one API timeout still returns Payload sections, unavailable section has no fake zero, forbidden sensitive keys are absent, and total latency is bounded by the slowest timeout rather than summed time.

Run `pnpm vitest run --config ./vitest.config.mts tests/int/platform-dashboard.int.spec.ts`.

Expected: FAIL because aggregate endpoints are absent.

- [ ] **Step 2: 实现并发聚合 DTO**

Use `Promise.allSettled` with per-source AbortController. Return users/revenue/token/requests from API, content/runtime counts from Payload, pending review/failed order/offline instance/failed command/open alert todos from their owners. Never calculate revenue from order rows in Payload.

- [ ] **Step 3: 实现首页真实状态**

Cards display value only when source status is ok. Unavailable shows “服务暂不可用” and request ID; empty shows 0 only after a successful source response. Add trend charts only for real time-series returned by the API.

- [ ] **Step 4: 验证并提交**

Run:

```bash
pnpm run test:int
pnpm --dir admin-web vitest run src/service/dashboard.test.ts
pnpm --dir admin-web typecheck
pnpm run build
pnpm run build:admin
git add src/platform-api/dashboard.ts src/endpoints/platform-dashboard.ts tests/int/platform-dashboard.int.spec.ts admin-web/src/service/dashboard.ts admin-web/src/service/dashboard.test.ts admin-web/src/views/home/index.vue
git commit -m "feat: add real cross-system platform overview"
```

Expected: dashboard is real, bounded and explicit about partial failure.

### Task 7: 兼容矩阵、跨系统 E2E 和阶段验收

**Files:**

- Modify: `src/collections/RuntimeReleases.ts`
- Create: `src/domain/runtime-compatibility.ts`
- Create: `tests/int/runtime-compatibility.int.spec.ts`
- Create: `tests/e2e-soybean/tenants-dashboard.e2e.spec.ts`

- [ ] **Step 1: 写版本策略失败测试**

Assert minimum/blocked version policy classifies instance as supported/outdated/blocked/unknown, unknown versions are never auto-upgraded, and rollout percentage selects a stable cohort from instance ID.

Run `pnpm vitest run --config ./vitest.config.mts tests/int/runtime-compatibility.int.spec.ts`.

Expected: FAIL because compatibility evaluator is absent.

- [ ] **Step 2: 实现纯兼容性 evaluator**

Expose:

```ts
export function evaluateCompatibility(input: {
  version: string
  minimumVersion?: string
  blockedVersions: string[]
}): 'supported' | 'outdated' | 'blocked' | 'unknown'
```

Use an existing semver dependency only if already present; otherwise implement strict numeric triplet parsing locally rather than adding a package.

- [ ] **Step 3: 运行跨系统浏览器流程**

E2E covers tenant/member CRUD, review default-off, enabling review in a disposable API, pending registration, approval, user/tenant/runtime association, dashboard partial failure and compatibility badge. It must also complete one test checkout/payment fixture to prove recharge regression safety without external payment calls.

Run `pnpm run test:e2e:admin -- tests/e2e-soybean/tenants-dashboard.e2e.spec.ts`.

Expected: all cross-links resolve by stable external ID and no sensitive content appears.

- [ ] **Step 4: 各仓库全量验证并提交**

Run:

```bash
cd '/Users/zizimutou/Desktop/agentera claw/agentera-claw-api'
make -C backend generate
make test
make build

cd '/Users/zizimutou/Desktop/agentera claw/agentera-admin'
pnpm run test:int
pnpm run test:admin
pnpm --dir admin-web typecheck
pnpm run build
pnpm run build:admin
pnpm run test:e2e:admin
git diff --check
git add src/collections/RuntimeReleases.ts src/domain/runtime-compatibility.ts tests/int/runtime-compatibility.int.spec.ts tests/e2e-soybean/tenants-dashboard.e2e.spec.ts
git commit -m "test: verify platform tenant aggregation"
```

Expected: API payment/registration regressions, admin aggregation and browser workflows all pass.
