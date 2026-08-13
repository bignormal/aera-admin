import { afterEach, describe, expect, it } from 'vitest'

import { clearCatalogData, getTestPayload } from '../helpers/payload'

describe('catalog metadata collections', () => {
  afterEach(async () => clearCatalogData(await getTestPayload()))

  it('creates categories and skills with active defaults', async () => {
    const payload = await getTestPayload()
    const category = await payload.create({
      collection: 'expert-categories',
      data: { key: 'product', name: '产品', sortOrder: 10 } as never,
      draft: false,
      overrideAccess: true,
    })
    const skill = await payload.create({
      collection: 'skill-catalog',
      data: {
        _status: 'draft',
        key: 'document-analysis',
        name: '文档分析',
        runtimeSkillId: 'document-analysis',
      } as never,
      draft: true,
      overrideAccess: true,
    })

    const publishedSkill = await payload.update({
      collection: 'skill-catalog',
      id: skill.id,
      data: { _status: 'published' } as never,
      draft: false,
      overrideAccess: true,
    })

    expect(category.active).toBe(true)
    expect(skill.active).toBe(true)
    expect(skill.distributionClass).toBe('runtime_public')
    expect(skill._status).toBe('draft')
    expect(publishedSkill._status).toBe('published')
  })
})
