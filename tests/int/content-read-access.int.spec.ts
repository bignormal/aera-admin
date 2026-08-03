import { afterEach, describe, expect, it } from 'vitest'

import type { AdminRole } from '../../src/access/capabilities'
import { AgentTemplates } from '../../src/collections/AgentTemplates'
import { ExpertCategories } from '../../src/collections/ExpertCategories'
import { Media } from '../../src/collections/Media'
import { clearCatalogData, getTestPayload } from '../helpers/payload'

const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAEUlEQVR4nGNQTX79H4QZYAwAUe4JyX4GS0cAAAAASUVORK5CYII=',
  'base64',
)

const allowedRoles = ['super_admin', 'publisher'] as const
const deniedRoles = ['operations_admin', 'finance_admin', 'auditor'] as const

function adminUser(role: AdminRole) {
  return {
    id: `${role}-content-read-access`,
    collection: 'admins',
    email: `${role}@content-read-access.invalid`,
    role,
  }
}

type AdminUser = ReturnType<typeof adminUser>

describe('content collection read access', () => {
  afterEach(async () => clearCatalogData(await getTestPayload()))

  it('enforces the capability matrix for all five roles and anonymous requests', async () => {
    const collections = [AgentTemplates, ExpertCategories, Media] as const

    for (const collection of collections) {
      const read = collection.access?.read
      expect(read).toBeTypeOf('function')

      for (const role of allowedRoles) {
        expect(await read!({ req: { user: adminUser(role) } } as never)).toBe(true)
      }

      for (const role of deniedRoles) {
        expect(await read!({ req: { user: adminUser(role) } } as never)).toBe(false)
      }

      expect(await read!({ req: { user: null } } as never)).toBe(false)
    }
  })

  it('denies unauthorized reads of draft agent templates and related content', async () => {
    const payload = await getTestPayload()
    const avatar = await payload.create({
      collection: 'media',
      data: { alt: '权限测试头像' },
      file: { data: png, mimetype: 'image/png', name: 'access-avatar.png', size: png.length },
      overrideAccess: true,
    })
    const category = await payload.create({
      collection: 'expert-categories',
      data: { active: true, key: 'access-test', name: '权限测试', sortOrder: 1 },
      overrideAccess: true,
    })
    await payload.create({
      collection: 'agent-templates',
      data: {
        _status: 'draft',
        avatar: avatar.id,
        category: category.id,
        introduction: '只允许内容角色读取的草稿。',
        name: '权限测试智能体',
        rolePrompt: '这是不应暴露给无内容读取权限角色的草稿提示词。',
        templateKey: 'content-read-access-test',
      },
      draft: true,
      overrideAccess: true,
    })

    const reads = [
      (user?: AdminUser) =>
        payload.find({
          collection: 'agent-templates',
          depth: 0,
          draft: true,
          limit: 10,
          overrideAccess: false,
          user: user as never,
        }),
      (user?: AdminUser) =>
        payload.find({
          collection: 'expert-categories',
          depth: 0,
          limit: 10,
          overrideAccess: false,
          user: user as never,
        }),
      (user?: AdminUser) =>
        payload.find({
          collection: 'media',
          depth: 0,
          limit: 10,
          overrideAccess: false,
          user: user as never,
        }),
    ] as const

    for (const role of allowedRoles) {
      for (const read of reads) {
        await expect(read(adminUser(role))).resolves.toMatchObject({ totalDocs: 1 })
      }
    }

    for (const role of deniedRoles) {
      for (const read of reads) {
        await expect(read(adminUser(role))).rejects.toBeDefined()
      }
    }

    for (const read of reads) {
      await expect(read()).rejects.toBeDefined()
    }
  })
})
