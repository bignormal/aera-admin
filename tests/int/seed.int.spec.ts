import { afterEach, describe, expect, it } from 'vitest'

import { seedCatalog } from '../../src/seed/seedCatalog'
import { clearCatalogData, getTestPayload } from '../helpers/payload'

describe('catalog seed', () => {
  afterEach(async () => clearCatalogData(await getTestPayload()))

  it('creates six drafts once without overwriting them', async () => {
    const payload = await getTestPayload()
    const first = await seedCatalog(payload)
    const second = await seedCatalog(payload)
    const templates = await payload.find({
      collection: 'agent-templates',
      overrideAccess: true,
      pagination: false,
    })
    const media = await payload.find({
      collection: 'media',
      overrideAccess: true,
      pagination: false,
    })

    expect(first.createdTemplates).toBe(6)
    expect(second.createdTemplates).toBe(0)
    expect(second.skippedTemplates).toBe(6)
    expect(templates.docs).toHaveLength(6)
    expect(templates.docs.every((doc) => doc._status === 'draft')).toBe(true)
    expect(media.docs).toHaveLength(1)
  })
})
