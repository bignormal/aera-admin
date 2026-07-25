import { describe, expect, it, vi } from 'vitest'

import {
  canBootstrapOrManageAdmins,
  canManageCatalog,
  canReadAdmin,
  isSuperAdmin,
} from '../../src/access/adminAccess'
import { hasCapability } from '../../src/access/capabilities'
import { Admins, rejectInactiveAdminLogin } from '../../src/collections/Admins'

describe('administrator access', () => {
  it('maps the five fixed roles to their approved capabilities', () => {
    expect(hasCapability('super_admin', 'system:backup:restore')).toBe(true)
    expect(hasCapability('publisher', 'content:agents:publish')).toBe(true)
    expect(hasCapability('publisher', 'billing:order:refund')).toBe(false)
    expect(hasCapability('finance_admin', 'billing:order:refund')).toBe(true)
    expect(hasCapability('auditor', 'audit:read')).toBe(true)
    expect(hasCapability('auditor', 'users:balance:update')).toBe(false)
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
