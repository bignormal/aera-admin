import { apiRequest } from './http';
import { deleteResource, listResources, type PayloadPage, type ResourceID, type ResourceQuery } from './resources';

export interface MediaRecord {
  alt: string;
  attribution?: string | null;
  createdAt: string;
  filename?: string | null;
  filesize?: number | null;
  id: ResourceID;
  mimeType?: string | null;
  updatedAt: string;
  url?: string | null;
}

export interface MediaMetadata {
  alt: string;
  attribution?: string;
}

export function listMedia(query: ResourceQuery, signal?: AbortSignal): Promise<PayloadPage<MediaRecord>> {
  return listResources('media', query, signal, false, 'alt');
}

export async function uploadMedia(file: File, metadata: MediaMetadata): Promise<MediaRecord> {
  const body = new FormData();
  body.append('file', file);
  body.append('_payload', JSON.stringify(metadata));
  const result = await apiRequest<{ doc: MediaRecord }>('/media', { method: 'POST', body });
  return result.doc;
}

export function deleteMedia(id: ResourceID): Promise<MediaRecord> {
  return deleteResource('media', id);
}
