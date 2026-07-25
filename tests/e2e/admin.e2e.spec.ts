import { expect, type Page, test } from '@playwright/test'

import { login } from '../helpers/login'
import { cleanupTestUser, seedTestUser, testUser } from '../helpers/seedUser'

const serverURL = 'http://localhost:3100'

test.describe('AgentEra Admin', () => {
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
  ] as const) {
    test(`opens ${title}`, async () => {
      await page.goto(`${serverURL}/admin/collections/${path}`)
      await expect(page.getByRole('heading', { name: title })).toBeVisible()
    })
  }

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

  test('renders the AgentEra Soybean-style admin shell', async () => {
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.goto(`${serverURL}/admin`)

    await expect(page.getByTestId('agentera-brand')).toContainText('AgentEra 管理系统')
    await expect(page.getByTestId('agentera-brand').getByRole('img', { name: 'AgentEra' })).toBeVisible()
    const topbar = page.getByTestId('agentera-topbar')
    await expect(topbar).toBeVisible()
    const openMenu = topbar.getByRole('button', { name: '打开 菜单' })
    if (await openMenu.isVisible()) await openMenu.click()
    await expect(topbar.getByText('工作台', { exact: true })).toBeVisible()
    await expect(topbar.getByText('平台总览', { exact: true })).toBeVisible()
    await expect(topbar.getByRole('button', { name: '搜索后台功能' })).toBeDisabled()
    await expect(topbar.getByText('平台超级管理员', { exact: true })).toBeVisible()
    const navigation = page.getByTestId('agentera-nav')
    await expect(navigation).toBeVisible()
    await expect(navigation.getByRole('link', { name: '官方智能体' })).toBeVisible()
    await expect(page.getByTestId('agentera-dashboard-overview')).toBeVisible()
  })

  test('renders platform operator navigation', async () => {
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.goto(`${serverURL}/admin`)

    const topbar = page.getByTestId('agentera-topbar')
    await expect(topbar).toBeVisible()
    const openMenu = topbar.getByRole('button', { name: '打开 菜单' })
    if (await openMenu.isVisible()) await openMenu.click()
    const navigation = page.getByTestId('agentera-nav')
    for (const label of [
      '工作台',
      '用户与租户',
      '智能体生态',
      'AI 与运行',
      '商业与运营',
      '系统管理',
    ]) {
      await expect(navigation.getByText(label, { exact: true })).toBeVisible()
    }
    await expect(navigation.getByRole('link', { name: '租户管理' })).toBeVisible()
    await expect(navigation.getByRole('link', { name: 'Runtime 版本' })).toBeVisible()
  })

  test('renders the approved platform overview', async () => {
    await page.goto(`${serverURL}/admin`)

    const dashboard = page.getByTestId('platform-dashboard')
    await expect(
      dashboard.getByRole('heading', { level: 1, name: 'AgentEra 平台总览' }),
    ).toBeVisible()
    await expect(dashboard.getByText('注册用户 · 演示')).toBeVisible()
    await expect(dashboard.getByText('官方智能体 · 真实')).toBeVisible()
    await expect(dashboard.getByTestId('platform-trend-chart')).toBeVisible()
    await expect(dashboard.getByTestId('service-health-list')).toBeVisible()
    await expect(dashboard.getByTestId('recent-tenant-table')).toBeVisible()
    await expect(dashboard.getByTestId('operations-feed')).toBeVisible()
  })

  test('uses the approved platform dashboard grid composition', async () => {
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.goto(`${serverURL}/admin`)

    const dashboard = page.getByTestId('platform-dashboard')
    await expect(dashboard.locator('.ae-platform-stats')).toHaveCSS('display', 'grid')
    await expect(dashboard.locator('.ae-platform-primary-grid')).toHaveCSS('display', 'grid')
    await expect(dashboard.locator('.ae-platform-bottom-grid')).toHaveCSS('display', 'grid')
  })

  test('switches the platform trend range locally', async () => {
    await page.goto(`${serverURL}/admin`)

    const trend = page.getByTestId('platform-trend-chart')
    const thirtyDays = trend.getByRole('button', { name: '近 30 天' })

    await expect(thirtyDays).toHaveAttribute('aria-pressed', 'false')
    await thirtyDays.click()
    await expect(thirtyDays).toHaveAttribute('aria-pressed', 'true')
    await expect(trend.getByRole('img', { name: '近三十天平台活跃趋势' })).toBeVisible()
  })

  test('opens a read-only demo platform module', async () => {
    await page.goto(`${serverURL}/admin/tenants`)

    await expect(page.getByTestId('agentera-topbar')).toBeVisible()
    await expect(page.getByTestId('agentera-nav')).toBeVisible()
    await expect(page.getByRole('heading', { level: 1, name: '租户管理' })).toBeVisible()
    await expect(page.getByText('演示数据', { exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: '接入后端后开放' })).toBeDisabled()
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

    await expect(page.getByTestId('agentera-nav')).toBeVisible()
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

  test('keeps the platform dashboard usable in a narrow desktop viewport', async () => {
    await page.setViewportSize({ width: 900, height: 780 })
    await page.goto(`${serverURL}/admin`)

    await expect(page.getByTestId('platform-dashboard')).toBeVisible()
    await expect(page.getByTestId('platform-trend-chart')).toBeVisible()
    await expect(page.getByTestId('service-health-list')).toBeVisible()
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true)
  })
})
