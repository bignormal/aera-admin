import { expect, type Page, test } from '@playwright/test'
import { getPayload } from 'payload'
import config from '../../src/payload.config.js'
import { cleanupTestUser, seedTestUser, testUser } from '../helpers/seedUser'

async function login(page: Page) {
  await page.goto('/admin/login')
  await page.getByTestId('admin-email').fill(testUser.email)
  await page.getByTestId('admin-password').fill(testUser.password)
  await page.getByRole('button', { name: '登录', exact: true }).click()
  await expect(page).toHaveURL(/\/admin\/home/)
}

async function clearRuntimeData() {
  const payload = await getPayload({ config })
  for (const collection of ['runtime-events', 'runtime-commands', 'runtime-releases', 'runtime-instances'] as const) {
    await payload.delete({ collection, overrideAccess: true, where: { id: { exists: true } } })
  }
}

test.beforeAll(async () => {
  await seedTestUser()
  await clearRuntimeData()
})

test.afterAll(async () => {
  await clearRuntimeData()
  await cleanupTestUser()
})

test('keeps Desktop registration absent and labels old Runtime commands as legacy compatibility', async ({ page }) => {
  await login(page)
  await page.goto('/admin/runtime/instances')
  await expect(page.getByRole('heading', { name: '运行实例', exact: true })).toBeVisible()
  await expect(page.getByText(/注册码|registration code/i)).toHaveCount(0)
  await expect(page.getByRole('button', { name: /创建注册码|升级|重启|回滚|配置下发/ })).toHaveCount(0)

  await page.goto('/admin/runtime/commands')
  await expect(page.getByRole('heading', { name: 'Legacy Runtime / Studio 指令记录', exact: true })).toBeVisible()
  await expect(page.getByText(/Cloud Desktop V1 健康检查结果请在实例详情或用户 Desktop 终端中查看/)).toBeVisible()
  await expect(page.getByRole('button', { name: '新增' })).toHaveCount(0)
})

test('registers release metadata without exposing an automatic upgrade action', async ({ page }) => {
  await login(page)
  await page.goto('/admin/runtime/releases')
  await page.getByRole('button', { name: '新增' }).click()
  const dialog = page.getByRole('dialog')
  await dialog
    .locator('.n-form-item')
    .filter({ has: page.getByText('版本', { exact: true }) })
    .getByRole('textbox')
    .fill('1.2.3')
  await dialog.locator('.n-form-item').filter({ hasText: '制品地址' }).getByRole('textbox').fill('https://example.invalid/runtime.tar.gz')
  await dialog.locator('.n-form-item').filter({ hasText: 'SHA-256 校验值' }).getByRole('textbox').fill('a'.repeat(64))
  await dialog.getByRole('button', { name: '保存' }).click()
  await expect(page.getByRole('row').filter({ hasText: '1.2.3' })).toBeVisible()
  await expect(page.getByRole('button', { name: /升级|发布升级/ })).toHaveCount(0)
})
