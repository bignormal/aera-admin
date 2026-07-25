import { apiRequest } from './http';

export type ResourceID = number | string;

export interface ResourceQuery {
  limit: number;
  page: number;
  search?: string;
  sort?: string;
}

export interface PayloadPage<T> {
  docs: T[];
  hasNextPage: boolean;
  hasPrevPage: boolean;
  limit: number;
  page: number;
  totalDocs: number;
  totalPages: number;
}

type MutationResponse<T> = { doc: T; message?: string };

export function buildResourceParams(query: ResourceQuery, versioned = false, searchField = 'name'): URLSearchParams {
  const params = new URLSearchParams({
    page: String(query.page),
    limit: String(query.limit),
    sort: query.sort || '-updatedAt'
  });
  if (versioned) params.set('draft', 'true');
  if (query.search?.trim()) params.set(`where[${searchField}][contains]`, query.search.trim());
  return params;
}

export function listResources<T>(
  collection: string,
  query: ResourceQuery,
  signal?: AbortSignal,
  versioned = false,
  searchField = 'name'
): Promise<PayloadPage<T>> {
  return apiRequest(`/${collection}?${buildResourceParams(query, versioned, searchField)}`, { signal });
}

export async function createResource<T, TInput>(collection: string, input: TInput, versioned = false): Promise<T> {
  const suffix = versioned ? '?draft=true' : '';
  const result = await apiRequest<MutationResponse<T>>(`/${collection}${suffix}`, {
    method: 'POST',
    body: input as object
  });
  return result.doc;
}

export async function updateResource<T, TInput>(
  collection: string,
  id: ResourceID,
  input: Partial<TInput>,
  versioned = false
): Promise<T> {
  const suffix = versioned ? '?draft=true' : '';
  const result = await apiRequest<MutationResponse<T>>(`/${collection}/${id}${suffix}`, {
    method: 'PATCH',
    body: input as object
  });
  return result.doc;
}

export async function deleteResource<T>(collection: string, id: ResourceID): Promise<T> {
  const result = await apiRequest<MutationResponse<T>>(`/${collection}/${id}`, { method: 'DELETE' });
  return result.doc;
}
