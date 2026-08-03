import { expect, type Page, type Route, test } from '@playwright/test'
import {
  auditorUser,
  cleanupAuditorUser,
  cleanupPublisherUser,
  cleanupTestUser,
  publisherUser,
  seedAuditorUser,
  seedPublisherUser,
  seedTestUser,
  testUser,
} from '../helpers/seedUser'

const platformUser = {
  allowed_groups: null,
  balance: 18.5,
  balance_notify_enabled: false,
  balance_notify_extra_emails: [],
  balance_notify_threshold: null,
  concurrency: 3,
  created_at: '2026-07-16T00:00:00Z',
  current_concurrency: 1,
  email: 'member@example.com',
  id: 7,
  notes: 'E2E user',
  role: 'user',
  rpm_limit: 60,
  status: 'active',
  updated_at: '2026-07-16T00:00:00Z',
  username: 'member',
}

function upstream(data: unknown, requestId = 'e2e-platform-request') {
  return {
    data: { code: 0, data, message: 'success' },
    meta: { upstreamRequestId: 'e2e-upstream-request' },
    requestId,
  }
}

async function loginViaUI(page: Page, user: { email: string; password: string } = testUser) {
  await page.goto('/admin/login')
  await page.getByTestId('admin-email').fill(user.email)
  await page.getByTestId('admin-password').fill(user.password)
  await page.getByRole('button', { name: '登录', exact: true }).click()
  await expect(page).toHaveURL(/\/admin\/home/)
}

function operation(route: Route): string {
  return new URL(route.request().url()).pathname.split('/').at(-1) || ''
}

async function installPlatformFixture(page: Page) {
  const user = { ...platformUser }
  const mutations: Array<{ body: unknown; operation: string }> = []

  await page.route('**/api/platform/v1/*', async (route) => {
    const name = operation(route)
    if (name === 'status') {
      await route.continue()
      return
    }
    const body = route.request().postDataJSON?.()
    if (route.request().method() !== 'GET') mutations.push({ body, operation: name })

    if (name === 'listUsers') {
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify(
          upstream({ items: [user], page: 1, page_size: 20, pages: 1, total: 1 }),
        ),
      })
      return
    }
    if (name === 'getUser') {
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify(upstream(user)) })
      return
    }
    if (name === 'updateUser') {
      Object.assign(user, body)
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify(upstream(user)) })
      return
    }
    if (name === 'updateUserBalance') {
      const change = body as { balance: number; operation: 'add' | 'set' | 'subtract' }
      if (change.operation === 'add') user.balance += change.balance
      if (change.operation === 'subtract') user.balance -= change.balance
      if (change.operation === 'set') user.balance = change.balance
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify(upstream(user)) })
      return
    }
    if (name === 'listGroups') {
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify(
          upstream({
            items: [
              {
                id: 3,
                name: '默认模型分组',
                platform: 'openai',
                rate_multiplier: 1,
                rpm_limit: 0,
                status: 'active',
              },
            ],
            page: 1,
            page_size: 10,
            pages: 1,
            total: 1,
          }),
        ),
      })
      return
    }

    const emptyPageOperations = new Set([
      'listUserAPIKeys',
      'getUserBalanceHistory',
      'listUserSubscriptions',
    ])
    const data = emptyPageOperations.has(name)
      ? { items: [], page: 1, page_size: 20, pages: 1, total: 0 }
      : {}
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify(upstream(data)) })
  })

  return { mutations, user }
}

test.beforeAll(async () => {
  await seedTestUser()
  await seedPublisherUser()
  await seedAuditorUser()
})

test.afterAll(async () => {
  await cleanupAuditorUser()
  await cleanupPublisherUser()
  await cleanupTestUser()
})

test('manages users and AI groups without exposing the upstream admin key', async ({ page }) => {
  const fixture = await installPlatformFixture(page)
  await loginViaUI(page)
  await page.goto('/admin/users')

  let row = page.getByRole('row').filter({ hasText: platformUser.email })
  await expect(row).toBeVisible()
  await row.getByRole('button', { name: '详情' }).click()
  await page.getByText('API Keys', { exact: true }).click()
  await expect(page.getByText('密钥原文不会由管理后台请求或展示。')).toBeVisible()
  await page.getByRole('button', { name: 'close' }).click()

  row = page.getByRole('row').filter({ hasText: platformUser.email })
  await row.getByRole('button', { name: '调余额' }).click()
  await page.getByRole('dialog').getByRole('textbox', { name: '请输入' }).fill('5')
  await page.getByPlaceholder('将写入平台审计日志').fill('E2E 人工补偿')
  await page.getByRole('button', { name: '确认调整' }).click()
  await expect(row).toContainText('23.5000')

  await row.getByRole('button', { name: '停用' }).click()
  await expect(row).toContainText('停用')
  expect(fixture.mutations).toEqual(
    expect.arrayContaining([
      {
        operation: 'updateUserBalance',
        body: { balance: 5, notes: 'E2E 人工补偿', operation: 'add' },
      },
      { operation: 'updateUser', body: { status: 'disabled' } },
    ]),
  )

  await page.goto('/admin/ai-resources/groups')
  await expect(page.getByRole('row').filter({ hasText: '默认模型分组' })).toBeVisible()
  expect(await page.evaluate(() => JSON.stringify(localStorage))).not.toContain('admin-key')
})

test('renders user JSON details with a configured code highlighter', async ({ page }) => {
  const codeErrors: string[] = []
  page.on('console', (message) => {
    if (message.type() === 'error' && message.text().includes('[naive/code]')) {
      codeErrors.push(message.text())
    }
  })

  await installPlatformFixture(page)
  await loginViaUI(page)
  await page.goto('/admin/users')
  await page
    .getByRole('row')
    .filter({ hasText: platformUser.email })
    .getByRole('button', { name: '详情' })
    .click()
  await expect(page.locator('.n-code').first()).toBeVisible()

  expect(codeErrors).toEqual([])
})

test('keeps auditor pages read-only and rejects publisher platform routes', async ({ page }) => {
  await installPlatformFixture(page)
  await loginViaUI(page, auditorUser)
  await page.goto('/admin/users')
  const row = page.getByRole('row').filter({ hasText: platformUser.email })
  await expect(row).toBeVisible()
  await expect(row.getByRole('button', { name: '编辑' })).toHaveCount(0)
  await expect(row.getByRole('button', { name: '调余额' })).toHaveCount(0)

  await page.context().clearCookies()
  await loginViaUI(page, publisherUser)
  await page.goto('/admin/users')
  await expect(page).not.toHaveURL(/\/admin\/users$/)
  await page.goto('/admin/ai-resources/groups')
  await expect(page).not.toHaveURL(/\/admin\/ai-resources\/groups$/)
})

test('shows a stable unavailable state when the upstream is not configured', async ({ page }) => {
  await loginViaUI(page)
  await page.goto('/admin/users')
  await expect(page.getByText('服务不可用', { exact: true })).toBeVisible()
})
