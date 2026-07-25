import { createHash } from 'node:crypto'

export const runtimeCommandStates = [
  'queued',
  'claimed',
  'running',
  'succeeded',
  'failed',
  'expired',
] as const

export type RuntimeCommandState = (typeof runtimeCommandStates)[number]

export const runtimeCommandTypes = ['health_check'] as const
export type RuntimeCommandType = (typeof runtimeCommandTypes)[number]

const allowedTransitions: Record<RuntimeCommandState, readonly RuntimeCommandState[]> = {
  queued: ['claimed', 'expired'],
  claimed: ['running', 'failed', 'expired'],
  running: ['succeeded', 'failed', 'expired'],
  succeeded: [],
  failed: [],
  expired: [],
}

export function canTransitionCommand(from: RuntimeCommandState, to: RuntimeCommandState): boolean {
  return allowedTransitions[from].includes(to)
}

export function hashControlSecret(secret: string): string {
  return createHash('sha256').update(secret, 'utf8').digest('hex')
}

export function runtimeCommandKey(instanceId: number | string, idempotencyKey: string): string {
  return hashControlSecret(`${instanceId}:${idempotencyKey}`)
}
