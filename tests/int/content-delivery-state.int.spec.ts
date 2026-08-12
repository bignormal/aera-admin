import { describe, expect, it } from 'vitest'

import {
  canAdvanceDeliveryStatus,
  canonicalRuntimeManifestHash,
  deliveryStatusFor,
  pluginDeliveryStatus,
} from '../../src/domain/content-delivery'

describe('content delivery state machine', () => {
  it('does not call a local Payload publish a Cloud release', () => {
    expect(
      deliveryStatusFor({ cloudReleaseId: null, desktopVerified: false, payloadPublished: true }),
    ).toBe('local_only')
  })

  it('requires a Cloud release before Desktop verification', () => {
    expect(canAdvanceDeliveryStatus('approved', 'desktop_verified')).toBe(false)
    expect(canAdvanceDeliveryStatus('released', 'desktop_verified')).toBe(true)
  })

  it('accepts only forward transitions except an explicit failure reset', () => {
    expect(canAdvanceDeliveryStatus('released', 'draft_synced')).toBe(false)
    expect(canAdvanceDeliveryStatus('validation_failed', 'draft_synced')).toBe(true)
  })

  it('keeps plugins pending until a real Desktop contract exists', () => {
    expect(
      pluginDeliveryStatus({
        cloudReleaseId: 'release-1',
        desktopContract: false,
        desktopVerified: false,
      }),
    ).toBe('contract_pending')
  })

  it('canonicalizes public Runtime skill IDs deterministically', () => {
    expect(canonicalRuntimeManifestHash(['skill-b', 'skill-a', 'skill-a'])).toBe('skill-a\nskill-b')
  })
})
