import { describe, expect, it, vi } from 'vitest'

import { createPlatformHandler } from '../../src/platform-api/handler'
import { normalizeMoney, normalizePagination, sanitizePaymentProvider } from '../../src/platform-api/billing'
import { platformOperations, type PlatformOperation } from '../../src/platform-api/operations'

function operation(name: string): PlatformOperation {
  const value = (platformOperations as Record<string, PlatformOperation>)[name]
  expect(value, `${name} must be registered`).toBeDefined()
  return value
}

describe('commercial platform operations', () => {
  it('maps the existing payment routes and locks refund execution', () => {
    expect(operation('listPaymentOrders').upstreamPath({})).toBe('/admin/payment/orders')
    expect(operation('listPaymentPlans').upstreamPath({})).toBe('/admin/payment/plans')
    expect(operation('listPaymentProviders').upstreamPath({})).toBe('/admin/payment/providers')
    expect(operation('processRefund')).toMatchObject({
      capability: 'billing:order:refund',
      requiresReauthentication: true,
      risk: 'high',
    })
  })

  it('normalizes money without browser-style binary float calculations', () => {
    expect(normalizeMoney('12.3400')).toBe('12.3400')
    expect(normalizeMoney(12.5)).toBe('12.5')
    expect(() => normalizeMoney(Number.NaN)).toThrow()
  })

  it('normalizes common pagination envelopes', () => {
    expect(
      normalizePagination<{ id: number }>({
        items: [{ id: 1 }],
        page: 2,
        page_size: 20,
        total: 41,
      }),
    ).toEqual({ data: [{ id: 1 }], meta: { page: 2, pageSize: 20, total: 41 } })
  })

  it('masks provider credentials and never returns ciphertext', () => {
    const value = sanitizePaymentProvider({
      id: 1,
      name: 'Stripe',
      api_key: 'ciphertext-value-7A9F',
      config: { webhook_secret: 'webhook-ciphertext-1234' },
    })
    const serialized = JSON.stringify(value)
    expect(serialized).not.toContain('ciphertext-value')
    expect(serialized).not.toContain('webhook-ciphertext')
    expect(value).toMatchObject({ api_key: { configured: true, masked: '****7A9F' } })
  })

  it('rejects high-risk operations before any upstream request', async () => {
    const upstream = vi.fn()
    const handler = createPlatformHandler(upstream)
    // 未绑定 TOTP 时高危操作被 428 拦截，不触达上游。
    const response = await handler({
      headers: new Headers(),
      method: 'POST',
      payload: { findByID: vi.fn().mockResolvedValue({ id: 1 }) },
      routeParams: { operation: 'processRefund' },
      url: 'http://localhost/api/platform/v1/processRefund?id=1',
      user: { id: 1, role: 'super_admin' },
    } as never)

    expect(response.status).toBe(428)
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'TOTP_NOT_ENROLLED' },
    })
    expect(upstream).not.toHaveBeenCalled()
  })
})
