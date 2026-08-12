import { describe, expect, it } from 'vitest'

import {
  canAdvanceDeliveryStatus,
  canonicalRuntimeManifestHash,
  deliveryVerificationForLink,
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

describe('Desktop delivery verification', () => {
  const link = {
    cloudReleaseId: '11111111-1111-4111-8111-111111111111',
    cloudVersionId: '22222222-2222-4222-8222-222222222222',
    contentDigest: 'ab'.repeat(32),
  }

  it('marks only a matching activated current release as Desktop verified', () => {
    expect(
      deliveryVerificationForLink(link, {
        release_id: link.cloudReleaseId,
        stages: [
          {
            verification_status: 'activated',
            definition_id: '33333333-3333-4333-8333-333333333333',
            version_id: link.cloudVersionId,
            content_digest: link.contentDigest,
            device_count: 2,
            desktop_version: 'v0.24.0',
            occurred_at: '2026-08-12T04:08:00.000Z',
            received_at: '2026-08-12T04:08:01.000Z',
            release_revision_id: '44444444-4444-4444-8444-444444444444',
            request_id: '55555555-5555-4555-8555-555555555555',
            runtime_version: 'v0.18.2-agentera.1',
          },
        ],
      }),
    ).toMatchObject({ desktopVerified: true, syncStatus: 'desktop_verified' })
  })

  it('keeps mismatched digests released and does not trust the receipt', () => {
    expect(
      deliveryVerificationForLink(link, {
        release_id: link.cloudReleaseId,
        stages: [
          {
            verification_status: 'activated',
            version_id: link.cloudVersionId,
            content_digest: 'cd'.repeat(32),
            device_count: 1,
          },
        ],
      }),
    ).toEqual({ desktopVerified: false, stages: [], syncStatus: 'released' })
  })

  it('rejects an activated stage that omits required Cloud receipt metadata', () => {
    expect(
      deliveryVerificationForLink(link, {
        release_id: link.cloudReleaseId,
        stages: [
          {
            verification_status: 'activated',
            version_id: link.cloudVersionId,
            content_digest: link.contentDigest,
            device_count: 1,
          },
        ],
      }),
    ).toEqual({ desktopVerified: false, stages: [], syncStatus: 'released' })
  })
})
