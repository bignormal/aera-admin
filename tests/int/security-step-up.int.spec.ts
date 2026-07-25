import { generateSync } from 'otplib'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Endpoint, PayloadRequest } from 'payload'

import { securityEndpoints } from '../../src/endpoints/security'
import { openSecret, sealSecret } from '../../src/security/secret-box'
import {
  assertRecentStepUp,
  confirmTOTP,
  enrollTOTP,
  stepUpWindowSeconds,
  verifyStepUp,
} from '../../src/security/step-up'

process.env.PAYLOAD_SECRET = process.env.PAYLOAD_SECRET || 'test-payload-secret-for-step-up'

describe('secret box', () => {
  it('round-trips secrets with authenticated encryption', () => {
    const sealed = sealSecret('JBSWY3DPEHPK3PXP')
    expect(sealed.startsWith('v1:')).toBe(true)
    expect(sealed).not.toContain('JBSWY3DPEHPK3PXP')
    expect(openSecret(sealed)).toBe('JBSWY3DPEHPK3PXP')
  })

  it('rejects tampered ciphertext', () => {
    const sealed = sealSecret('JBSWY3DPEHPK3PXP')
    const parts = sealed.split(':')
    parts[3] = parts[3].slice(0, -2) + 'zz'
    expect(openSecret(parts.join(':'))).toBeUndefined()
    expect(openSecret('v0:a:b:c')).toBeUndefined()
  })
})

type AdminDocument = {
  email: string
  id: number
  stepUpVerifiedAt?: string | null
  totpEnabledAt?: string | null
  totpSecret?: string | null
}

function securityRequest(admin: AdminDocument) {
  const store = { ...admin }
  return {
    headers: new Headers(),
    payload: {
      create: vi.fn().mockResolvedValue({ id: 1 }),
      findByID: vi.fn().mockImplementation(() => Promise.resolve({ ...store })),
      update: vi.fn().mockImplementation(({ data }: { data: Partial<AdminDocument> }) => {
        Object.assign(store, data)
        return Promise.resolve({ ...store })
      }),
    },
    user: { email: admin.email, id: admin.id, role: 'super_admin' },
  } as unknown as PayloadRequest
}

describe('TOTP enrollment and step-up', () => {
  let req: PayloadRequest

  beforeEach(() => {
    req = securityRequest({ email: 'ops@agentera.local', id: 7 })
  })

  it('completes enroll → confirm → step-up with a real TOTP code', async () => {
    const enrollment = await enrollTOTP(req)
    expect(enrollment.status).toBe('pending')
    if (enrollment.status !== 'pending') return
    expect(enrollment.otpauthURL).toContain('otpauth://totp/')
    expect(enrollment.otpauthURL).toContain('Aera%20Admin')

    const wrong = await confirmTOTP(req, '000000')
    expect(wrong).toMatchObject({ errorCode: 'INVALID_CODE', status: 'rejected' })

    const code = generateSync({ secret: enrollment.secret })
    const confirmed = await confirmTOTP(req, code)
    expect(confirmed.status).toBe('enabled')

    const beforeStepUp = await assertRecentStepUp(req)
    expect(beforeStepUp).toMatchObject({ errorCode: 'STEP_UP_REQUIRED', ok: false })

    const verified = await verifyStepUp(req, generateSync({ secret: enrollment.secret }))
    expect(verified.status).toBe('verified')
    if (verified.status === 'verified') {
      expect(verified.expiresInSeconds).toBe(stepUpWindowSeconds)
    }

    const afterStepUp = await assertRecentStepUp(req)
    expect(afterStepUp).toEqual({ ok: true })
  })

  it('stores the TOTP secret only in sealed form', async () => {
    const enrollment = await enrollTOTP(req)
    if (enrollment.status !== 'pending') throw new Error('enrollment rejected')
    const update = (req.payload.update as ReturnType<typeof vi.fn>).mock.calls[0][0]
    expect(update.data.totpSecret.startsWith('v1:')).toBe(true)
    expect(update.data.totpSecret).not.toContain(enrollment.secret)
  })

  it('rejects re-enrollment once TOTP is enabled', async () => {
    const enrollment = await enrollTOTP(req)
    if (enrollment.status !== 'pending') throw new Error('enrollment rejected')
    await confirmTOTP(req, generateSync({ secret: enrollment.secret }))
    const again = await enrollTOTP(req)
    expect(again).toMatchObject({ errorCode: 'TOTP_ALREADY_ENABLED', status: 'rejected' })
  })

  it('expires the step-up window after five minutes', async () => {
    const enrollment = await enrollTOTP(req)
    if (enrollment.status !== 'pending') throw new Error('enrollment rejected')
    await confirmTOTP(req, generateSync({ secret: enrollment.secret }))
    await verifyStepUp(req, generateSync({ secret: enrollment.secret }))

    const future = () => new Date(Date.now() + (stepUpWindowSeconds + 30) * 1000)
    const expired = await assertRecentStepUp(req, future)
    expect(expired).toMatchObject({ errorCode: 'STEP_UP_REQUIRED', ok: false })
  })

  it('reports missing enrollment for unauthenticated or fresh admins', async () => {
    const fresh = await assertRecentStepUp(req)
    expect(fresh).toMatchObject({ errorCode: 'TOTP_NOT_ENROLLED', ok: false })

    const anonymous = await assertRecentStepUp({
      headers: new Headers(),
      payload: { findByID: vi.fn() },
      user: undefined,
    } as unknown as PayloadRequest)
    expect(anonymous).toMatchObject({ errorCode: 'TOTP_NOT_ENROLLED', ok: false })
  })
})

function securityEndpoint(path: string, method: Endpoint['method']) {
  return securityEndpoints.find(endpoint => endpoint.path === path && endpoint.method === method)
}

describe('TOTP reset endpoint', () => {
  it('lets a super administrator reset another admin TOTP and records an audit event', async () => {
    const endpoint = securityEndpoint('/security/totp/reset/:adminId', 'post')
    expect(endpoint).toBeDefined()
    if (!endpoint) throw new Error('reset endpoint missing')

    const update = vi.fn().mockResolvedValue({ id: 9 })
    const create = vi.fn().mockResolvedValue({ id: 1 })
    const response = await endpoint.handler({
      headers: new Headers({ 'x-request-id': 'req_reset_totp' }),
      payload: { create, update },
      routeParams: { adminId: '9' },
      user: { email: 'root@agentera.local', id: 7, role: 'super_admin' },
    } as unknown as PayloadRequest)

    expect(response.status).toBe(200)
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({
        collection: 'admins',
        data: { stepUpVerifiedAt: null, totpEnabledAt: null, totpSecret: null },
        id: '9',
        overrideAccess: true,
      }),
    )
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        collection: 'audit-logs',
        data: expect.objectContaining({
          action: 'security.totp.reset',
          actorId: '7',
          capability: 'admins:write',
          outcome: 'succeeded',
          requestId: 'req_reset_totp',
          resourceId: '9',
          resourceType: 'admins',
        }),
        overrideAccess: true,
      }),
    )
  })

  it('rejects non-super administrators', async () => {
    const endpoint = securityEndpoint('/security/totp/reset/:adminId', 'post')
    expect(endpoint).toBeDefined()
    if (!endpoint) throw new Error('reset endpoint missing')

    const update = vi.fn()
    const response = await endpoint.handler({
      headers: new Headers(),
      payload: { update },
      routeParams: { adminId: '9' },
      user: { email: 'ops@agentera.local', id: 8, role: 'operations_admin' },
    } as unknown as PayloadRequest)

    expect(response.status).toBe(403)
    expect(update).not.toHaveBeenCalled()
  })
})
