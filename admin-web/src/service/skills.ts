import {
  createResource,
  deleteResource,
  listResources,
  updateResource,
  type PayloadPage,
  type ResourceID,
  type ResourceQuery,
} from './resources'

export interface Skill {
  _status?: 'draft' | 'published'
  active: boolean
  createdAt: string
  description?: string | null
  distributionClass: 'cloud_proprietary' | 'runtime_public'
  id: ResourceID
  key: string
  minimumRuntimeVersion?: string | null
  name: string
  runtimeSkillId: string
  updatedAt: string
}

export interface SkillInput {
  active: boolean
  description?: string
  distributionClass: 'cloud_proprietary' | 'runtime_public'
  key: string
  minimumRuntimeVersion?: string
  name: string
  runtimeSkillId: string
}

export function listSkills(
  query: ResourceQuery,
  signal?: AbortSignal,
): Promise<PayloadPage<Skill>> {
  return listResources('skill-catalog', query, signal, true)
}

export function createSkill(input: SkillInput): Promise<Skill> {
  return createResource('skill-catalog', input, true)
}

export function updateSkill(id: ResourceID, input: Partial<SkillInput>): Promise<Skill> {
  return updateResource('skill-catalog', id, input, true)
}

export function deleteSkill(id: ResourceID): Promise<Skill> {
  return deleteResource('skill-catalog', id)
}
