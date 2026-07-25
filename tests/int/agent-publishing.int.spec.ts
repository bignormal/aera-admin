import { afterEach, describe, expect, it } from 'vitest'

import { assignReleaseVersion, validateAgentPublish } from '../../src/domain/publishing'
import { clearCatalogData, getTestPayload } from '../helpers/payload'

const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAEUlEQVR4nGNQTX79H4QZYAwAUe4JyX4GS0cAAAAASUVORK5CYII=',
  'base64',
)

describe('publishing domain rules', () => {
  it('increments the release only when published content changes', () => {
    const first = assignReleaseVersion({
      data: { _status: 'published', introduction: '第一版', templateKey: 'product-manager' },
      originalDoc: undefined,
    } as never) as Record<string, unknown>
    const unchanged = assignReleaseVersion({
      data: { _status: 'published' },
      originalDoc: {
        _status: 'published',
        introduction: '第一版',
        publishedFingerprint: first.publishedFingerprint,
        releaseVersion: first.releaseVersion,
        templateKey: 'product-manager',
      },
    } as never) as Record<string, unknown>

    expect(first.releaseVersion).toBe(1)
    expect(unchanged.releaseVersion).toBeUndefined()
  })

  it('keeps the template key immutable after the first release', () => {
    expect(() =>
      assignReleaseVersion({
        data: { _status: 'draft', templateKey: 'renamed-key' },
        originalDoc: { releaseVersion: 1, templateKey: 'product-manager' },
      } as never),
    ).toThrow()
  })

  it('rejects disabled relations and malformed compatibility versions', async () => {
    const findByID = async ({ collection }: { collection: string }) =>
      collection === 'expert-categories'
        ? { active: false }
        : { active: false, runtimeSkillId: 'document-analysis' }

    await expect(
      validateAgentPublish({
        data: {
          _status: 'published',
          category: 1,
          minimumRuntimeVersion: 'v1',
          skills: [2],
        },
        originalDoc: undefined,
        req: { payload: { findByID } },
      } as never),
    ).rejects.toMatchObject({
      data: {
        errors: expect.arrayContaining([
          expect.objectContaining({ path: 'category' }),
          expect.objectContaining({ path: 'skills' }),
          expect.objectContaining({ path: 'minimumRuntimeVersion' }),
        ]),
      },
    })
  })
})

describe('official Agent publishing', () => {
  afterEach(async () => clearCatalogData(await getTestPayload()))

  it('assigns release versions only for changed published content', async () => {
    const payload = await getTestPayload()
    const avatar = await payload.create({
      collection: 'media',
      data: { alt: '产品经理头像' },
      file: { data: png, mimetype: 'image/png', name: 'avatar.png', size: png.length },
      overrideAccess: true,
    })
    const category = await payload.create({
      collection: 'expert-categories',
      data: { active: true, key: 'product', name: '产品', sortOrder: 1 },
      draft: false,
      overrideAccess: true,
    })
    const skill = await payload.create({
      collection: 'skill-catalog',
      data: {
        active: true,
        key: 'documents',
        name: '文档分析',
        runtimeSkillId: 'document-analysis',
      },
      draft: false,
      overrideAccess: true,
    })
    const draft = await payload.create({
      collection: 'agent-templates',
      data: {
        _status: 'draft',
        avatar: avatar.id,
        category: category.id,
        introduction: '负责需求分析和产品规划。',
        name: '产品经理',
        rolePrompt: '你是一名产品经理，负责分析需求并输出清晰的产品方案。',
        skills: [skill.id],
        tags: [{ value: '需求分析' }],
        templateKey: 'product-manager',
      },
      draft: true,
      overrideAccess: true,
    })

    const firstRelease = await payload.update({
      collection: 'agent-templates',
      id: draft.id,
      data: { _status: 'published' },
      draft: false,
      overrideAccess: true,
    })
    expect(firstRelease.releaseVersion).toBe(1)

    await payload.update({
      collection: 'agent-templates',
      id: draft.id,
      data: { _status: 'draft', introduction: '负责需求发现、分析和产品规划。' },
      draft: true,
      overrideAccess: true,
    })
    const secondRelease = await payload.update({
      collection: 'agent-templates',
      id: draft.id,
      data: { _status: 'published' },
      draft: false,
      overrideAccess: true,
    })
    expect(secondRelease.releaseVersion).toBe(2)
  })
})
