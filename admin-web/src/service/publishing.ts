import { apiRequest } from './http';
import type { ResourceID } from './resources';

export type PublishingCollection = 'agent-templates' | 'pet-assets' | 'plugin-catalog' | 'skill-catalog';

export async function publishResource(collection: PublishingCollection, id: ResourceID): Promise<unknown> {
  const result = await apiRequest<{ doc: unknown }>(`/${collection}/${id}?draft=false`, {
    method: 'PATCH',
    body: { _status: 'published' }
  });
  return result.doc;
}

export async function saveResourceDraft(collection: PublishingCollection, id: ResourceID): Promise<unknown> {
  const result = await apiRequest<{ doc: unknown }>(`/${collection}/${id}?draft=true`, {
    method: 'PATCH',
    body: { _status: 'draft' }
  });
  return result.doc;
}
