import { expect, type Page, type Route, test } from '@playwright/test'
import { cleanupTestUser, seedTestUser, testUser } from '../helpers/seedUser'

function upstream(data: unknown, requestId = 'e2e-commerce-ops') {
  return {
    data: { code: 0, data, message: 'success' },
    meta: { upstreamRequestId: 'e2e-upstream' },
    requestId,
  }
}

function pageData(items: unknown[]) {
  return { items, page: 1, page_size: 10, pages: 1, total: items.length }
}

function operation(route: Route): string {
  return new URL(route.request().url()).pathname.split('/').at(-1) || ''
}

async function login(page: Page) {
  await page.goto('/admin/login')
  await page.getByTestId('admin-email').fill(testUser.email)
  await page.getByTestId('admin-password').fill(testUser.password)
  await page.getByRole('button', { name: '登录', exact: true }).click()
  await expect(page).toHaveURL(/\/admin\/home/)
}

async function installFixture(page: Page) {
  const mutations: Array<{ body: unknown; operation: string }> = []
  const plan = {
    amount: '12.00',
    currency: 'CNY',
    enabled: true,
    id: 1,
    name: '基础充值套餐',
    price: '10.00',
    sort_order: 1,
  }
  const announcement = {
    content: '维护公告正文',
    id: 6,
    priority: 1,
    status: 'draft',
    title: '维护公告',
    type: 'maintenance',
    updated_at: '2026-07-16T00:00:00Z',
  }

  const pages: Record<string, unknown[]> = {
    listAlertEvents: [
      {
        created_at: '2026-07-16T00:00:00Z',
        id: 32,
        message: 'QPS 超限',
        rule_name: 'QPS',
        severity: 'warning',
        status: 'open',
      },
    ],
    listAlertRules: [
      {
        enabled: true,
        id: 31,
        metric: 'qps',
        name: 'QPS 告警',
        operator: '>',
        severity: 'warning',
        threshold: 100,
      },
    ],
    listAnnouncements: [announcement],
    listBackups: [
      {
        created_at: '2026-07-16T00:00:00Z',
        id: 51,
        name: '每日备份',
        size: '1MB',
        status: 'ready',
        type: 'full',
      },
    ],
    listDataBackupJobs: [
      {
        created_at: '2026-07-16T00:00:00Z',
        id: 52,
        progress: 100,
        status: 'completed',
        type: 'scheduled',
      },
    ],
    listPaymentOrders: [
      {
        amount: '10.00',
        created_at: '2026-07-16T00:00:00Z',
        currency: 'CNY',
        id: 3,
        out_trade_no: 'ORDER-1',
        provider: 'alipay',
        status: 'paid',
        user_email: 'member@example.com',
      },
    ],
    listPaymentPlans: [plan],
    listPaymentProviders: [
      {
        enabled: true,
        id: 4,
        name: '支付宝',
        status: 'connected',
        type: 'alipay',
        updated_at: '2026-07-16T00:00:00Z',
      },
    ],
    listRedeemCodes: [
      {
        code: 'AGENTERA-E2E',
        created_at: '2026-07-16T00:00:00Z',
        id: 5,
        status: 'active',
        type: 'balance',
        value: '10.00',
      },
    ],
    listRequestDetails: [
      {
        created_at: '2026-07-16T00:00:00Z',
        id: 21,
        model: 'gpt-5',
        request_id: 'request-21',
        status: 'success',
      },
    ],
    listRequestErrors: [
      {
        created_at: '2026-07-16T00:00:00Z',
        error_message: 'upstream token=secret',
        headers: { authorization: 'Bearer secret' },
        id: 22,
        request_body: 'private prompt',
        request_id: 'request-22',
        status: 'failed',
      },
    ],
    listRiskLogs: [
      {
        action: 'ban',
        created_at: '2026-07-16T00:00:00Z',
        id: 41,
        reason: 'rate limit',
        rule: 'rpm',
        user_id: 9,
      },
    ],
    listSubscriptions: [
      {
        daily_usage_usd: '1.00',
        expires_at: '2026-08-16T00:00:00Z',
        group_id: 2,
        id: 2,
        status: 'active',
        user_id: 9,
      },
    ],
    listSystemLogs: [
      {
        created_at: '2026-07-16T00:00:00Z',
        id: 43,
        level: 'info',
        message: 'system healthy',
        module: 'api',
      },
    ],
    listUpstreamErrors: [],
    listUsage: [
      {
        cost: '0.02',
        created_at: '2026-07-16T00:00:00Z',
        id: 42,
        model: 'gpt-5',
        tokens: 100,
        user_email: 'member@example.com',
      },
    ],
    listUsageCleanupTasks: [],
  }

  await page.route('**/api/platform/v1/*', async (route) => {
    const name = operation(route)
    if (name === 'status') {
      await route.continue()
      return
    }
    const body = route.request().postDataJSON?.()
    if (route.request().method() !== 'GET') mutations.push({ body, operation: name })

    if (name === 'getPaymentDashboard')
      return route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify(upstream({ total_orders: 12, total_revenue: '99.00' })),
      })
    if (name === 'getOpsDashboardOverview')
      return route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify(upstream({ active_users: 8, error_rate: '0.2%', qps: 3 })),
      })
    if (name === 'getOpsRealtimeTraffic')
      return route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify(upstream({ active_requests: 2, qps: 4 })),
      })
    if (name === 'getRiskStatus')
      return route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify(upstream({ banned_users: 1, status: 'healthy' })),
      })
    if (name === 'getRiskConfig')
      return route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify(upstream({ enabled: true, rpm_limit: 60 })),
      })
    if (name === 'getSystemSettings')
      return route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify(upstream({ maintenance_mode: false, site_name: 'Aera' })),
      })
    if (name === 'getSystemVersion')
      return route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify(upstream({ version: '1.0.0' })),
      })
    if (name === 'getAdminAPIKeyStatus')
      return route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify(upstream({ configured: true, masked: '****1234' })),
      })
    if (name === 'getBackupDownloadURL')
      return route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify(upstream({ url: 'https://example.invalid/backup' })),
      })

    if (name === 'updatePaymentPlan') Object.assign(plan, body)
    if (name === 'updateAnnouncement') Object.assign(announcement, body)
    if (name === 'getBackupSchedule')
      return route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify(upstream({ enabled: true, retention_days: 7, cron: '0 2 * * *' })),
      })
    if (pages[name]) {
      const arrayOperations = new Set(['listAlertEvents', 'listAlertRules', 'listPaymentPlans', 'listPaymentProviders'])
      return route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify(upstream(arrayOperations.has(name) ? pages[name] : pageData(pages[name]))),
      })
    }

    return route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify(upstream(body || { success: true })),
    })
  })

  return { mutations }
}

test.beforeAll(seedTestUser)
test.afterAll(cleanupTestUser)

test('operates existing commerce domains through Soybean without high-risk actions', async ({
  page,
}) => {
  const fixture = await installFixture(page)
  await login(page)

  await page.goto('/admin/billing/overview')
  await expect(page.getByRole('heading', { name: '商业总览' })).toBeVisible()
  await expect(page.getByText('total_revenue')).toBeVisible()

  await page.goto('/admin/billing/plans')
  let row = page.getByRole('row').filter({ hasText: '基础充值套餐' })
  await row.getByRole('button', { name: '编辑' }).click()
  const planDialog = page.getByRole('dialog')
  await planDialog
    .locator('.n-form-item')
    .filter({ hasText: '套餐名称' })
    .getByRole('textbox')
    .fill('专业充值套餐')
  await planDialog.getByRole('button', { name: '保存' }).click()
  await expect(page.getByRole('row').filter({ hasText: '专业充值套餐' })).toBeVisible()

  await page.goto('/admin/billing/subscriptions')
  await page
    .getByRole('row')
    .filter({ hasText: 'active' })
    .getByRole('button', { name: '延期' })
    .click()

  await page.goto('/admin/billing/orders')
  row = page.getByRole('row').filter({ hasText: 'ORDER-1' })
  await row.getByRole('button', { name: '取消' }).click()
  await row.getByRole('button', { name: '重试履约' }).click()
  await expect(row.getByRole('button', { name: '退款', exact: true })).toBeVisible()
  await expect(row.getByRole('button', { name: '查退款', exact: true })).toBeVisible()

  await page.goto('/admin/marketing')
  await page.getByRole('button', { name: '新增' }).click()
  const redeemDialog = page.getByRole('dialog')
  await redeemDialog
    .locator('.n-form-item')
    .filter({ hasText: '面值' })
    .getByRole('textbox')
    .fill('20.00')
  await redeemDialog.getByRole('button', { name: '保存' }).click()

  await page.goto('/admin/announcements')
  row = page.getByRole('row').filter({ hasText: '维护公告' })
  await row.getByRole('button', { name: '编辑' }).click()
  await page.getByRole('dialog').getByRole('button', { name: '保存' }).click()

  await page.goto('/admin/billing/providers')
  await expect(page.getByRole('row').filter({ hasText: '支付宝' })).toBeVisible()
  await expect(page.getByRole('button', { name: '编辑' })).toHaveCount(0)

  expect(fixture.mutations.map((item) => item.operation)).toEqual(
    expect.arrayContaining([
      'updatePaymentPlan',
      'extendSubscription',
      'cancelPaymentOrder',
      'retryPaymentOrder',
      'generateRedeemCodes',
      'updateAnnouncement',
    ]),
  )
})

test('opens operations, security and system pages with sanitized data and safe controls', async ({
  page,
}) => {
  const fixture = await installFixture(page)
  await login(page)

  await page.goto('/admin/operations/traffic')
  await expect(page.getByRole('heading', { name: '实时流量' })).toBeVisible()
  await expect(page.getByText('active_requests')).toBeVisible()

  await page.goto('/admin/operations/diagnostics')
  const diagnosticRow = page.getByRole('row').filter({ hasText: 'request-22' })
  await expect(diagnosticRow).toBeVisible()
  await expect(page.getByText('private prompt')).toHaveCount(0)
  await expect(page.getByText('Bearer secret')).toHaveCount(0)
  await diagnosticRow.getByRole('button', { name: '标记解决' }).click()

  await page.goto('/admin/operations/alerts')
  await page.getByText('告警事件', { exact: true }).last().click()
  await page
    .getByRole('row')
    .filter({ hasText: 'QPS 超限' })
    .getByRole('button', { name: '标记解决' })
    .click()

  await page.goto('/admin/security/risk')
  await page.getByPlaceholder('输入用户 ID').fill('9')
  await page.getByRole('button', { name: '解除限制' }).click()

  await page.goto('/admin/system/data')
  await expect(page.getByRole('row').filter({ hasText: '每日备份' })).toBeVisible()
  await expect(page.getByRole('button', { name: '恢复', exact: true })).toBeVisible()

  await page.goto('/admin/system/settings')
  await expect(page.getByRole('heading', { name: '系统设置' })).toBeVisible()
  await expect(page.getByRole('button', { name: '执行更新' })).toBeVisible()
  await expect(page.getByRole('button', { name: '回滚' })).toBeVisible()
  await expect(page.getByRole('button', { name: '重启' })).toBeVisible()
  await expect(page.getByRole('button', { name: '重新生成' })).toBeVisible()
  await expect(page.getByRole('button', { name: '删除' })).toBeVisible()
  await page.getByRole('button', { name: '保存设置' }).click()

  expect(fixture.mutations.map((item) => item.operation)).toEqual(
    expect.arrayContaining([
      'resolveRequestError',
      'updateAlertEventStatus',
      'unbanRiskUser',
      'updateSystemSettings',
    ]),
  )
})
