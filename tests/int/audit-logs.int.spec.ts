import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { Admins } from '../../src/collections/Admins'
import { AuditLogs } from '../../src/collections/AuditLogs'
import { appendAuditLog, redactAuditValue } from '../../src/domain/audit'
import { getTestPayload } from '../helpers/payload'

const publisher = {
  active: true,
  displayName: '审计测试发布员',
  email: 'audit-publisher@agentera.local',
  password: 'audit-publisher-password',
  role: 'publisher' as const,
}

const superAdmin = {
  active: true,
  displayName: '审计测试超级管理员',
  email: 'audit-super-admin@agentera.local',
  password: 'audit-super-admin-password',
  role: 'super_admin' as const,
}

async function clearAuditFixtures() {
  const payload = await getTestPayload()
  await payload.delete({
    collection: 'audit-logs',
    overrideAccess: true,
    where: { id: { exists: true } },
  })
  await payload.delete({
    collection: 'expert-categories',
    overrideAccess: true,
    where: { key: { equals: 'audit-category' } },
  })
  await payload.delete({
    collection: 'admins',
    overrideAccess: true,
    where: { email: { in: [publisher.email, superAdmin.email] } },
  })
}

describe('audit log domain', () => {
  it('recursively redacts credential-bearing keys without changing ordinary fields', () => {
    expect(
      redactAuditValue({
        email: 'publisher@agentera.local',
        nested: {
          access_token: 'token-value',
          apiKey: 'key-value',
          profile: { displayName: '发布员', passwordHash: 'password-hash' },
        },
      }),
    ).toEqual({
      email: 'publisher@agentera.local',
      nested: {
        access_token: '[REDACTED]',
        apiKey: '[REDACTED]',
        profile: { displayName: '发布员', passwordHash: '[REDACTED]' },
      },
    })
  })

  it('appends an actor, request metadata and redacted before/after values via overrideAccess', async () => {
    const create = vi.fn().mockResolvedValue({ id: 1 })
    const headers = new Headers({
      'user-agent': 'Aera test',
      'x-forwarded-for': '203.0.113.8, 127.0.0.1',
      'x-request-id': 'req_audit_test',
    })

    await appendAuditLog(
      {
        headers,
        payload: { create },
        user: { id: 7, email: publisher.email, role: publisher.role },
      } as never,
      {
        action: 'category.update',
        after: { apiKey: 'secret-key', name: '产品' },
        before: { name: '旧产品' },
        capability: 'content:categories:write',
        outcome: 'succeeded',
        resourceId: '12',
        resourceType: 'expert-categories',
      },
    )

    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        collection: 'audit-logs',
        overrideAccess: true,
        data: expect.objectContaining({
          actorEmail: publisher.email,
          actorId: '7',
          actorRole: publisher.role,
          after: { apiKey: '[REDACTED]', name: '产品' },
          before: { name: '旧产品' },
          ip: '203.0.113.8',
          requestId: 'req_audit_test',
          userAgent: 'Aera test',
        }),
      }),
    )
  })
})

describe('append-only audit collection', () => {
  beforeEach(clearAuditFixtures)
  afterEach(clearAuditFixtures)

  it('allows auditors to read but denies publishers and every direct write', async () => {
    expect(await AuditLogs.access?.read?.({ req: { user: { role: 'auditor' } } } as never)).toBe(
      true,
    )
    expect(await AuditLogs.access?.read?.({ req: { user: { role: 'publisher' } } } as never)).toBe(
      false,
    )
    expect(
      await AuditLogs.access?.create?.({ req: { user: { role: 'super_admin' } } } as never),
    ).toBe(false)
    expect(
      await AuditLogs.access?.update?.({ req: { user: { role: 'super_admin' } } } as never),
    ).toBe(false)
    expect(
      await AuditLogs.access?.delete?.({ req: { user: { role: 'super_admin' } } } as never),
    ).toBe(false)
  })

  it('records an authenticated catalog mutation and keeps audit REST writes blocked', async () => {
    const payload = await getTestPayload()
    const admin = await payload.create({
      collection: 'admins',
      data: publisher,
      overrideAccess: true,
    })
    const category = await payload.create({
      collection: 'expert-categories',
      data: { active: true, key: 'audit-category', name: '审计分类', sortOrder: 1 },
      draft: false,
      overrideAccess: true,
    })

    await payload.update({
      collection: 'expert-categories',
      id: category.id,
      data: { name: '审计分类（已更新）' },
      overrideAccess: false,
      user: admin,
    })

    const logs = await payload.find({
      collection: 'audit-logs',
      overrideAccess: true,
      where: { resourceId: { equals: String(category.id) } },
    })
    expect(logs.docs).toHaveLength(1)
    expect(logs.docs[0]).toMatchObject({
      action: 'expert-categories.update',
      actorEmail: publisher.email,
      capability: 'content:categories:write',
      outcome: 'succeeded',
      resourceType: 'expert-categories',
    })

    await expect(
      payload.create({
        collection: 'audit-logs',
        data: {
          action: 'forbidden.create',
          actorId: String(admin.id),
          actorRole: 'super_admin',
          capability: 'audit:read',
          occurredAt: new Date().toISOString(),
          outcome: 'succeeded',
          requestId: 'req_forbidden',
          resourceType: 'audit-logs',
        },
        overrideAccess: false,
        user: admin,
      }),
    ).rejects.toThrow()
    await expect(
      payload.update({
        collection: 'audit-logs',
        id: logs.docs[0].id,
        data: { action: 'forbidden.update' },
        overrideAccess: false,
        user: admin,
      }),
    ).rejects.toThrow()
    await expect(
      payload.delete({
        collection: 'audit-logs',
        id: logs.docs[0].id,
        overrideAccess: false,
        user: admin,
      }),
    ).rejects.toThrow()
  })

  it('audits login, logout and password changes without storing the password', async () => {
    const payload = await getTestPayload()
    const admin = await payload.create({
      collection: 'admins',
      data: superAdmin,
      overrideAccess: true,
    })

    await payload.login({
      collection: 'admins',
      data: { email: superAdmin.email, password: superAdmin.password },
    })
    await payload.update({
      collection: 'admins',
      id: admin.id,
      data: { password: 'audit-super-admin-new-password' },
      overrideAccess: false,
      user: admin,
    })
    const afterLogout = Admins.hooks?.afterLogout?.[0]
    expect(afterLogout).toBeTypeOf('function')
    await afterLogout?.({
      collection: { slug: 'admins' },
      context: {},
      req: { headers: new Headers(), payload, user: admin },
    } as never)

    const logs = await payload.find({
      collection: 'audit-logs',
      overrideAccess: true,
      sort: 'occurredAt',
      where: { actorEmail: { equals: superAdmin.email } },
    })
    expect(logs.docs.map((doc) => doc.action)).toEqual(
      expect.arrayContaining(['auth.login', 'admins.password.change', 'auth.logout']),
    )
    expect(
      logs.docs
        .filter((doc) => doc.action === 'auth.login' || doc.action === 'auth.logout')
        .map((doc) => doc.capability),
    ).toEqual(['auth:session', 'auth:session'])
    expect(JSON.stringify(logs.docs)).not.toContain(superAdmin.password)
    expect(JSON.stringify(logs.docs)).not.toContain('audit-super-admin-new-password')
  })
})
