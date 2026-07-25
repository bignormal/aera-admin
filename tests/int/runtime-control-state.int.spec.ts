import { afterEach, describe, expect, it } from 'vitest'

import { RuntimeCommands } from '../../src/collections/RuntimeCommands'
import { RuntimeInstances } from '../../src/collections/RuntimeInstances'
import {
  canTransitionCommand,
  hashControlSecret,
  runtimeCommandKey,
} from '../../src/domain/runtime-control'
import { getTestPayload } from '../helpers/payload'

async function clearRuntimeData() {
  const payload = await getTestPayload()
  for (const collection of [
    'runtime-events',
    'runtime-commands',
    'runtime-releases',
    'runtime-instances',
  ] as const) {
    await payload.delete({ collection, overrideAccess: true, where: { id: { exists: true } } })
  }
}

describe('runtime control data model', () => {
  afterEach(clearRuntimeData)

  it('allows only legal command state transitions', () => {
    expect(canTransitionCommand('queued', 'claimed')).toBe(true)
    expect(canTransitionCommand('claimed', 'running')).toBe(true)
    expect(canTransitionCommand('running', 'succeeded')).toBe(true)
    expect(canTransitionCommand('running', 'failed')).toBe(true)
    expect(canTransitionCommand('queued', 'expired')).toBe(true)
    expect(canTransitionCommand('succeeded', 'running')).toBe(false)
    expect(canTransitionCommand('queued', 'succeeded')).toBe(false)
  })

  it('hashes control secrets and never stores their plaintext representation', () => {
    const secret = 'one-time-device-secret'
    const hash = hashControlSecret(secret)
    expect(hash).toMatch(/^[a-f0-9]{64}$/)
    expect(hash).not.toContain(secret)
  })

  it('enforces instance-scoped command idempotency', async () => {
    const payload = await getTestPayload()
    const instance = await payload.create({
      collection: 'runtime-instances',
      data: {
        capabilities: ['diagnostics.health.read'],
        deviceIdHash: hashControlSecret('device-1'),
        instanceType: 'runtime',
        name: 'Runtime 1',
        status: 'offline',
      },
      overrideAccess: true,
    })
    const command = {
      commandKey: runtimeCommandKey(instance.id, 'health-1'),
      idempotencyKey: 'health-1',
      instance: instance.id,
      requiredCapability: 'diagnostics.health.read',
      state: 'queued',
      type: 'health_check',
    } as const

    await payload.create({ collection: 'runtime-commands', data: command, overrideAccess: true })
    await expect(
      payload.create({ collection: 'runtime-commands', data: command, overrideAccess: true }),
    ).rejects.toThrow()
  })

  it('keeps device hashes and command state service-owned', () => {
    const deviceSecret = RuntimeInstances.fields.find(
      (field) => 'name' in field && field.name === 'deviceSecretHash',
    )
    const commandState = RuntimeCommands.fields.find(
      (field) => 'name' in field && field.name === 'state',
    )
    expect('access' in (deviceSecret || {}) && deviceSecret?.access?.read?.({} as never)).toBe(false)
    expect('access' in (deviceSecret || {}) && deviceSecret?.access?.update?.({} as never)).toBe(false)
    expect('access' in (commandState || {}) && commandState?.access?.update?.({} as never)).toBe(false)
  })
})
