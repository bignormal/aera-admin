export const deliveryStatuses = [
  'local_only',
  'draft_synced',
  'validation_failed',
  'submitted',
  'approved',
  'released',
  'desktop_verified',
  'failed',
] as const

export type DeliveryStatus = (typeof deliveryStatuses)[number]

const transitions: Record<DeliveryStatus, readonly DeliveryStatus[]> = {
  local_only: ['draft_synced', 'failed'],
  draft_synced: ['validation_failed', 'submitted', 'failed'],
  validation_failed: ['draft_synced', 'failed'],
  submitted: ['approved', 'failed'],
  approved: ['released', 'failed'],
  released: ['desktop_verified', 'failed'],
  desktop_verified: ['released', 'failed'],
  failed: ['draft_synced', 'failed'],
}

export function canAdvanceDeliveryStatus(from: DeliveryStatus, to: DeliveryStatus): boolean {
  return transitions[from].includes(to)
}

export function deliveryStatusFor(input: {
  cloudReleaseId: string | null
  desktopVerified: boolean
  payloadPublished: boolean
}): DeliveryStatus {
  if (input.desktopVerified && input.cloudReleaseId) return 'desktop_verified'
  if (input.cloudReleaseId) return 'released'
  return 'local_only'
}

export type PluginDeliveryStatus =
  | 'registered'
  | 'contract_pending'
  | 'cloud_published'
  | 'desktop_verified'

export function pluginDeliveryStatus(input: {
  cloudReleaseId: string | null
  desktopContract: boolean
  desktopVerified: boolean
}): PluginDeliveryStatus {
  if (input.desktopVerified && input.desktopContract && input.cloudReleaseId) {
    return 'desktop_verified'
  }
  if (input.cloudReleaseId && input.desktopContract) return 'cloud_published'
  if (input.cloudReleaseId || !input.desktopContract) return 'contract_pending'
  return 'registered'
}

export function canonicalRuntimeManifestHash(runtimeSkillIds: readonly string[]): string {
  // The actual SHA-256 is calculated at the server boundary; this canonical
  // representation is shared by validation and persistence code.
  return [...new Set(runtimeSkillIds)].sort().join('\n')
}
