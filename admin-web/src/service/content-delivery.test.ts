import { beforeEach, describe, expect, it, vi } from 'vitest'

import { apiRequest } from './http'
import {
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
})
