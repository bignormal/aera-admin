import { expect, test } from '@playwright/test'

const email = process.env.AGENTERA_ADMIN_LIVE_EMAIL
const password = process.env.AGENTERA_ADMIN_LIVE_PASSWORD
if (!email || !password) throw new Error('Live browser tests require admin live credentials')

test('reads real platform domains through Soybean and Payload', async ({ page }) => {
  const platformRequests: Array<{ method: string; path: string }> = []
  page.on('request', (request) => {
    const path = new URL(request.url()).pathname
    if (path.startsWith('/api/platform/v1/')) {
      platformRequests.push({ method: request.method(), path })
    }
  })

  await page.goto('/admin/login')
  await page.getByTestId('admin-email').fill(email)
  await page.getByTestId('admin-password').fill(password)
  await page.getByRole('button', { name: '登录', exact: true }).click()
  await expect(page).toHaveURL(/\/admin\/home/)
  await expect(page.getByText('健康', { exact: true }).first()).toBeVisible()

  await page.getByTestId('validate-platform-readiness').click()
  const readinessTable = page.locator('table').filter({ hasText: '平台用户' })
  await expect(readinessTable.locator('tbody tr')).toHaveCount(13)
  await expect(readinessTable.getByText('不可用', { exact: true })).toHaveCount(0)

  const pages = [
    ['/admin/users', '平台用户'],
    ['/admin/ai-resources/accounts', '上游账号'],
    ['/admin/ai-resources/groups', '模型分组'],
    ['/admin/billing/orders', '订单中心'],
    ['/admin/operations/overview', '运营总览'],
    ['/admin/security/risk', '风控中心'],
    ['/admin/system/settings', '系统设置'],
    ['/admin/system/data', '数据与备份'],
  ] as const

  for (const [path, heading] of pages) {
    await page.goto(path)
    await expect(page.getByRole('heading', { name: heading, exact: true })).toBeVisible()
    await expect(page.getByText('服务不可用', { exact: true })).toHaveCount(0)
  }

  expect(platformRequests.map((request) => request.path)).toEqual(
    expect.arrayContaining([
      '/api/platform/v1/status',
      '/api/platform/v1/readiness',
      '/api/platform/v1/listUsers',
      '/api/platform/v1/listAccounts',
      '/api/platform/v1/listGroups',
      '/api/platform/v1/listPaymentOrders',
      '/api/platform/v1/getOpsDashboardOverview',
      '/api/platform/v1/getRiskStatus',
      '/api/platform/v1/getSystemSettings',
      '/api/platform/v1/listBackups',
    ]),
  )
  expect(platformRequests.every((request) => request.method === 'GET')).toBe(true)
})
