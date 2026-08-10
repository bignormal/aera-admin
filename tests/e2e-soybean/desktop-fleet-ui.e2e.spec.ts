import { expect, type Page, type Route, test } from '@playwright/test'

import {
  cleanupTestUser,
  seedTestUser,
  testUser,
} from '../helpers/seedUser'

const onlineDeviceID = '11111111-1111-4111-8111-111111111111'
const offlineDeviceID = '22222222-2222-4222-8222-222222222222'
const userID = '33333333-3333-4333-8333-333333333333'
const adminID = '44444444-4444-4444-8444-444444444444'

function envelope(data: unknown, requestId = 'desktop-fleet-ui') {
  return { data, meta: { upstreamRequestId: 'cloud-desktop-fixture' }, requestId }
}

function instance(
  deviceID: string,
  displayName: string,
  effectiveStatus: 'online' | 'offline',
) {
  return {
    arch: 'arm64',
    capabilities: ['diagnostics.health.read'],
    client_version: '1.0.0',
    created_at: '2026-08-11T00:00:00.000Z',
    device_id: deviceID,
    display_name: displayName,
    effective_status: effectiveStatus,
    health_status: effectiveStatus === 'online' ? 'healthy' : 'unknown',
    last_heartbeat_at: '2026-08-11T00:00:00.000Z',
    platform: 'darwin',
    server_time: '2026-08-11T00:00:01.000Z',
    updated_at: '2026-08-11T00:00:01.000Z',
    user_id: userID,
  }
}

function command(state: 'queued' | 'running' | 'succeeded') {
  return {
    command_id: '55555555-5555-4555-8555-555555555555',
    completed_at: state === 'succeeded' ? '2026-08-11T00:00:03.000Z' : undefined,
    created_at: '2026-08-11T00:00:01.000Z',
    created_by_admin_id: adminID,
    device_id: onlineDeviceID,
    expires_at: '2026-08-11T00:10:01.000Z',
    request_id: 'cloud-health-request',
    required_capability: 'diagnostics.health.read',
    result_code: state === 'succeeded' ? 'HEALTHY' : undefined,
    server_time: '2026-08-11T00:00:03.000Z',
    started_at: state === 'queued' ? undefined : '2026-08-11T00:00:02.000Z',
    state,
    type: 'health_check',
    updated_at: '2026-08-11T00:00:03.000Z',
  }
}

function operation(route: Route) {
  return new URL(route.request().url()).pathname.split('/').at(-1) || ''
}

async function login(page: Page) {
  await page.goto('/admin/login')
  await page.getByTestId('admin-email').fill(testUser.email)
  await page.getByTestId('admin-password').fill(testUser.password)
  await page.getByRole('button', { name: '登录', exact: true }).click()
  await expect(page).toHaveURL(/\/admin\/home/)
}

test.beforeAll(seedTestUser)
test.afterAll(cleanupTestUser)

test('lists real-user Desktop states and completes the only allowed health action', async ({ page }) => {
  let commandReads = 0
  let idempotencyKey = ''
  await page.route('**/api/cloud/v1/*', async route => {
    switch (operation(route)) {
      case 'listDesktopControlInstances':
        return route.fulfill({
          contentType: 'application/json',
          body: JSON.stringify(
            envelope({
              items: [
                instance(onlineDeviceID, 'Fleet Mac Online', 'online'),
                instance(offlineDeviceID, 'Fleet Mac Offline', 'offline'),
              ],
              server_time: '2026-08-11T00:00:01.000Z',
              total: 2,
            }),
          ),
        })
      case 'createDesktopHealthCheck':
        idempotencyKey = route.request().headers()['idempotency-key'] || ''
        return route.fulfill({
          contentType: 'application/json',
          body: JSON.stringify(envelope(command('queued'))),
        })
      case 'getDesktopControlCommand':
        commandReads += 1
        return route.fulfill({
          contentType: 'application/json',
          body: JSON.stringify(envelope(command(commandReads === 1 ? 'running' : 'succeeded'))),
        })
      default:
        return route.fulfill({
          status: 404,
          contentType: 'application/json',
          body: JSON.stringify({ error: { code: 'NOT_FOUND', message: 'fixture route missing' } }),
        })
    }
  })

  await login(page)
  await page.goto('/admin/runtime/instances')

  await expect(page.getByRole('heading', { name: '运行实例', exact: true })).toBeVisible()
  const onlineRow = page.getByRole('row').filter({ hasText: 'Fleet Mac Online' })
  const offlineRow = page.getByRole('row').filter({ hasText: 'Fleet Mac Offline' })
  await expect(onlineRow.getByTestId('desktop-online-status')).toHaveText('在线')
  await expect(offlineRow.getByTestId('desktop-online-status')).toHaveText('离线')
  await expect(offlineRow.getByRole('button', { name: '健康检查' })).toHaveCount(0)
  await expect(page.getByText(/注册码|registration code/i)).toHaveCount(0)
  await expect(page.getByRole('button', { name: /创建注册码|重启|升级|回滚|配置下发/ })).toHaveCount(0)

  await onlineRow.getByRole('button', { name: '健康检查' }).click()
  await expect(page.getByText(/健康检查已进入队列/)).toBeVisible()
  await expect(page.getByTestId('desktop-health-result')).toContainText('执行中', { timeout: 5_000 })
  await expect(page.getByTestId('desktop-health-result')).toContainText('已完成 · HEALTHY', {
    timeout: 5_000,
  })
  expect(idempotencyKey).toMatch(/^[0-9a-f-]{36}$/i)
  expect(commandReads).toBe(2)
})

test('shows the Cloud request ID when the Desktop fleet backend is unavailable', async ({ page }) => {
  await page.route('**/api/cloud/v1/*', route =>
    route.fulfill({
      status: 503,
      contentType: 'application/json',
      body: JSON.stringify({
        error: { code: 'UPSTREAM_NETWORK_ERROR', message: 'Cloud 暂时不可用' },
        requestId: 'desktop-fleet-outage-request',
      }),
    }),
  )

  await login(page)
  await page.goto('/admin/runtime/instances')
  await expect(page.getByText('服务不可用', { exact: true })).toBeVisible()
  await expect(page.getByText(/desktop-fleet-outage-request/)).toBeVisible()
  await expect(page.getByText(/注册码|registration code/i)).toHaveCount(0)
})

test('renders a permission denial without exposing a command control', async ({ page }) => {
  await page.route('**/api/cloud/v1/*', route =>
    route.fulfill({
      status: 403,
      contentType: 'application/json',
      body: JSON.stringify({
        error: { code: 'FORBIDDEN', message: '当前角色无权执行该操作。' },
        requestId: 'desktop-fleet-forbidden',
      }),
    }),
  )

  await login(page)
  await page.goto('/admin/runtime/instances')
  await expect(page.getByText('无权访问', { exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: '健康检查' })).toHaveCount(0)
})
