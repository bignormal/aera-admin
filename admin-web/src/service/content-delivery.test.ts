import { beforeEach, describe, expect, it, vi } from 'vitest'

import { apiRequest } from './http'
import {
  desktopDeliveryTimeline,
  getContentDeliveryStatus,
  submitAgentForReview,
  syncAgentToCloud,
  validateAgentCloud,
} from './publishing'

vi.mock('./http', () => ({ apiRequest: vi.fn() }))

describe('content delivery service', () => {
  beforeEach(() => vi.clearAllMocks())

  it('maps controlled Agent delivery actions to Payload BFF endpoints', async () => {
    vi.mocked(apiRequest).mockResolvedValue({ data: { id: 9 } })

    await syncAgentToCloud(7)
    await validateAgentCloud(7)
    await submitAgentForReview(7, 'ready_for_review')
    await getContentDeliveryStatus('agent', 7)

    expect(apiRequest).toHaveBeenNthCalledWith(1, '/content-delivery/sync-agent/7', {
      method: 'POST',
    })
    expect(apiRequest).toHaveBeenNthCalledWith(2, '/content-delivery/validate/7', {
      method: 'POST',
    })
    expect(apiRequest).toHaveBeenNthCalledWith(3, '/content-delivery/submit/7', {
      body: { reason_code: 'ready_for_review' },
      method: 'POST',
    })
    expect(apiRequest).toHaveBeenNthCalledWith(4, '/content-delivery/agent/7')
  })

  it('keeps a released Agent waiting until Cloud reports an activated Desktop receipt', () => {
    const link = {
      cloudReleaseId: '11111111-1111-4111-8111-111111111111',
      syncStatus: 'released' as const,
    }

    const timeline = desktopDeliveryTimeline(link)
    expect(timeline).toMatchObject({
      delivered: false,
      summary: '已发布，等待 Desktop 验证',
    })
    expect(timeline.stages).toHaveLength(6)
    expect(timeline.stages[0]).toMatchObject({ key: 'cloud_released', label: 'Cloud 已发布', state: 'complete' })
    expect(timeline.stages[1]).toMatchObject({ key: 'catalog_visible', label: 'Desktop 已看到目录', state: 'pending' })
  })

  it('renders only Cloud-verified Desktop stages and preserves safe stage metadata', () => {
    const link = {
      cloudReleaseId: '11111111-1111-4111-8111-111111111111',
      contentDigest: 'ab'.repeat(32),
      desktopVerification: {
        desktopVerified: true,
        syncStatus: 'desktop_verified' as const,
        stages: [
          {
            contentDigest: 'ab'.repeat(32),
            desktopVersion: 'v0.24.0',
            deviceCount: 2,
            occurredAt: '2026-08-12T04:08:00.000Z',
            requestId: '22222222-2222-4222-8222-222222222222',
            runtimeVersion: 'v0.18.2-agentera.1',
            verificationStatus: 'activated' as const,
          },
          {
            deviceCount: 1,
            errorCode: 'activation_failed' as const,
            verificationStatus: 'failed' as const,
          },
        ],
      },
      syncStatus: 'desktop_verified' as const,
    }

    const timeline = desktopDeliveryTimeline(link)
    expect(timeline).toMatchObject({
      delivered: true,
      summary: 'Desktop 已激活',
    })
    expect(timeline.stages.find(stage => stage.key === 'cloud_released')).toMatchObject({ state: 'complete' })
    expect(timeline.stages.find(stage => stage.key === 'activated')).toMatchObject({
      state: 'complete',
      stage: expect.objectContaining({ deviceCount: 2, requestId: '22222222-2222-4222-8222-222222222222' }),
    })
    expect(timeline.stages.find(stage => stage.key === 'failed')).toMatchObject({
      state: 'failed',
      stage: expect.objectContaining({ errorCode: 'activation_failed' }),
    })
  })
})
