# AgentEra Platform Admin V1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the current AgentEra official-agent admin into the approved platform-operator super-admin website, preserving real Payload workflows while adding a near-1:1 platform dashboard and clearly labeled demo module pages.

**Architecture:** Keep Payload CMS as the authentication, authorization, routing, and real collection owner. Replace the dashboard with a server-rendered custom Admin View, register shared custom Admin Views for demo domains, centralize navigation/module metadata, and use a dedicated SCSS layer to reproduce the approved Soybean-style composition without duplicating Payload CRUD behavior.

**Tech Stack:** Payload CMS 3.86, Next.js 16, React 19, TypeScript 5.7, SCSS, SQLite, Vitest, Playwright.

---

## File map

### New files

- `src/components/admin/platform/platformModules.ts` — canonical platform groups, routes, data modes, demo metrics, filters, columns, and rows.
- `src/components/admin/platform/platformAccess.ts` — role-based visibility and custom-view guard helpers.
- `src/components/admin/platform/PlatformDashboard.tsx` — approved platform overview using one real Payload count plus deterministic demo data.
- `src/components/admin/platform/PlatformModuleView.tsx` — shared read-only page renderer and named custom-view exports.
- `src/app/(payload)/platform-admin.scss` — platform dashboard, demo pages, chart, health list, tables, and responsive styles.
- `tests/int/platform-admin.int.spec.ts` — module registry, route uniqueness, data-mode, and role visibility tests.

### Modified files

- `src/components/admin/AdminIcon.tsx` — icons needed by the full platform navigation.
- `src/components/admin/AgentEraNav.tsx` — render all approved groups from the central registry.
- `src/components/admin/AgentEraLogo.tsx` — use the user-provided optimized brand image through `next/image`.
- `src/payload.config.ts` — replace the dashboard and register custom platform Admin Views.
- `src/app/(payload)/custom.scss` — import the platform layer and retain global Payload theme rules.
- `src/app/(payload)/admin/importMap.js` — regenerate custom component imports.
- `tests/e2e/admin.e2e.spec.ts` — platform dashboard, navigation, demo routes, real routes, brand icon, and responsive contracts.
- `README.md` — document real versus demo platform modules.

### Assets

- `public/agentera-icon.png` — 512×512 transparent brand image for UI use.
- `src/app/icon.png` — 256×256 Next.js favicon.

## Task 1: Lock the platform registry and dashboard contract

**Files:**

- Create: `tests/int/platform-admin.int.spec.ts`
- Modify: `tests/e2e/admin.e2e.spec.ts`

- [ ] **Step 1: Write the failing platform registry tests**

Create `tests/int/platform-admin.int.spec.ts`:

```ts
import { describe, expect, it } from 'vitest'

import { canAccessPlatformViews, navGroupsForRole } from '../../src/components/admin/platform/platformAccess'
import { platformModules } from '../../src/components/admin/platform/platformModules'

describe('platform admin registry', () => {
  it('uses unique routes for every approved platform page', () => {
    const hrefs = platformModules.map((item) => item.href)
    expect(new Set(hrefs).size).toBe(hrefs.length)
    expect(hrefs).toEqual(
      expect.arrayContaining([
        '/admin',
        '/admin/platform-users',
        '/admin/tenants',
        '/admin/account-reviews',
        '/admin/collections/agent-templates',
        '/admin/model-services',
        '/admin/runtime-versions',
        '/admin/task-runs',
        '/admin/plans',
        '/admin/orders',
        '/admin/announcements',
        '/admin/collections/admins',
        '/admin/audit-logs',
        '/admin/system-settings',
      ]),
    )
  })

  it('marks every non-Payload platform module as demo data', () => {
    const customModules = platformModules.filter(
      (item) => item.href !== '/admin' && !item.href.includes('/collections/'),
    )
    expect(customModules.every((item) => item.dataMode === 'demo')).toBe(true)
  })

  it('keeps platform operations visible only to super admins', () => {
    expect(navGroupsForRole('super_admin').map((group) => group.label)).toEqual([
      '工作台',
      '用户与租户',
      '智能体生态',
      'AI 与运行',
      '商业与运营',
      '系统管理',
    ])
    expect(navGroupsForRole('publisher').flatMap((group) => group.items.map((item) => item.label))).toEqual([
      '官方智能体',
      '智能体分类',
      '技能目录',
      '媒体资源',
    ])
    expect(canAccessPlatformViews('super_admin')).toBe(true)
    expect(canAccessPlatformViews('publisher')).toBe(false)
  })
})
```

- [ ] **Step 2: Add failing E2E coverage for the accepted page**

Extend `tests/e2e/admin.e2e.spec.ts`:

```ts
test('renders the approved platform overview', async () => {
  await page.goto(`${serverURL}/admin`)

  const dashboard = page.getByTestId('platform-dashboard')
  await expect(dashboard.getByRole('heading', { level: 1, name: 'AgentEra 平台总览' })).toBeVisible()
  await expect(dashboard.getByText('注册用户 · 演示')).toBeVisible()
  await expect(dashboard.getByText('官方智能体 · 真实')).toBeVisible()
  await expect(dashboard.getByTestId('platform-trend-chart')).toBeVisible()
  await expect(dashboard.getByTestId('service-health-list')).toBeVisible()
  await expect(dashboard.getByTestId('recent-tenant-table')).toBeVisible()
  await expect(dashboard.getByTestId('operations-feed')).toBeVisible()
})

test('opens a read-only demo platform module', async () => {
  await page.goto(`${serverURL}/admin/tenants`)

  await expect(page.getByRole('heading', { level: 1, name: '租户管理' })).toBeVisible()
  await expect(page.getByText('演示数据', { exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: '接入后端后开放' })).toBeDisabled()
})
```

- [ ] **Step 3: Verify RED**

Run:

```bash
pnpm test:int -- platform-admin.int.spec.ts
pnpm test:e2e --grep "approved platform overview|read-only demo platform module"
```

Expected: integration tests fail because the platform modules do not exist; E2E tests fail because the current dashboard and `/admin/tenants` view do not implement the contract.

- [ ] **Step 4: Commit the failing contract**

```bash
git add tests/int/platform-admin.int.spec.ts tests/e2e/admin.e2e.spec.ts
git commit -m "test: define platform admin v1 contract"
```

## Task 2: Add the canonical module registry and role visibility

**Files:**

- Create: `src/components/admin/platform/platformModules.ts`
- Create: `src/components/admin/platform/platformAccess.ts`
- Test: `tests/int/platform-admin.int.spec.ts`

- [ ] **Step 1: Define the platform types and canonical routes**

Create `src/components/admin/platform/platformModules.ts` with these exported types and module identities:

```ts
import type { AdminIconName } from '../AdminIcon'

export type PlatformDataMode = 'demo' | 'mixed' | 'real'
export type PlatformGroupKey =
  | 'ai_runtime'
  | 'business'
  | 'dashboard'
  | 'ecosystem'
  | 'system'
  | 'users_tenants'

export type PlatformModuleKey =
  | 'account_reviews'
  | 'admin_users'
  | 'agent_categories'
  | 'announcements'
  | 'audit_logs'
  | 'dashboard'
  | 'media'
  | 'model_services'
  | 'official_agents'
  | 'orders'
  | 'plans'
  | 'platform_users'
  | 'runtime_versions'
  | 'skills'
  | 'system_settings'
  | 'task_runs'
  | 'tenants'

export type DemoModuleKey = Exclude<
  PlatformModuleKey,
  'admin_users' | 'agent_categories' | 'dashboard' | 'media' | 'official_agents' | 'skills'
>

export type PlatformModule = {
  dataMode: PlatformDataMode
  group: PlatformGroupKey
  href: string
  icon: AdminIconName
  key: PlatformModuleKey
  label: string
  superAdminOnly?: boolean
}

export const platformModules: PlatformModule[] = [
  { dataMode: 'mixed', group: 'dashboard', href: '/admin', icon: 'dashboard', key: 'dashboard', label: '平台总览', superAdminOnly: true },
  { dataMode: 'demo', group: 'users_tenants', href: '/admin/platform-users', icon: 'users', key: 'platform_users', label: '用户管理', superAdminOnly: true },
  { dataMode: 'demo', group: 'users_tenants', href: '/admin/tenants', icon: 'tenants', key: 'tenants', label: '租户管理', superAdminOnly: true },
  { dataMode: 'demo', group: 'users_tenants', href: '/admin/account-reviews', icon: 'approvals', key: 'account_reviews', label: '账号审核', superAdminOnly: true },
  { dataMode: 'real', group: 'ecosystem', href: '/admin/collections/agent-templates', icon: 'agents', key: 'official_agents', label: '官方智能体' },
  { dataMode: 'real', group: 'ecosystem', href: '/admin/collections/expert-categories', icon: 'categories', key: 'agent_categories', label: '智能体分类' },
  { dataMode: 'real', group: 'ecosystem', href: '/admin/collections/skill-catalog', icon: 'skills', key: 'skills', label: '技能目录' },
  { dataMode: 'real', group: 'ecosystem', href: '/admin/collections/media', icon: 'media', key: 'media', label: '媒体资源' },
  { dataMode: 'demo', group: 'ai_runtime', href: '/admin/model-services', icon: 'models', key: 'model_services', label: '模型与服务', superAdminOnly: true },
  { dataMode: 'demo', group: 'ai_runtime', href: '/admin/runtime-versions', icon: 'runtime', key: 'runtime_versions', label: 'Runtime 版本', superAdminOnly: true },
  { dataMode: 'demo', group: 'ai_runtime', href: '/admin/task-runs', icon: 'tasks', key: 'task_runs', label: '任务运行', superAdminOnly: true },
  { dataMode: 'demo', group: 'business', href: '/admin/plans', icon: 'plans', key: 'plans', label: '套餐管理', superAdminOnly: true },
  { dataMode: 'demo', group: 'business', href: '/admin/orders', icon: 'orders', key: 'orders', label: '订单中心', superAdminOnly: true },
  { dataMode: 'demo', group: 'business', href: '/admin/announcements', icon: 'announcements', key: 'announcements', label: '公告运营', superAdminOnly: true },
  { dataMode: 'real', group: 'system', href: '/admin/collections/admins', icon: 'users', key: 'admin_users', label: '管理员', superAdminOnly: true },
  { dataMode: 'demo', group: 'system', href: '/admin/audit-logs', icon: 'audit', key: 'audit_logs', label: '审计日志', superAdminOnly: true },
  { dataMode: 'demo', group: 'system', href: '/admin/system-settings', icon: 'settings', key: 'system_settings', label: '系统设置', superAdminOnly: true },
]
```

In the same file, add these concrete group labels and demo page types:

```ts
export const platformGroupLabels: Record<PlatformGroupKey, string> = {
  dashboard: '工作台',
  users_tenants: '用户与租户',
  ecosystem: '智能体生态',
  ai_runtime: 'AI 与运行',
  business: '商业与运营',
  system: '系统管理',
}

type DemoMetric = { label: string; value: string }
type DemoRow = Record<string, string>

export type DemoModulePage = {
  columns: { key: string; label: string }[]
  description: string
  key: DemoModuleKey
  metrics: DemoMetric[]
  rows: DemoRow[]
  title: string
}

const page = (
  key: DemoModuleKey,
  title: string,
  description: string,
  metrics: DemoMetric[],
  columns: DemoModulePage['columns'],
  rows: DemoRow[],
): DemoModulePage => ({ columns, description, key, metrics, rows, title })

export const platformModulePages: Record<DemoModuleKey, DemoModulePage> = {
  platform_users: page('platform_users', '用户管理', '查看平台注册用户及账号状态', [
    { label: '注册用户', value: '1,286' }, { label: '本月新增', value: '146' }, { label: '活跃用户', value: '864' },
  ], [{ key: 'user', label: '用户' }, { key: 'tenant', label: '所属租户' }, { key: 'status', label: '状态' }, { key: 'joined', label: '注册时间' }], [
    { user: 'Lin Chen', tenant: 'NorthEra Studio', status: '正常', joined: '今天 09:42' },
    { user: '顾明', tenant: '青岚科技', status: '正常', joined: '昨天 16:20' },
    { user: 'Avery Wu', tenant: 'Seed Intelligence', status: '待审核', joined: '07-13 11:08' },
  ]),
  tenants: page('tenants', '租户管理', '查看平台租户、套餐和成员规模', [
    { label: '全部租户', value: '48' }, { label: '活跃租户', value: '42' }, { label: '待审核', value: '3' },
  ], [{ key: 'tenant', label: '租户' }, { key: 'plan', label: '套餐' }, { key: 'members', label: '成员' }, { key: 'status', label: '状态' }], [
    { tenant: 'NorthEra Studio', plan: '团队版', members: '24', status: '活跃' },
    { tenant: '青岚科技', plan: '专业版', members: '12', status: '活跃' },
    { tenant: 'Seed Intelligence', plan: '试用版', members: '5', status: '待审核' },
  ]),
  account_reviews: page('account_reviews', '账号审核', '处理平台用户和租户的准入申请', [
    { label: '待审核', value: '7' }, { label: '今日通过', value: '12' }, { label: '今日驳回', value: '1' },
  ], [{ key: 'applicant', label: '申请方' }, { key: 'type', label: '类型' }, { key: 'submitted', label: '提交时间' }, { key: 'status', label: '状态' }], [
    { applicant: 'Seed Intelligence', type: '租户认证', submitted: '1 小时前', status: '待审核' },
    { applicant: 'Avery Wu', type: '用户认证', submitted: '2 小时前', status: '待审核' },
  ]),
  model_services: page('model_services', '模型与服务', '查看模型提供商、可用模型和服务状态', [
    { label: '提供商', value: '3' }, { label: '可用模型', value: '12' }, { label: '今日调用', value: '26,481' },
  ], [{ key: 'provider', label: '提供商' }, { key: 'models', label: '模型数量' }, { key: 'latency', label: '平均延迟' }, { key: 'status', label: '状态' }], [
    { provider: 'OpenAI', models: '5', latency: '842 ms', status: '正常' },
    { provider: 'Anthropic', models: '4', latency: '916 ms', status: '正常' },
    { provider: '本地模型', models: '3', latency: '1.2 s', status: '调试中' },
  ]),
  runtime_versions: page('runtime_versions', 'Runtime 版本', '管理桌面端 Runtime 的平台和发布通道', [
    { label: '发布通道', value: '3' }, { label: 'macOS 最新版', value: '0.1.0-dev' }, { label: 'Windows 最新版', value: '待接入' },
  ], [{ key: 'platform', label: '平台' }, { key: 'channel', label: '通道' }, { key: 'version', label: '版本' }, { key: 'status', label: '状态' }], [
    { platform: 'macOS arm64', channel: '开发', version: '0.1.0-dev', status: '联调中' },
    { platform: 'macOS x64', channel: '开发', version: '0.1.0-dev', status: '待验证' },
    { platform: 'Windows x64', channel: '开发', version: '未发布', status: '待接入' },
  ]),
  task_runs: page('task_runs', '任务运行', '查看 Agent 任务的运行状态和耗时', [
    { label: '今日任务', value: '18,642' }, { label: '成功率', value: '99.92%' }, { label: '运行中', value: '36' },
  ], [{ key: 'task', label: '任务' }, { key: 'tenant', label: '租户' }, { key: 'duration', label: '耗时' }, { key: 'status', label: '状态' }], [
    { task: '研究报告生成', tenant: 'NorthEra Studio', duration: '42 s', status: '已完成' },
    { task: '代码审查', tenant: '青岚科技', duration: '18 s', status: '运行中' },
    { task: '数据分析', tenant: 'Seed Intelligence', duration: '1 m 06 s', status: '已完成' },
  ]),
  plans: page('plans', '套餐管理', '查看平台套餐与权益配置', [
    { label: '套餐数量', value: '4' }, { label: '付费租户', value: '31' }, { label: '试用租户', value: '11' },
  ], [{ key: 'plan', label: '套餐' }, { key: 'price', label: '价格' }, { key: 'tenants', label: '租户数' }, { key: 'status', label: '状态' }], [
    { plan: '个人版', price: '¥0', tenants: '6', status: '启用' },
    { plan: '专业版', price: '¥99/月', tenants: '19', status: '启用' },
    { plan: '团队版', price: '¥399/月', tenants: '12', status: '启用' },
  ]),
  orders: page('orders', '订单中心', '查看套餐订单和支付状态', [
    { label: '今日订单', value: '28' }, { label: '已支付', value: '25' }, { label: '待处理', value: '3' },
  ], [{ key: 'order', label: '订单号' }, { key: 'tenant', label: '租户' }, { key: 'amount', label: '金额' }, { key: 'status', label: '状态' }], [
    { order: 'AE202607150028', tenant: 'NorthEra Studio', amount: '¥399.00', status: '已支付' },
    { order: 'AE202607150027', tenant: '青岚科技', amount: '¥99.00', status: '已支付' },
    { order: 'AE202607150026', tenant: 'Seed Intelligence', amount: '¥0.00', status: '试用' },
  ]),
  announcements: page('announcements', '公告运营', '查看面向桌面端用户的运营公告', [
    { label: '全部公告', value: '12' }, { label: '已发布', value: '8' }, { label: '草稿', value: '4' },
  ], [{ key: 'title', label: '公告' }, { key: 'audience', label: '受众' }, { key: 'published', label: '发布时间' }, { key: 'status', label: '状态' }], [
    { title: 'AgentEra 内测欢迎公告', audience: '全部用户', published: '07-15 10:00', status: '已发布' },
    { title: 'Runtime 开发通道说明', audience: '开发者', published: '未发布', status: '草稿' },
  ]),
  audit_logs: page('audit_logs', '审计日志', '查看平台管理员操作记录', [
    { label: '今日事件', value: '186' }, { label: '风险事件', value: '2' }, { label: '管理员', value: '4' },
  ], [{ key: 'actor', label: '操作者' }, { key: 'action', label: '操作' }, { key: 'resource', label: '对象' }, { key: 'time', label: '时间' }], [
    { actor: 'yas', action: '更新', resource: '官方智能体目录', time: '刚刚' },
    { actor: 'publisher@agentera.local', action: '创建草稿', resource: '产品经理', time: '12 分钟前' },
  ]),
  system_settings: page('system_settings', '系统设置', '查看平台基础设置与功能开关', [
    { label: '环境', value: '本地开发' }, { label: '功能开关', value: '8' }, { label: '待接入', value: '5' },
  ], [{ key: 'setting', label: '设置项' }, { key: 'value', label: '当前值' }, { key: 'scope', label: '作用范围' }, { key: 'status', label: '状态' }], [
    { setting: '默认语言', value: '简体中文', scope: '全平台', status: '只读' },
    { setting: 'Runtime 通道', value: '开发', scope: '桌面端', status: '只读' },
    { setting: '用户自建专家', value: '启用', scope: '本地端', status: '只读' },
  ]),
}
```

- [ ] **Step 2: Implement visibility helpers**

Create `src/components/admin/platform/platformAccess.ts`:

```ts
import type { AdminRole } from '../../../access/adminAccess'
import { platformGroupLabels, platformModules } from './platformModules'

export function navGroupsForRole(role: AdminRole) {
  const visible = platformModules.filter((item) => !item.superAdminOnly || role === 'super_admin')

  return Object.entries(platformGroupLabels)
    .map(([key, label]) => ({
      items: visible.filter((item) => item.group === key),
      label,
    }))
    .filter((group) => group.items.length > 0)
}

export function canAccessPlatformViews(role: AdminRole | undefined): boolean {
  return role === 'super_admin'
}
```

- [ ] **Step 3: Verify GREEN**

Run:

```bash
pnpm test:int -- platform-admin.int.spec.ts
```

Expected: all platform registry tests pass.

- [ ] **Step 4: Commit**

```bash
git add src/components/admin/platform/platformModules.ts src/components/admin/platform/platformAccess.ts tests/int/platform-admin.int.spec.ts
git commit -m "feat: define platform admin module registry"
```

## Task 3: Expand icons and the platform navigation

**Files:**

- Modify: `src/components/admin/AdminIcon.tsx`
- Modify: `src/components/admin/AgentEraNav.tsx`
- Modify: `tests/e2e/admin.e2e.spec.ts`

- [ ] **Step 1: Add a failing six-group navigation assertion**

Add to the dashboard E2E test:

```ts
const navigation = page.getByTestId('agentera-nav')
for (const label of ['工作台', '用户与租户', '智能体生态', 'AI 与运行', '商业与运营', '系统管理']) {
  await expect(navigation.getByText(label, { exact: true })).toBeVisible()
}
await expect(navigation.getByRole('link', { name: '租户管理' })).toBeVisible()
await expect(navigation.getByRole('link', { name: 'Runtime 版本' })).toBeVisible()
```

Run `pnpm test:e2e --grep "approved platform overview"` and verify it fails on the missing groups.

- [ ] **Step 2: Add the required line icons**

Extend `AdminIconName` with:

```ts
  | 'announcements'
  | 'approvals'
  | 'audit'
  | 'models'
  | 'orders'
  | 'plans'
  | 'runtime'
  | 'tasks'
  | 'tenants'
```

Add these concrete 24×24 outline entries to `paths`:

```tsx
announcements: <><rect height="14" rx="2" width="18" x="3" y="5" /><path d="M7 9h10M7 13h7M7 17h4" /></>,
approvals: <><path d="M12 3l8 4v5c0 5-3.4 8.3-8 9-4.6-.7-8-4-8-9V7l8-4z" /><path d="M8 12l2.5 2.5L16 9" /></>,
audit: <><rect height="16" rx="2" width="14" x="5" y="4" /><path d="M9 8h6M9 12h6M9 16h4" /></>,
models: <><rect height="4" rx="1" width="10" x="7" y="3" /><rect height="12" rx="2" width="14" x="5" y="9" /><path d="M9 13h6M9 17h4" /></>,
orders: <><rect height="13" rx="2" width="18" x="3" y="6" /><path d="M3 10h18M7 15h4" /></>,
plans: <><path d="M4 7h16v12H4zM7 4h10v3" /><path d="M8 12h8" /></>,
runtime: <><path d="M12 2v6M12 16v6M2 12h6M16 12h6" /><path d="M4.9 4.9l4.2 4.2M14.9 14.9l4.2 4.2M19.1 4.9l-4.2 4.2M9.1 14.9l-4.2 4.2" /></>,
tasks: <><rect height="14" rx="2" width="18" x="3" y="5" /><path d="M8 9l3 3-3 3M13 15h3" /></>,
tenants: <><path d="M4 21V7l8-4 8 4v14M8 21v-5h8v5" /><path d="M8 9h1M15 9h1M8 12h1M15 12h1" /></>,
```

- [ ] **Step 3: Render the registry in the navigation**

Replace the local `groups` constant in `AgentEraNav.tsx` with:

```tsx
const role = user?.role === 'publisher' ? 'publisher' : 'super_admin'
const groups = navGroupsForRole(role)

{groups.map((group) => (
  <section className="ae-nav__group" key={group.label}>
    <div className="ae-nav__group-label">{group.label}</div>
    {group.items.map((item) => {
      const active = isActive(pathname, item.href)
      return (
        <Link
          aria-current={active ? 'page' : undefined}
          className={`ae-nav__link${active ? ' ae-nav__link--active' : ''}`}
          href={item.href}
          key={item.key}
          onClick={() => setNavOpen(false)}
        >
          <AdminIcon name={item.icon} />
          <span>{item.label}</span>
          {item.dataMode === 'demo' && <small className="ae-nav__data-mode">演示</small>}
          {item.dataMode === 'real' && item.key === 'official_agents' && (
            <small className="ae-nav__data-mode ae-nav__data-mode--real">真实</small>
          )}
        </Link>
      )
    })}
  </section>
))}
```

- [ ] **Step 4: Verify navigation GREEN**

Run:

```bash
pnpm test:e2e --grep "approved platform overview"
pnpm lint
```

Expected: the navigation assertion passes and lint exits with zero errors and warnings.

- [ ] **Step 5: Commit**

```bash
git add src/components/admin/AdminIcon.tsx src/components/admin/AgentEraNav.tsx tests/e2e/admin.e2e.spec.ts
git commit -m "feat: expand platform operator navigation"
```

## Task 4: Register and render all demo Admin Views

**Files:**

- Create: `src/components/admin/platform/PlatformModuleView.tsx`
- Modify: `src/payload.config.ts`
- Modify: `src/app/(payload)/admin/importMap.js`
- Test: `tests/e2e/admin.e2e.spec.ts`

- [ ] **Step 1: Add route-by-route failing E2E coverage**

Add a loop for these route-title pairs:

```ts
for (const [path, title] of [
  ['platform-users', '用户管理'],
  ['tenants', '租户管理'],
  ['account-reviews', '账号审核'],
  ['model-services', '模型与服务'],
  ['runtime-versions', 'Runtime 版本'],
  ['task-runs', '任务运行'],
  ['plans', '套餐管理'],
  ['orders', '订单中心'],
  ['announcements', '公告运营'],
  ['audit-logs', '审计日志'],
  ['system-settings', '系统设置'],
] as const) {
  test(`opens demo module ${title}`, async () => {
    await page.goto(`${serverURL}/admin/${path}`)
    await expect(page.getByRole('heading', { level: 1, name: title })).toBeVisible()
    await expect(page.getByTestId('demo-data-notice')).toBeVisible()
  })
}
```

Run `pnpm test:e2e --grep "opens demo module"` and verify RED because the custom routes do not exist.

- [ ] **Step 2: Build the shared module view**

Create `PlatformModuleView.tsx` with this page structure:

- accepts one `PlatformModuleKey` through a local factory;
- redirects non-`super_admin` users to `/admin/collections/agent-templates` using `redirect` from `next/navigation`;
- reads the deterministic module definition from `platformModules.ts`;
- renders `.ae-platform-tabs`, page heading, `data-testid="demo-data-notice"`, summary cards, filter controls, a semantic table, pagination summary, and a disabled button named `接入后端后开放`;
- exports these named components: `PlatformUsersView`, `TenantsView`, `AccountReviewsView`, `ModelServicesView`, `RuntimeVersionsView`, `TaskRunsView`, `PlansView`, `OrdersView`, `AnnouncementsView`, `AuditLogsView`, and `SystemSettingsView`.

The factory signature must be:

```tsx
function createPlatformModuleView(moduleKey: DemoModuleKey) {
  return function PlatformModuleView({ user }: AdminViewServerProps) {
    if (!canAccessPlatformViews((user as Admin | null)?.role)) {
      redirect('/admin/collections/agent-templates')
    }
    return <PlatformModulePage definition={platformModulePages[moduleKey]} />
  }
}
```

`PlatformModulePage` must render the registry without business-side effects:

```tsx
function PlatformModulePage({ definition }: { definition: DemoModulePage }) {
  return (
    <section className="ae-module-page" data-testid={`platform-module-${definition.key}`}>
      <div className="ae-platform-tabs"><span>{definition.title}</span></div>
      <div className="ae-module-content">
        <header className="ae-module-head">
          <div><h1>{definition.title}</h1><p>{definition.description}</p></div>
          <span data-testid="demo-data-notice">演示数据</span>
        </header>
        <div className="ae-module-stats">
          {definition.metrics.map((metric) => <article key={metric.label}><small>{metric.label}</small><strong>{metric.value}</strong></article>)}
        </div>
        <div className="ae-module-panel">
          <div className="ae-module-toolbar">
            <span>⌕ 搜索{definition.title}</span><span>全部状态</span>
            <button disabled type="button">接入后端后开放</button>
          </div>
          <div className="ae-module-table-wrap"><table><thead><tr>{definition.columns.map((column) => <th key={column.key}>{column.label}</th>)}</tr></thead><tbody>
            {definition.rows.map((row, index) => <tr key={`${definition.key}-${index}`}>{definition.columns.map((column) => <td key={column.key}>{row[column.key]}</td>)}</tr>)}
          </tbody></table></div>
          <footer>共 {definition.rows.length} 条 · 当前为只读演示数据</footer>
        </div>
      </div>
    </section>
  )
}
```

- [ ] **Step 3: Register exact Payload custom routes**

Add the custom module views in `payload.config.ts` while keeping the current `beforeDashboard` entry until Task 5:

```ts
views: {
  platformUsers: { Component: '/components/admin/platform/PlatformModuleView#PlatformUsersView', path: '/platform-users' },
  tenants: { Component: '/components/admin/platform/PlatformModuleView#TenantsView', path: '/tenants' },
  accountReviews: { Component: '/components/admin/platform/PlatformModuleView#AccountReviewsView', path: '/account-reviews' },
  modelServices: { Component: '/components/admin/platform/PlatformModuleView#ModelServicesView', path: '/model-services' },
  runtimeVersions: { Component: '/components/admin/platform/PlatformModuleView#RuntimeVersionsView', path: '/runtime-versions' },
  taskRuns: { Component: '/components/admin/platform/PlatformModuleView#TaskRunsView', path: '/task-runs' },
  plans: { Component: '/components/admin/platform/PlatformModuleView#PlansView', path: '/plans' },
  orders: { Component: '/components/admin/platform/PlatformModuleView#OrdersView', path: '/orders' },
  announcements: { Component: '/components/admin/platform/PlatformModuleView#AnnouncementsView', path: '/announcements' },
  auditLogs: { Component: '/components/admin/platform/PlatformModuleView#AuditLogsView', path: '/audit-logs' },
  systemSettings: { Component: '/components/admin/platform/PlatformModuleView#SystemSettingsView', path: '/system-settings' },
},
```

- [ ] **Step 4: Generate imports and verify GREEN**

Run:

```bash
pnpm generate:importmap
pnpm test:e2e --grep "opens demo module|read-only demo platform module"
pnpm lint
```

Expected: all custom routes render the shared read-only structure; lint is clean.

- [ ] **Step 5: Commit**

```bash
git add src/components/admin/platform/PlatformModuleView.tsx src/payload.config.ts src/app/'(payload)'/admin/importMap.js tests/e2e/admin.e2e.spec.ts
git commit -m "feat: add platform demo admin views"
```

## Task 5: Build the approved platform dashboard

**Files:**

- Create: `src/components/admin/platform/PlatformDashboard.tsx`
- Modify: `src/payload.config.ts`
- Modify: `src/app/(payload)/admin/importMap.js`
- Test: `tests/e2e/admin.e2e.spec.ts`

- [ ] **Step 1: Implement one real query with explicit failure semantics**

In `PlatformDashboard.tsx`, call:

```ts
let officialAgentCount: number | null = null

if (!canAccessPlatformViews((user as Admin | null)?.role)) {
  redirect('/admin/collections/agent-templates')
}

try {
  const result = await payload.count({
    collection: 'agent-templates',
    overrideAccess: false,
    user,
  })
  officialAgentCount = result.totalDocs
} catch {
  officialAgentCount = null
}
```

Display `officialAgentCount ?? '—'`; never replace a failed real value with the demo value `6`.

- [ ] **Step 2: Render the exact dashboard regions**

Return one `section` with `data-testid="platform-dashboard"` containing:

- `.ae-platform-tabs` with `平台总览`;
- heading and front-version data notice;
- four metric cards with values `1,286`, `42`, the real agent count, and `18,642`;
- inline SVG chart with `data-testid="platform-trend-chart"` and two labeled paths;
- health list with `data-testid="service-health-list"`;
- recent tenant semantic table with `data-testid="recent-tenant-table"`;
- operations feed with `data-testid="operations-feed"`.

Use the exact visible Chinese copy from the approved HTML and include `演示`, `真实`, or `真实与演示事件分开展示` beside every mixed data region.

- [ ] **Step 3: Replace the default Payload dashboard view**

Remove `beforeDashboard` and add this entry inside `admin.components.views`:

```ts
dashboard: {
  Component: '/components/admin/platform/PlatformDashboard#PlatformDashboard',
},
```

Regenerate the import map:

```bash
pnpm generate:importmap
```

- [ ] **Step 4: Verify dashboard GREEN**

Run:

```bash
pnpm test:e2e --grep "approved platform overview|Soybean-style admin shell"
pnpm lint
```

Expected: both the new dashboard contract and the existing branded shell contract pass.

- [ ] **Step 5: Commit**

```bash
git add src/components/admin/platform/PlatformDashboard.tsx src/payload.config.ts src/app/'(payload)'/admin/importMap.js tests/e2e/admin.e2e.spec.ts
git commit -m "feat: build AgentEra platform dashboard"
```

## Task 6: Reproduce the approved visual system and responsive composition

**Files:**

- Create: `src/app/(payload)/platform-admin.scss`
- Modify: `src/app/(payload)/custom.scss`
- Modify: `tests/e2e/admin.e2e.spec.ts`

- [ ] **Step 1: Add responsive structure assertions**

Extend the narrow desktop E2E test:

```ts
await page.setViewportSize({ width: 900, height: 780 })
await page.goto(`${serverURL}/admin`)
await expect(page.getByTestId('platform-dashboard')).toBeVisible()
expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
await expect(page.getByTestId('platform-trend-chart')).toBeVisible()
await expect(page.getByTestId('service-health-list')).toBeVisible()
```

Run `pnpm test:e2e --grep "narrow desktop"` and confirm RED if the expanded navigation or dashboard overflows.

- [ ] **Step 2: Import the dedicated style layer**

Add at the top of `custom.scss`:

```scss
@use './platform-admin';
```

- [ ] **Step 3: Implement exact layout families**

In `platform-admin.scss`, define styles corresponding to the approved design:

- `.ae-platform-tabs`, `.ae-platform-content`, `.ae-platform-head`, `.ae-demo-notice`;
- `.ae-platform-stats` and `.ae-platform-stat` four-column metric composition;
- `.ae-platform-primary-grid` at `1.7fr / .9fr`;
- `.ae-platform-panel` with white background, `#eef0f5` border, 10px radius, and low shadow;
- `.ae-platform-chart`, chart grid, legends, paths, and x-axis labels;
- `.ae-service-health`, `.ae-status--ok`, `.ae-status--warning`;
- `.ae-platform-bottom-grid` at `1.2fr / 1fr`;
- `.ae-platform-table` and `.ae-operations-feed`;
- `.ae-module-*` page summary, filters, disabled action, semantic table, and footer.

Use the existing tokens from `custom.scss`: `--ae-bg`, `--ae-surface`, `--ae-primary`, `--ae-primary-soft`, `--ae-text`, `--ae-text-muted`, and `--ae-border`.

- [ ] **Step 4: Match the approved navigation density**

Adjust shared nav styles so the expanded groups fit while remaining scrollable:

```scss
.ae-nav__scroll {
  height: calc(100vh - 152px);
  overflow-y: auto;
  scrollbar-width: none;
}

.ae-nav__group-label {
  font-size: 10px;
  padding: 8px 13px 5px;
}

.ae-nav__link {
  min-height: 36px;
  padding: 0 12px;
}

.ae-nav__data-mode {
  margin-left: auto;
  border-radius: 8px;
  background: var(--ae-primary-soft);
  color: var(--ae-primary);
  font-size: 9px;
  padding: 2px 6px;
}
```

- [ ] **Step 5: Implement responsive breakpoints**

At `max-width: 1179px`, collapse the nav to 78px, use two metric columns, and stack primary/bottom grids. At `max-width: 767px`, use one metric column, allow tables to scroll horizontally, and preserve Payload drawer behavior.

- [ ] **Step 6: Verify visual structure GREEN**

Run:

```bash
pnpm test:e2e --grep "approved platform overview|narrow desktop|opens demo module"
pnpm lint
```

Expected: dashboard and demo routes pass at desktop and narrow viewport without horizontal overflow.

- [ ] **Step 7: Commit**

```bash
git add src/app/'(payload)'/platform-admin.scss src/app/'(payload)'/custom.scss tests/e2e/admin.e2e.spec.ts
git commit -m "feat: match approved platform admin design"
```

## Task 7: Complete the user-provided brand icon replacement

**Files:**

- Add: `public/agentera-icon.png`
- Add: `src/app/icon.png`
- Modify: `src/components/admin/AgentEraLogo.tsx`
- Modify: `src/app/(payload)/custom.scss`
- Test: `tests/e2e/admin.e2e.spec.ts`

- [ ] **Step 1: Preserve the already verified failing icon contract**

The existing E2E assertion is:

```ts
await expect(
  page.getByTestId('agentera-brand').getByRole('img', { name: 'AgentEra' }),
).toBeVisible()
```

The assertion was observed failing against the CSS-only brand mark before implementation.

- [ ] **Step 2: Render the optimized image through Next.js**

Keep `AgentEraIcon` as:

```tsx
import Image from 'next/image'

export function AgentEraIcon() {
  return (
    <Image
      alt="AgentEra"
      className="ae-brand-mark"
      height={30}
      src="/agentera-icon.png"
      width={30}
    />
  )
}
```

Remove the legacy `.ae-brand-mark i` drawing rules and style the image with `display: block`, fixed 30px dimensions, and `object-fit: contain`.

- [ ] **Step 3: Verify icon GREEN**

Run:

```bash
pnpm test:e2e --grep "Soybean-style admin shell"
pnpm lint
```

Expected: the accessible brand image is visible and lint produces zero warnings.

- [ ] **Step 4: Commit**

```bash
git add public/agentera-icon.png src/app/icon.png src/components/admin/AgentEraLogo.tsx src/app/'(payload)'/custom.scss tests/e2e/admin.e2e.spec.ts
git commit -m "feat: use AgentEra brand icon"
```

## Task 8: Documentation, full regression, and 1:1 visual fidelity review

**Files:**

- Modify: `README.md`
- Remove: `.tmp/ui-qa/capture.mjs` if present

- [ ] **Step 1: Document real and demo modules**

Add this README section:

```md
## 平台总后台 V1

`/admin` 是 AgentEra 平台运营方使用的系统总后台。官方智能体、智能体分类、技能目录、媒体资源和管理员继续使用 Payload 真实集合，并遵循现有访问规则。

用户、租户、账号审核、模型、Runtime、任务、套餐、订单、公告、审计日志和系统设置页面是确定性的只读演示页面。所有演示指标均在界面中显示“演示数据”，不会写入 SQLite，也不会调用真实外部服务；后续接入真实数据适配器时保持现有路由和页面结构。
```

The local start command and demo credentials remain in their existing README sections.

- `/admin` is the platform-operator dashboard;
- Payload collections are real and writable according to access rules;
- custom platform routes are deterministic, read-only demo pages;
- visible `演示` labels are intentional and removed only when a real data adapter lands;
- local demo credentials and start command remain unchanged.

- [ ] **Step 2: Run full fresh verification**

Run in order:

```bash
pnpm test:int
pnpm test:e2e
pnpm lint
pnpm build
```

Expected: all integration and E2E tests pass, lint exits with zero errors and warnings, and Next.js build exits 0.

- [ ] **Step 3: Capture native-size visual evidence**

Run the admin at `http://localhost:3100/admin`, log in with the local demo administrator, and capture the dashboard at 1440×900. Also capture a 900×780 narrow desktop view.

- [ ] **Step 4: Inspect both design and render images**

Use image inspection on:

- accepted design: `.superpowers/brainstorm/82138-1784102199/content/agentera-platform-admin-v1.html` rendered at 1440×900;
- latest implementation screenshot at 1440×900.

Record and fix mismatches for at least these comparison points:

1. brand icon, sidebar width, group labels, item density, selected state;
2. top header and tab heights;
3. first-row card dimensions, typography, color, and spacing;
4. chart and service-health column ratio;
5. bottom table/feed ratio and row density;
6. background, borders, shadows, radii, and semantic colors;
7. demo/real visible copy and ordering;
8. 900px responsive collapse and overflow.

- [ ] **Step 5: Verify core paths in the browser**

Confirm:

- platform dashboard loads after login;
- official-agent navigation opens the real Payload collection;
- tenant navigation opens the read-only demo view;
- disabled demo action remains disabled;
- current nav item changes on both routes;
- user-provided icon appears in the sidebar and browser tab.

- [ ] **Step 6: Remove temporary QA artifacts and commit**

```bash
git add README.md
git commit -m "docs: explain platform admin v1 data boundaries"
```

- [ ] **Step 7: Inspect final repository state**

Run:

```bash
git status --short --branch
git log --oneline -12
```

Expected: only intentionally ignored local database/runtime artifacts remain; all platform-admin source, tests, docs, and assets are committed on `personal-dev`.
