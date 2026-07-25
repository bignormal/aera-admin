import { expect, type APIRequestContext, type Page, test } from '@playwright/test'
import { getPayload } from 'payload'
import config from '../../src/payload.config.js'
import { cleanupTestUser, seedTestUser, testUser } from '../helpers/seedUser'

const payloadURL = 'http://127.0.0.1:3101'

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

function heartbeat() {
  return {
    arch: 'arm64',
    capabilities: ['diagnostics.health.read'],
    channels: [{ configured: true, healthy: true, type: 'openai' }],
    metrics: { activeTasks: 1 },
    os: 'darwin',
    resources: {
      codingAgents: [{ changeCount: 2, durationMs: 100, id: 'agent-1', status: 'running', type: 'codex', workspaceHash: 'anonymous-1' }],
      cron: [{ id: 'cron-1', lastResult: 'ok', nextRunAt: '2026-07-17T00:00:00Z', status: 'scheduled' }],
      devices: [{ id: 'device-1', lastSeenAt: '2026-07-16T00:00:00Z', status: 'online', type: 'desktop' }],
      tasks: [{ cost: 0.02, id: 'task-1', model: 'gpt-5', source: 'runtime', status: 'running', tokens: 100 }],
      workflows: [{ id: 'workflow-1', nodeCount: 3, status: 'running', version: '1' }],
    },
    uptimeSeconds: 120,
    version: '1.0.0',
  }
}

async function postDevice(
  request: APIRequestContext,
  path: string,
  body: unknown,
  identity?: { instanceId: string; secret: string },
) {
  return request.post(`${payloadURL}${path}`, {
    data: body,
    headers: identity
      ? { authorization: `Bearer ${identity.secret}`, 'x-agentera-instance-id': identity.instanceId }
      : undefined,
  })
}

test.beforeAll(async () => {
  await seedTestUser()
  await clearRuntimeData()
})

test.afterAll(async () => {
  await clearRuntimeData()
  await cleanupTestUser()
})

test('enrolls an outbound runtime, reports bounded state and completes a health command', async ({ page, request }) => {
  await login(page)
  await page.goto('/admin/runtime/instances')
  await expect(page.getByRole('heading', { name: '运行实例', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: /升级|重启|回滚/ })).toHaveCount(0)

  await page.getByRole('button', { name: '创建注册码' }).click()
  const enrollmentDialog = page.getByRole('dialog')
  await enrollmentDialog
    .locator('.n-form-item')
    .filter({ has: page.getByText('实例名称', { exact: true }) })
    .getByRole('textbox')
    .fill('Runtime 浏览器闭环')
  await enrollmentDialog.getByRole('button', { name: '生成注册码' }).click()
  await expect(enrollmentDialog.getByText('注册码只显示一次')).toBeVisible()
  const enrollmentCode = await enrollmentDialog.getByRole('textbox').inputValue()
  expect(enrollmentCode.length).toBeGreaterThan(40)
  await enrollmentDialog.getByRole('button', { name: '已保存，关闭' }).click()
  await expect(page.getByText(enrollmentCode)).toHaveCount(0)

  const enrollResponse = await postDevice(request, '/api/control/v1/enroll', {
    arch: 'arm64',
    capabilities: ['diagnostics.health.read'],
    deviceId: 'runtime-browser-e2e',
    enrollmentCode,
    instanceType: 'runtime',
    os: 'darwin',
    version: '1.0.0',
  })
  expect(enrollResponse.ok(), `${enrollResponse.status()} ${await enrollResponse.text()}`).toBeTruthy()
  const enrolled = (await enrollResponse.json()).data as { deviceSecret: string; instanceId: string }
  const identity = { instanceId: enrolled.instanceId, secret: enrolled.deviceSecret }

  const rejected = await postDevice(request, '/api/control/v1/heartbeat', { ...heartbeat(), prompt: 'private prompt' }, identity)
  expect(rejected.status()).toBe(400)
  const accepted = await postDevice(request, '/api/control/v1/heartbeat', heartbeat(), identity)
  expect(accepted.ok(), `${accepted.status()} ${await accepted.text()}`).toBeTruthy()

  await page.getByRole('button', { name: '搜索' }).click()
  const row = page.getByRole('row').filter({ hasText: 'Runtime 浏览器闭环' })
  await expect(row.getByText('在线', { exact: true })).toBeVisible()
  await row.getByRole('button', { name: '详情' }).click()
  await expect(page.getByText('健康摘要')).toBeVisible()
  await expect(page.getByText('activeTasks')).toBeVisible()
  await page.getByRole('button', { name: 'close' }).click()

  await row.getByRole('button', { name: '健康检查' }).click()
  await expect(page.getByText('健康检查指令已进入队列')).toBeVisible()
  const claimResponse = await postDevice(request, '/api/control/v1/heartbeat', heartbeat(), identity)
  const command = (await claimResponse.json()).data.command as { id: string; type: string }
  expect(command.type).toBe('health_check')
  const resultResponse = await postDevice(
    request,
    `/api/control/v1/commands/${command.id}/result`,
    { code: 'HEALTHY', state: 'succeeded', summary: { gateway: 'available', version: '1.0.0' } },
    identity,
  )
  expect(resultResponse.ok(), `${resultResponse.status()} ${await resultResponse.text()}`).toBeTruthy()

  await page.goto('/admin/runtime/commands')
  await expect(page.getByRole('row').filter({ hasText: 'succeeded' })).toBeVisible()

  await page.goto('/admin/runtime/operations')
  await expect(page.getByRole('heading', { name: '运行资源', exact: true })).toBeVisible()
  await expect(page.getByRole('row').filter({ hasText: 'task-1' })).toBeVisible()
  await page.getByText('工作流', { exact: true }).click()
  await expect(page.getByRole('row').filter({ hasText: 'workflow-1' })).toBeVisible()

  const payload = await getPayload({ config })
  const instance = await payload.findByID({ collection: 'runtime-instances', id: enrolled.instanceId, overrideAccess: true })
  expect(JSON.stringify(instance)).not.toMatch(/private prompt/i)
  expect(JSON.stringify(instance)).not.toContain(enrolled.deviceSecret)
  await payload.update({
    collection: 'runtime-instances',
    data: { lastHeartbeatAt: '2020-01-01T00:00:00Z' },
    id: enrolled.instanceId,
    overrideAccess: true,
  })
  await page.goto('/admin/runtime/instances')
  await expect(page.getByRole('row').filter({ hasText: 'Runtime 浏览器闭环' }).getByText('离线', { exact: true })).toBeVisible()
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
