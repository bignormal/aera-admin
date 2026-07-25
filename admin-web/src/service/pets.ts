import {
  createResource,
  deleteResource,
  listResources,
  updateResource,
  type PayloadPage,
  type ResourceID,
  type ResourceQuery
} from './resources';

export interface PetRecord {
  _status?: 'draft' | 'published' | null;
  createdAt: string;
  enabled: boolean;
  id: ResourceID;
  manifest?: Record<string, unknown> | null;
  name: string;
  previewMedia?: ResourceID | null;
  slug: string;
  spriteMedia?: ResourceID | null;
  updatedAt: string;
  version: string;
}

export interface PetInput {
  _status?: 'draft' | 'published';
  enabled?: boolean;
  manifest?: Record<string, unknown>;
  name?: string;
  previewMedia?: ResourceID;
  slug?: string;
  spriteMedia?: ResourceID;
  version?: string;
}

export function listPets(query: ResourceQuery, signal?: AbortSignal): Promise<PayloadPage<PetRecord>> {
  return listResources('pet-assets', query, signal, true);
}

export function createPet(input: PetInput): Promise<PetRecord> {
  return createResource('pet-assets', input, true);
}

export function updatePet(id: ResourceID, input: Partial<PetInput>): Promise<PetRecord> {
  return updateResource('pet-assets', id, input, true);
}

export function deletePet(id: ResourceID): Promise<PetRecord> {
  return deleteResource('pet-assets', id);
}
