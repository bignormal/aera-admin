import { expect, type Page, test } from '@playwright/test'

import { login } from '../helpers/login'
import { cleanupTestUser, seedTestUser, testUser } from '../helpers/seedUser'

const serverURL = 'http://localhost:3100'

test.describe('Aera Admin', () => {
  let page: Page

  test.beforeAll(async ({ browser }) => {
    await seedTestUser()
    const context = await browser.newContext()
    page = await context.newPage()
    await login({ page, serverURL, user: testUser })
  })

  test.afterAll(async () => cleanupTestUser())

  for (const [path, title] of [
    ['agent-templates', '官方智能体'],
    ['expert-categories', '智能体分类'],
    ['skill-catalog', '技能目录'],
    ['media', '媒体资源'],
    ['integration-settings', '服务集成状态'],
    ['audit-logs', '审计日志'],
    ['runtime-releases', 'Runtime 版本'],
  ] as const) {
    test(`opens ${title}`, async () => {
      await page.goto(`${serverURL}/admin/collections/${path}`)
      await expect(page.getByRole('heading', { name: title })).toBeVisible()
    })
  }

  test('renders the current Payload catalog and operations navigation', async () => {
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.goto(`${serverURL}/admin`)

    const navigation = page.getByRole('navigation')
    await expect(navigation).toBeVisible()
    await expect(navigation.getByRole('link', { name: '官方智能体', exact: true })).toBeVisible()
    await expect(navigation.getByRole('link', { name: '服务集成状态', exact: true })).toBeVisible()
    await expect(navigation.getByRole('link', { name: 'Runtime 版本', exact: true })).toBeVisible()
  })

  test('renders real official-agent overview data', async () => {
    await page.goto(`${serverURL}/admin/collections/agent-templates`)

    const overview = page.getByTestId('agent-list-overview')
    await expect(overview).toBeVisible()
    await expect(overview.getByText('全部智能体')).toBeVisible()
    await expect(overview.getByText('草稿')).toBeVisible()
  })

  test('keeps the admin shell usable in a narrow desktop viewport', async () => {
    await page.setViewportSize({ width: 900, height: 780 })
    await page.goto(`${serverURL}/admin/collections/agent-templates`)

    await expect(
      page.getByTestId('agent-list-overview').getByRole('heading', {
        level: 1,
        name: '官方智能体',
      }),
    ).toBeVisible()
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true)
  })
})
