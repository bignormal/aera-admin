import config from '@payload-config'
import { getPayload, type Payload } from 'payload'

let instance: Payload | undefined

export async function getTestPayload(): Promise<Payload> {
  if (!instance) instance = await getPayload({ config })
  return instance
}

export async function clearCatalogData(payload: Payload): Promise<void> {
  for (const collection of [
    'agent-templates',
    'skill-catalog',
    'expert-categories',
    'media',
  ] as const) {
    await payload.delete({
      collection,
      overrideAccess: true,
      where: { id: { exists: true } },
    })
  }
}
