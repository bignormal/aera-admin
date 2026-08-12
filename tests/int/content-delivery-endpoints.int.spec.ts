import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'

import { createContentDeliveryEndpoints } from '../../src/endpoints/content-delivery'

const definitionID = '11111111-1111-4111-8111-111111111111'
const draftID = '22222222-2222-4222-8222-222222222222'

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function cloudContentDigest(payload: Record<string, any>): string {
  const manifest = {
    assets: [...payload.manifest.assets].sort((left, right) => left.path.localeCompare(right.path)),
    dependencies: [],
    identity: payload.manifest.identity,
    model_policy: payload.manifest.model_policy,
    runtime_compatibility: {
      maximum_version_exclusive: null,
      minimum_version: payload.manifest.runtime_compatibility.minimum_version.startsWith('v')
        ? payload.manifest.runtime_compatibility.minimum_version
        : `v${payload.manifest.runtime_compatibility.minimum_version}`,
    },
    schema_version: 2,
    tools: payload.manifest.tools,
  }
  const bundle = {
    assets: [...payload.bundle.assets]
      .sort((left, right) => left.path.localeCompare(right.path))
      .map((asset) => ({ content: asset.content, path: asset.path })),
  }
  return createHash('sha256')
    .update(`${JSON.stringify(manifest)}\0${JSON.stringify(bundle)}`)
    .digest('hex')
}

function fixture() {
  return {
    _status: 'draft',
    avatar: { id: 8, mimeType: 'image/png' },
    category: { active: true, id: 5, key: 'research', name: '研究' },
    id: 7,
    introduction: '分析公开资料并输出结构化结论。',
    minimumRuntimeVersion: '0.18.2-agentera.1',
    name: '研究专家',
    releaseVersion: 0,
    rolePrompt: '你是一名研究专家，只基于用户允许的资料工作。',
    skills: [
      {
        active: true,
        description: '检索并整理公开资料。',
        id: 6,
        key: 'web-research',
        name: '网页研究',
        runtimeSkillId: 'web-research',
      },
    ],
    templateKey: 'research-expert',
    updatedAt: '2026-08-12T04:00:00.000Z',
  }
}

function request(options: {
  payload?: Record<string, any>
  role?: string
  routeParams?: Record<string, string>
}) {
  return {
    headers: new Headers({ 'x-request-id': 'content-delivery-request-1' }),
    method: 'POST',
    payload: options.payload ?? {},
    routeParams: options.routeParams ?? { id: '7' },
    url: 'http://localhost/api/content-delivery/sync-agent/7',
    user: options.role
      ? { email: 'publisher@agentera.local', id: 3, role: options.role }
      : undefined,
  }
}

describe('content delivery endpoints', () => {
  it('rejects sync before loading content when the role lacks draft capability', async () => {
    const cloud = vi.fn()
    const findByID = vi.fn()
    const endpoints = createContentDeliveryEndpoints(cloud)
    const endpoint = endpoints.find((item) => item.path === '/content-delivery/sync-agent/:id')

    const response = await endpoint!.handler(
      request({ payload: { findByID }, role: 'auditor' }) as never,
    )

    expect(response.status).toBe(403)
    await expect(response.json()).resolves.toMatchObject({ error: { code: 'FORBIDDEN' } })
    expect(findByID).not.toHaveBeenCalled()
    expect(cloud).not.toHaveBeenCalled()
  })

  it('persists Cloud target IDs and canonical digests after an idempotent draft sync', async () => {
    const agent = fixture()
    let syncedPayload: Record<string, any> | undefined
    const cloud = vi.fn(async (_req, input) => {
      if (input.operation === 'reserveOfficialDefinition') {
        return {
          data: {
            administrative_revision: 1,
            operation_id: '33333333-3333-4333-8333-333333333333',
            status: 'succeeded',
            target_id: definitionID,
            target_type: 'platform_definition',
            updated_at: '2026-08-12T04:01:00.000Z',
          },
          requestId: 'content-delivery-request-1',
        }
      }
      if (input.operation === 'createOfficialDraft') {
        syncedPayload = input.body.payload
        return {
          data: {
            administrative_revision: 1,
            operation_id: '44444444-4444-4444-8444-444444444444',
            status: 'succeeded',
            target_id: draftID,
            target_type: 'platform_draft',
            updated_at: '2026-08-12T04:02:00.000Z',
          },
          requestId: 'content-delivery-request-1',
        }
      }
      if (input.operation === 'getOfficialDraft') {
        return {
          data: {
            content_digest: cloudContentDigest(syncedPayload!),
            definition_id: definitionID,
            draft_id: draftID,
            revision: 1,
            status: 'draft',
          },
          requestId: 'content-delivery-request-1',
        }
      }
      throw new Error(`unexpected operation ${input.operation}`)
    })
    let persisted: Record<string, unknown> | undefined
    const create = vi.fn(async ({ collection, data }) => {
      if (collection !== 'content-delivery-links') return { id: 10 }
      persisted = {
        ...data,
        createdAt: '2026-08-12T04:02:00.000Z',
        id: 9,
        updatedAt: '2026-08-12T04:02:00.000Z',
      }
      return persisted
    })
    const find = vi.fn().mockResolvedValue({ docs: [] })
    const findByID = vi.fn().mockResolvedValue(agent)
    const update = vi.fn(async ({ data }) => {
      persisted = { ...persisted, ...data, updatedAt: '2026-08-12T04:03:00.000Z' }
      return persisted
    })
    const endpoints = createContentDeliveryEndpoints(cloud)
    const endpoint = endpoints.find((item) => item.path === '/content-delivery/sync-agent/:id')

    const response = await endpoint!.handler(
      request({ payload: { create, find, findByID, update }, role: 'publisher' }) as never,
    )

    const body = await response.json()
    expect(response.status, JSON.stringify(body)).toBe(200)
    expect(body.data).toMatchObject({
      cloudDefinitionId: definitionID,
      cloudDraftId: draftID,
      contentDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
      runtimeManifestSha256: digest('web-research'),
      stableKey: 'research-expert',
      syncStatus: 'draft_synced',
    })
    expect(body.data.contentDigest).toBe(cloudContentDigest(syncedPayload!))
    expect(syncedPayload).toMatchObject({
      definition_id: definitionID,
      display_name: '研究专家',
      kind: 'initial',
      manifest: {
        identity: { system_prompt: agent.rolePrompt },
        model_policy: { allowed_models: [], allowed_providers: [], mode: 'user_select' },
        schema_version: 2,
      },
    })
    expect(syncedPayload!.manifest.assets).toEqual([
      expect.objectContaining({
        kind: 'skill',
        path: 'skills/web-research/SKILL.md',
        sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      }),
    ])
    expect(JSON.stringify(body)).not.toContain(agent.rolePrompt)
    expect(JSON.stringify(body)).not.toMatch(/api[_-]?key|private[_-]?key|authorization/i)
  })

  it('keeps a failed Cloud validation distinct from a submitted draft', async () => {
    const cloud = vi.fn().mockResolvedValue({
      data: {
        content_digest: 'a'.repeat(64),
        draft_id: draftID,
        draft_revision: 2,
        findings: [{ code: 'DLP_BLOCKED' }],
        valid: false,
      },
      requestId: 'content-delivery-request-2',
    })
    const update = vi.fn(async ({ data }) => ({
      cloudDraftId: draftID,
      id: 9,
      payloadDocumentId: '7',
      stableKey: 'research-expert',
      ...data,
    }))
    const find = vi.fn().mockResolvedValue({
      docs: [
        { cloudDraftId: draftID, id: 9, payloadDocumentId: '7', stableKey: 'research-expert' },
      ],
    })
    const create = vi.fn().mockResolvedValue({ id: 11 })
    const endpoints = createContentDeliveryEndpoints(cloud)
    const endpoint = endpoints.find((item) => item.path === '/content-delivery/validate/:id')

    const response = await endpoint!.handler(
      request({ payload: { create, find, update }, role: 'publisher' }) as never,
    )

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      data: {
        lastErrorCode: 'CLOUD_VALIDATION_FAILED',
        syncStatus: 'validation_failed',
      },
    })
    expect(cloud).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        operation: 'validateOfficialDraft',
        params: { draft_id: draftID },
      }),
    )
  })

  it('submits only a Cloud-validated draft and stores the immutable submission target', async () => {
    const submissionID = '55555555-5555-4555-8555-555555555555'
    const cloud = vi.fn(async (_req, input) => {
      if (input.operation === 'validateOfficialDraft') {
        return {
          data: {
            content_digest: 'a'.repeat(64),
            draft_id: draftID,
            draft_revision: 3,
            findings: [],
            valid: true,
          },
          requestId: 'content-delivery-request-3',
        }
      }
      return {
        data: {
          administrative_revision: 1,
          operation_id: '66666666-6666-4666-8666-666666666666',
          status: 'succeeded',
          target_id: submissionID,
          target_type: 'platform_submission',
          updated_at: '2026-08-12T04:05:00.000Z',
        },
        requestId: 'content-delivery-request-3',
      }
    })
    const update = vi.fn(async ({ data }) => ({
      cloudDraftId: draftID,
      id: 9,
      payloadDocumentId: '7',
      stableKey: 'research-expert',
      ...data,
    }))
    const find = vi.fn().mockResolvedValue({
      docs: [
        { cloudDraftId: draftID, id: 9, payloadDocumentId: '7', stableKey: 'research-expert' },
      ],
    })
    const create = vi.fn().mockResolvedValue({ id: 11 })
    const endpoints = createContentDeliveryEndpoints(cloud)
    const endpoint = endpoints.find((item) => item.path === '/content-delivery/submit/:id')
    const submitRequest = {
      ...request({ payload: { create, find, update }, role: 'publisher' }),
      json: vi.fn().mockResolvedValue({ reason_code: 'ready_for_review' }),
    }

    const response = await endpoint!.handler(submitRequest as never)

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      data: { cloudSubmissionId: submissionID, syncStatus: 'submitted' },
    })
    expect(cloud).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({
        body: expect.objectContaining({ expected_revision: 3, reason_code: 'ready_for_review' }),
        operation: 'submitOfficialDraft',
      }),
    )
  })

  it('returns only the safe delivery link for a content publisher', async () => {
    const endpoints = createContentDeliveryEndpoints(vi.fn())
    const endpoint = endpoints.find((item) => item.path === '/content-delivery/:resourceType/:id')
    const response = await endpoint!.handler({
      headers: new Headers(),
      method: 'GET',
      payload: {
        find: vi.fn().mockResolvedValue({
          docs: [
            {
              cloudDraftId: draftID,
              contentDigest: 'a'.repeat(64),
              id: 9,
              internalPrompt: 'must not be returned',
              payloadDocumentId: '7',
              stableKey: 'research-expert',
              syncStatus: 'draft_synced',
            },
          ],
        }),
      },
      routeParams: { id: '7', resourceType: 'agent' },
      user: { id: 3, role: 'publisher' },
    } as never)

    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body.data).toMatchObject({ cloudDraftId: draftID, syncStatus: 'draft_synced' })
    expect(JSON.stringify(body)).not.toContain('must not be returned')
  })
})
