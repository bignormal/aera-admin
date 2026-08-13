import {
  createResource,
  deleteResource,
  listResources,
  updateResource,
  type PayloadPage,
  type ResourceID,
  type ResourceQuery
} from './resources';

export interface PluginRecord {
  _status?: 'draft' | 'published' | null;
  artifactURL: string;
  checksum: string;
  createdAt: string;
  deliveryStatus: 'cloud_published' | 'contract_pending' | 'desktop_verified' | 'registered';
  enabled: boolean;
  id: ResourceID;
  installKind: 'pip_entry_point' | 'runtime_bundled' | 'standalone_plugin';
  name: string;
  riskLevel: 'high' | 'low' | 'medium';
  slug: string;
  summary: string;
  updatedAt: string;
  version: string;
}

export type PluginInput = Omit<PluginRecord, '_status' | 'createdAt' | 'deliveryStatus' | 'id' | 'updatedAt'> & {
  _status?: 'draft' | 'published';
};

export function listPlugins(query: ResourceQuery, signal?: AbortSignal): Promise<PayloadPage<PluginRecord>> {
  return listResources('plugin-catalog', query, signal, true);
}

export function createPlugin(input: PluginInput): Promise<PluginRecord> {
  return createResource('plugin-catalog', input, true);
}

export function updatePlugin(id: ResourceID, input: Partial<PluginInput>): Promise<PluginRecord> {
  return updateResource('plugin-catalog', id, input, true);
}

export function deletePlugin(id: ResourceID): Promise<PluginRecord> {
  return deleteResource('plugin-catalog', id);
}
