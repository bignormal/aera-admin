import { describe, expect, it, vi } from 'vitest'

import { buildCatalog } from '../../src/domain/catalog'
import { catalogEndpoint } from '../../src/endpoints/catalog'

const publishedDoc = {
  avatar: { url: '/media/avatar.png' },
  category: { active: true, key: 'product', name: '产品', sortOrder: 1 },
  introduction: '负责产品规划。',
  name: '产品经理',
  releaseVersion: 1,
  rolePrompt: '你是一名产品经理。',
  skills: [
    { active: true, key: 'documents', runtimeSkillId: 'document-analysis' },
    { active: false, key: 'disabled-skill', runtimeSkillId: 'disabled-skill' },
  ],
  tags: [{ value: '产品规划' }],
  templateKey: 'product-manager',
}

describe('published catalog', () => {
  it('builds a deterministic sanitized response', () => {
    const first = buildCatalog(
      [publishedDoc],
      'http://localhost:3000',
      '2026-07-15T00:00:00.000Z',
    )
    const second = buildCatalog(
      [publishedDoc],
      'http://localhost:3000',
      '2026-07-15T00:01:00.000Z',
    )

    expect(first.catalogVersion).toBe(second.catalogVersion)
    expect(first.experts[0]).not.toHaveProperty('id')
    expect(first.experts[0].avatarUrl).toBe('http://localhost:3000/media/avatar.png')
    expect(first.experts[0].skills).toEqual([
      { key: 'documents', runtimeSkillId: 'document-analysis' },
    ])
  })

  it('queries only published templates', async () => {
    const find = vi.fn().mockResolvedValue({ docs: [publishedDoc] })
    const response = await catalogEndpoint.handler({
      payload: { find },
      url: 'http://localhost:3000/api/catalog/v1/experts',
    } as never)

    expect(find).toHaveBeenCalledWith(
      expect.objectContaining({
        collection: 'agent-templates',
        draft: false,
        overrideAccess: true,
        where: { _status: { equals: 'published' } },
      }),
    )
    expect(response.status).toBe(200)
  })

  it('uses the local server URL when the request URL is unavailable', async () => {
    const previousServerURL = process.env.NEXT_PUBLIC_SERVER_URL
    delete process.env.NEXT_PUBLIC_SERVER_URL

    try {
      const response = await catalogEndpoint.handler({
        payload: { find: vi.fn().mockResolvedValue({ docs: [publishedDoc] }) },
      } as never)
      const body = (await response.json()) as ReturnType<typeof buildCatalog>

      expect(body.experts[0].avatarUrl).toBe('http://localhost:3000/media/avatar.png')
    } finally {
      process.env.NEXT_PUBLIC_SERVER_URL = previousServerURL
    }
  })
})
