import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'

import ContentDeliveryTimeline from './modules/content-delivery-timeline.vue'

describe('content delivery timeline', () => {
  it('shows a released Agent as waiting without claiming delivery', () => {
    const wrapper = mount(ContentDeliveryTimeline, {
      props: {
        link: {
          cloudReleaseId: '11111111-1111-4111-8111-111111111111',
          id: 9,
          payloadDocumentId: '7',
          resourceType: 'agent',
          stableKey: 'research-expert',
          syncStatus: 'released',
          createdAt: '2026-08-12T04:00:00.000Z',
          updatedAt: '2026-08-12T04:00:00.000Z',
        },
      },
    })

    expect(wrapper.text()).toContain('已发布，等待 Desktop 验证')
    expect(wrapper.text()).toContain('Cloud 已发布')
    expect(wrapper.text()).toContain('Desktop 已看到目录')
    expect(wrapper.text()).not.toContain('已交付')
  })

  it('shows activated and failed stage metadata without raw device identities', () => {
    const wrapper = mount(ContentDeliveryTimeline, {
      props: {
        link: {
          cloudReleaseId: '11111111-1111-4111-8111-111111111111',
          desktopVerification: {
            desktopVerified: true,
            syncStatus: 'desktop_verified',
            stages: [
              {
                contentDigest: 'ab'.repeat(32),
                desktopVersion: 'v0.24.0',
                deviceCount: 2,
                occurredAt: '2026-08-12T04:08:00.000Z',
                requestId: '22222222-2222-4222-8222-222222222222',
                runtimeVersion: 'v0.18.2-agentera.1',
                verificationStatus: 'activated',
              },
              { deviceCount: 1, errorCode: 'activation_failed', verificationStatus: 'failed' },
            ],
          },
          id: 9,
          payloadDocumentId: '7',
          resourceType: 'agent',
          stableKey: 'research-expert',
          syncStatus: 'desktop_verified',
          createdAt: '2026-08-12T04:00:00.000Z',
          updatedAt: '2026-08-12T04:08:01.000Z',
        },
      },
    })

    expect(wrapper.text()).toContain('Desktop 已激活')
    expect(wrapper.text()).toContain('2 台设备')
    expect(wrapper.text()).toContain('v0.24.0')
    expect(wrapper.text()).toContain('v0.18.2-agentera.1')
    expect(wrapper.text()).toContain('activation_failed')
    expect(wrapper.text()).not.toMatch(/device[_ -]?id|installation[_ -]?id/i)
  })
})
