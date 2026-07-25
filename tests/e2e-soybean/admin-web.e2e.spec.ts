import { expect, type Page, test } from '@playwright/test'
import {
  cleanupPublisherUser,
  cleanupTestUser,
  publisherUser,
  seedPublisherUser,
  seedTestUser,
  testUser,
} from '../helpers/seedUser'

async function loginViaUi(page: Page, user: { email: string; password: string } = testUser) {
  await page.goto('/admin/login')
  await page.getByTestId('admin-email').fill(user.email)
  await page.getByTestId('admin-password').fill(user.password)
  await page.getByRole('button', { name: '登录', exact: true }).click()
  await expect(page).toHaveURL(/\/admin\/home/)
}

test.beforeAll(async () => {
  await seedTestUser()
  await seedPublisherUser()
})

test.afterAll(async () => {
  await cleanupPublisherUser()
  await cleanupTestUser()
})

test('redirects anonymous administrators to AgentEra login', async ({ page }) => {
  await page.goto('/admin/home')

  await expect(page).toHaveURL(/\/admin\/login/)
  await expect(page.getByTestId('agentera-login-form')).toBeVisible()
})

test('logs in with Payload and renders the Soybean shell', async ({ page }) => {
  await loginViaUi(page)

  await expect(page.getByTestId('agentera-brand')).toContainText('AgentEra 管理系统')
  await expect(page.getByTestId('agentera-admin-shell')).toBeVisible()
  await expect(page.getByText('AgentEra API / 充值业务', { exact: true })).toBeVisible()
  await expect(page.getByText('未配置', { exact: true })).toBeVisible()
  expect(await page.evaluate(() => localStorage.getItem('token'))).toBeNull()
})

test('opens every Soybean content administration page as a super administrator', async ({
  page,
}) => {
  await loginViaUi(page)

  const pages = [
    ['/admin/agents', '官方智能体'],
    ['/admin/categories', '智能体分类'],
    ['/admin/skills', '技能目录'],
    ['/admin/plugins', '官方插件'],
    ['/admin/media', '媒体资源'],
    ['/admin/pets', 'Aera 宠物资源'],
    ['/admin/publishing', '发布中心'],
    ['/admin/audit', '审计中心'],
    ['/admin/admins', '平台管理员'],
  ] as const

  for (const [path, heading] of pages) {
    await page.goto(path)
    await expect(page.getByRole('heading', { name: heading, exact: true })).toBeVisible()
  }
})

test('keeps the Soybean shell inside the mobile viewport', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await loginViaUi(page)

  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390)
})

test('creates, edits and deletes a real category', async ({ page }) => {
  await loginViaUi(page)
  await page.goto('/admin/categories')
  await page.getByTestId('category-create').click()
  await page.getByTestId('category-key').fill('codex-e2e')
  await page.getByTestId('category-name').fill('Codex 测试分类')
  await page.getByTestId('category-sort-order').fill('12')
  await page.getByRole('button', { name: '保存' }).click()

  let row = page.getByRole('row').filter({ hasText: 'Codex 测试分类' })
  await expect(row).toBeVisible()
  await row.getByRole('button', { name: '编辑 Codex 测试分类' }).click()
  await page.getByTestId('category-name').fill('Codex 已更新分类')
  await page.getByRole('button', { name: '保存' }).click()

  row = page.getByRole('row').filter({ hasText: 'Codex 已更新分类' })
  await expect(row).toBeVisible()
  await row.getByRole('button', { name: '删除 Codex 已更新分类' }).click()
  await page.getByRole('dialog').getByRole('button', { name: '删除', exact: true }).click()
  await expect(row).toHaveCount(0)
})

test('allows a publisher to manage categories', async ({ page }) => {
  await loginViaUi(page, publisherUser)
  await page.goto('/admin/categories')
  await expect(page.getByTestId('category-create')).toBeVisible()
})

test('hides administrator management from publishers', async ({ page }) => {
  await loginViaUi(page, publisherUser)

  await expect(page.getByText('平台管理员', { exact: true })).toHaveCount(0)
  await page.goto('/admin/admins')
  await expect(page).not.toHaveURL(/\/admin\/admins$/)
})

test('contains the category table inside the mobile viewport', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await loginViaUi(page)
  await page.goto('/admin/categories')
  await expect(page.getByRole('heading', { name: '智能体分类' })).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390)
})
