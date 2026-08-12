import { describe, expect, it } from 'vitest'

import { pluginDeliveryStatus } from '../../src/domain/content-delivery'

describe('plugin delivery guard', () => {
  it('never reports a plugin as delivered without a verified Desktop contract', () => {
    expect(
      pluginDeliveryStatus({ cloudReleaseId: 'release-1', desktopContract: false, desktopVerified: false }),
    ).toBe('contract_pending')
  })

  it('keeps a local plugin registered until Cloud publishes a signed contract', () => {
    expect(pluginDeliveryStatus({ cloudReleaseId: null, desktopContract: false, desktopVerified: false })).toBe(
      'registered',
    )
  })
})
