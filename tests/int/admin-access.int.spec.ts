import { describe, expect, it, vi } from 'vitest'

import {
  canBootstrapOrManageAdmins,
  canManageCatalog,
  canReadAdmin,
  isSuperAdmin,
} from '../../src/access/adminAccess'
import { hasCapability } from '../../src/access/capabilities'
import { Admins, rejectInactiveAdminLogin } from '../../src/collections/Admins'
import { officialRollbackEndpoints } from '../../src/endpoints/official-rollback'

describe('administrator access', () => {
  it('maps the five fixed roles to their approved capabilities', () => {
    expect(hasCapability('super_admin', 'system:backup:restore')).toBe(true)
    expect(hasCapability('publisher', 'content:agents:publish')).toBe(true)
    expect(hasCapability('publisher', 'billing:order:refund')).toBe(false)
    expect(hasCapability('finance_admin', 'billing:order:refund')).toBe(true)
    expect(hasCapability('auditor', 'audit:read')).toBe(true)
    expect(hasCapability('auditor', 'users:balance:update')).toBe(false)
  })

  it('separates official Agent duties by real administrator role', () => {
    const rollbackCapability = 'official-agents:rollback:write'

    expect(hasCapability('publisher', 'official-agents:read')).toBe(true)
    expect(hasCapability('publisher', 'official-agents:draft:write')).toBe(true)
    expect(hasCapability('publisher', 'official-agents:review:write')).toBe(false)
    expect(hasCapability('publisher', 'official-agents:release:write')).toBe(false)
    expect(hasCapability('publisher', rollbackCapability)).toBe(false)

    expect(hasCapability('operations_admin', 'official-agents:read')).toBe(true)
    expect(hasCapability('operations_admin', 'official-agents:draft:write')).toBe(false)
    expect(hasCapability('operations_admin', 'official-agents:review:write')).toBe(false)
    expect(hasCapability('operations_admin', 'official-agents:release:write')).toBe(true)
    expect(hasCapability('operations_admin', rollbackCapability)).toBe(false)

    expect(hasCapability('super_admin', 'official-agents:read')).toBe(true)
    expect(hasCapability('super_admin', 'official-agents:draft:write')).toBe(false)
    expect(hasCapability('super_admin', 'official-agents:review:write')).toBe(true)
    expect(hasCapability('super_admin', 'official-agents:release:write')).toBe(false)
    expect(hasCapability('super_admin', rollbackCapability)).toBe(true)

    expect(hasCapability('auditor', 'official-agents:read')).toBe(true)
    expect(hasCapability('auditor', 'official-agents:draft:write')).toBe(false)
    expect(hasCapability('auditor', 'official-agents:review:write')).toBe(false)
    expect(hasCapability('auditor', 'official-agents:release:write')).toBe(false)
    expect(hasCapability('auditor', rollbackCapability)).toBe(false)
  })

  it('rejects non-super-admin rollback requests at the backend endpoint', async () => {
    const endpoint = officialRollbackEndpoints.find(
      (candidate) => candidate.path === '/official-rollback-requests/create',
    )
    expect(endpoint).toBeDefined()

    for (const role of ['publisher', 'operations_admin', 'auditor'] as const) {
      const response = await endpoint!.handler({
        headers: new Headers({ 'x-request-id': `rollback-${role}` }),
        user: { cloudActorId: '7f3e9a10-6b2c-4d8e-9f01-abcdef012345', id: 7, role },
      } as never)

      expect(response.status, role).toBe(403)
      await expect(response.json()).resolves.toMatchObject({ error: { code: 'FORBIDDEN' } })
    }
  })

  it('exposes exactly the five fixed administrator roles in the auth collection', () => {
    const roleField = Admins.fields.find((field) => 'name' in field && field.name === 'role') as {
      options: Array<{ label: string; value: string }>
    }

    expect(roleField.options.map((option) => option.value)).toEqual([
      'super_admin',
      'operations_admin',
      'publisher',
      'finance_admin',
      'auditor',
    ])
  })

  it('defaults administrators to active and rejects inactive logins', () => {
    const activeField = Admins.fields.find(
      (field) => 'name' in field && field.name === 'active',
    ) as {
      defaultValue: boolean
      saveToJWT: boolean
    }

    expect(activeField.defaultValue).toBe(true)
    expect(activeField.saveToJWT).toBe(true)
    expect(() => rejectInactiveAdminLogin({ user: { active: true } } as never)).not.toThrow()
    expect(() => rejectInactiveAdminLogin({ user: { active: false } } as never)).toThrow()
  })

  it('recognizes only the super_admin role as super administrator', () => {
    expect(isSuperAdmin({ user: { role: 'super_admin' } } as never)).toBe(true)
    expect(isSuperAdmin({ user: { role: 'publisher' } } as never)).toBe(false)
    expect(isSuperAdmin({ user: null } as never)).toBe(false)
  })

  it('allows authenticated publishers to manage catalog content', () => {
    expect(canManageCatalog({ req: { user: { role: 'publisher' } } } as never)).toBe(true)
    expect(canManageCatalog({ req: { user: null } } as never)).toBe(false)
  })

  it('lets publishers read only their own administrator record', () => {
    expect(canReadAdmin({ req: { user: { id: 7, role: 'super_admin' } } } as never)).toBe(true)
    expect(canReadAdmin({ req: { user: { id: 8, role: 'publisher' } } } as never)).toEqual({
      id: { equals: 8 },
    })
    expect(canReadAdmin({ req: { user: null } } as never)).toBe(false)
  })

  it('allows anonymous admin creation only when no admin exists', async () => {
    const count = vi.fn().mockResolvedValue({ totalDocs: 0 })

    expect(
      await canBootstrapOrManageAdmins({ req: { payload: { count }, user: null } } as never),
    ).toBe(true)
    expect(count).toHaveBeenCalledWith({ collection: 'admins', overrideAccess: true })
  })
})
