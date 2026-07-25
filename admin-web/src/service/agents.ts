import {
  createResource,
  deleteResource,
  listResources,
  updateResource,
  type PayloadPage,
  type ResourceID,
  type ResourceQuery
} from './resources';

export interface Agent {
  _status?: 'draft' | 'published' | null;
  avatar: ResourceID | { id: ResourceID; url?: string | null };
  category: ResourceID | { id: ResourceID; name: string };
  createdAt: string;
  id: ResourceID;
  introduction: string;
  minimumRuntimeVersion?: string | null;
  minimumStudioVersion?: string | null;
  name: string;
  releaseNotes?: string | null;
  releaseVersion?: number | null;
  rolePrompt: string;
  skills?: Array<ResourceID | { id: ResourceID; name: string }> | null;
  tags?: Array<{ value: string }> | null;
  templateKey: string;
  updatedAt: string;
}

export interface AgentInput {
  _status?: 'draft' | 'published';
  avatar: ResourceID;
  category: ResourceID;
  introduction: string;
  minimumRuntimeVersion?: string;
  minimumStudioVersion?: string;
  name: string;
  releaseNotes?: string;
  rolePrompt: string;
  skills?: ResourceID[];
  tags?: Array<{ value: string }>;
  templateKey: string;
}

export function listAgents(query: ResourceQuery, signal?: AbortSignal): Promise<PayloadPage<Agent>> {
  return listResources('agent-templates', query, signal, true);
}

export function createAgent(input: AgentInput): Promise<Agent> {
  return createResource('agent-templates', input, true);
}

export function updateAgent(id: ResourceID, input: Partial<AgentInput>): Promise<Agent> {
  return updateResource('agent-templates', id, input, true);
}

export function deleteAgent(id: ResourceID): Promise<Agent> {
  return deleteResource('agent-templates', id);
}
