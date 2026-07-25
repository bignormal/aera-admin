import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

import config from '../../src/payload.config'

describe('internal Payload control service', () => {
  it('does not register legacy platform navigation or demo views', async () => {
    const resolved = await config
    expect(resolved.admin?.components?.actions).toBeUndefined()
    expect(resolved.admin?.components?.Nav).toBeUndefined()
    expect(resolved.admin?.components?.views).toBeUndefined()
  })

  it('keeps every real control-plane collection registered', async () => {
    const resolved = await config
    const slugs = resolved.collections?.map((collection) => collection.slug)
    expect(slugs).toEqual(
      expect.arrayContaining([
        'admins',
        'media',
        'expert-categories',
        'skill-catalog',
        'agent-templates',
        'plugin-catalog',
        'pet-assets',
        'integration-settings',
        'audit-logs',
        'runtime-instances',
        'runtime-releases',
        'runtime-commands',
        'runtime-events',
      ]),
    )
  })

  it('keeps generated imports and seed logic free of demo platform modules', async () => {
    const [importMap, seed] = await Promise.all([
      readFile('src/app/(payload)/admin/importMap.js', 'utf8'),
      readFile('src/seed.ts', 'utf8'),
    ])
    expect(importMap).not.toContain('/components/admin/platform/')
    expect(seed).not.toMatch(/demo|演示/i)
  })
})
