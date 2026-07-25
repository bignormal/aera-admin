import { describe, expect, it, vi } from 'vitest'

import { createPlatformHandler } from '../../src/platform-api/handler'
import { platformOperations, type PlatformOperation } from '../../src/platform-api/operations'

const registry = platformOperations as Record<string, PlatformOperation>

describe('commerce and operations acceptance contract', () => {
  it.each([
    ['getPaymentDashboard', 'GET', '/admin/payment/dashboard'],
    ['listPaymentPlans', 'GET', '/admin/payment/plans'],
    ['assignSubscription', 'POST', '/admin/subscriptions/assign'],
    ['cancelPaymentOrder', 'POST', '/admin/payment/orders/:id/cancel'],
    ['generateRedeemCodes', 'POST', '/admin/redeem-codes/generate'],
    ['createAnnouncement', 'POST', '/admin/announcements'],
    ['getOpsDashboardOverview', 'GET', '/admin/ops/dashboard/overview'],
    ['createAlertRule', 'POST', '/admin/ops/alert-rules'],
    ['unbanRiskUser', 'POST', '/admin/risk-control/users/:user_id/unban'],
    ['listUsage', 'GET', '/admin/usage'],
    ['createBackup', 'POST', '/admin/backups'],
    ['updateSystemSettings', 'PUT', '/admin/settings'],
  ])('registers %s as %s %s', (name, method, path) => {
    const definition = registry[name]
    expect(definition).toBeDefined()
    expect(definition.method).toBe(method)
    const params = Object.fromEntries((definition.params || []).map((key) => [key, `:${key}`]))
    expect(definition.upstreamPath(params)).toBe(path)
  })

  it.each([
    ['processRefund', 'POST', '?id=1'],
    ['updatePaymentConfig', 'PUT', ''],
    ['updatePaymentProvider', 'PUT', '?id=1'],
    ['restoreBackup', 'POST', '?id=1'],
    ['regenerateAdminAPIKey', 'POST', ''],
    ['performSystemUpdate', 'POST', ''],
  ])(
    'rejects high-risk %s locally without contacting upstream',
    async (operation, method, query) => {
      const upstream = vi.fn()
      const handler = createPlatformHandler(upstream)
      // 未绑定 TOTP 的管理员触发高危操作：428 要求先完成 StepUp。
      const response = await handler({
        headers: new Headers(),
        method,
        payload: { findByID: vi.fn().mockResolvedValue({ id: 1 }) },
        routeParams: { operation },
        url: `http://localhost/api/platform/v1/${operation}${query}`,
        user: { email: 'admin@agentera.local', id: 1, role: 'super_admin' },
      } as never)

      expect(response.status).toBe(428)
      await expect(response.json()).resolves.toMatchObject({
        error: { code: 'TOTP_NOT_ENROLLED' },
      })
      expect(upstream).not.toHaveBeenCalled()
    },
  )
})
