import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { getTestPayload } from '../helpers/payload'

const publisher = {
  active: true,
  displayName: '内容目录发布员',
  email: 'content-catalog-publisher@agentera.local',
  password: 'content-catalog-publisher-password',
  role: 'publisher' as const,
}

const financeAdmin = {
  active: true,
  displayName: '内容目录财务员',
  email: 'content-catalog-finance@agentera.local',
  password: 'content-catalog-finance-password',
  role: 'finance_admin' as const,
}

const pluginData = {
  _status: 'draft' as const,
  artifactURL: 'https://releases.agentera.local/plugins/web-search-1.0.0.zip',
  checksum: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  enabled: true,
  installKind: 'standalone_plugin' as const,
  name: '网页搜索插件',
  riskLevel: 'low' as const,
  slug: 'web-search',
  summary: '为 Runtime 提供网页搜索能力。',
  version: '1.0.0',
}

const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAEUlEQVR4nGNQTX79H4QZYAwAUe4JyX4GS0cAAAAASUVORK5CYII=',
  'base64',
)

async function clearFixtures() {
  const payload = await getTestPayload()
  for (const collection of ['pet-assets', 'plugin-catalog', 'audit-logs', 'media'] as const) {
    await payload.delete({
      collection: collection as never,
      overrideAccess: true,
      where: { id: { exists: true } },
    })
  }
  await payload.delete({
    collection: 'admins',
    overrideAccess: true,
    where: { email: { in: [publisher.email, financeAdmin.email] } },
  })
}

describe('plugin and pet publishing catalogs', () => {
  beforeEach(clearFixtures)
  afterEach(clearFixtures)

  it('allows publisher CRUD and rejects finance admin writes', async () => {
    const payload = await getTestPayload()
    const publisherDoc = await payload.create({
      collection: 'admins',
      data: publisher,
      overrideAccess: true,
    })
    const financeDoc = await payload.create({
      collection: 'admins',
      data: financeAdmin,
      overrideAccess: true,
    })

    const plugin = await payload.create({
      collection: 'plugin-catalog',
      data: pluginData,
      draft: true,
      overrideAccess: false,
      user: publisherDoc,
    })
    const updated = await payload.update({
      collection: 'plugin-catalog',
      id: plugin.id,
      data: { summary: '为 Runtime 提供经过审核的网页搜索能力。' },
      draft: true,
      overrideAccess: false,
      user: publisherDoc,
    })
    const found = await payload.findByID({
      collection: 'plugin-catalog',
      id: plugin.id,
      draft: true,
      overrideAccess: false,
      user: publisherDoc,
    })
    expect(updated.summary).toContain('经过审核')
    expect(found.id).toBe(plugin.id)

    await expect(
      payload.create({
        collection: 'plugin-catalog',
        data: { ...pluginData, slug: 'finance-denied' },
        draft: true,
        overrideAccess: false,
        user: financeDoc,
      }),
    ).rejects.toThrow()

    await payload.delete({
      collection: 'plugin-catalog',
      id: plugin.id,
      overrideAccess: false,
      user: publisherDoc,
    })
  })

  it('rejects duplicate slug and version pairs', async () => {
    const payload = await getTestPayload()
    const publisherDoc = await payload.create({
      collection: 'admins',
      data: publisher,
      overrideAccess: true,
    })

    await payload.create({
      collection: 'plugin-catalog',
      data: pluginData,
      draft: true,
      overrideAccess: false,
      user: publisherDoc,
    })
    await expect(
      payload.create({
        collection: 'plugin-catalog',
        data: { ...pluginData, name: '重复版本' },
        draft: true,
        overrideAccess: false,
        user: publisherDoc,
      }),
    ).rejects.toThrow()
  })

  it('requires manifest and sprite media before publishing a pet and audits the release', async () => {
    const payload = await getTestPayload()
    const publisherDoc = await payload.create({
      collection: 'admins',
      data: publisher,
      overrideAccess: true,
    })
    const sprite = await payload.create({
      collection: 'media',
      data: { alt: 'Aera v2 spritesheet' },
      file: { data: png, mimetype: 'image/png', name: 'aera-sprite.png', size: png.length },
      overrideAccess: true,
    })
    const pet = await payload.create({
      collection: 'pet-assets',
      data: {
        _status: 'draft',
        enabled: true,
        name: 'Aera',
        slug: 'aera',
        version: '2.0.0',
      },
      draft: true,
      overrideAccess: false,
      user: publisherDoc,
    })

    await expect(
      payload.update({
        collection: 'pet-assets',
        id: pet.id,
        data: { _status: 'published' },
        draft: false,
        overrideAccess: false,
        user: publisherDoc,
      }),
    ).rejects.toThrow()

    const published = await payload.update({
      collection: 'pet-assets',
      id: pet.id,
      data: {
        _status: 'published',
        manifest: {
          displayName: 'Aera',
          id: 'aera',
          spriteVersionNumber: 2,
          spritesheetPath: 'spritesheet.webp',
        },
        spriteMedia: sprite.id,
      },
      draft: false,
      overrideAccess: false,
      user: publisherDoc,
    })
    expect(published._status).toBe('published')

    const logs = await payload.find({
      collection: 'audit-logs',
      overrideAccess: true,
      where: {
        and: [
          { resourceType: { equals: 'pet-assets' } },
          { resourceId: { equals: String(pet.id) } },
        ],
      },
    })
    expect(logs.docs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action: 'pet-assets.update',
          capability: 'content:pets:write',
          outcome: 'succeeded',
        }),
      ]),
    )
  })
})
