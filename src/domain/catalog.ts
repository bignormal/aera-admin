import { createHash } from 'node:crypto'

interface RelatedCategory {
  active?: boolean
  key: string
  name: string
}

interface RelatedMedia {
  url: string
}

interface RelatedSkill {
  active?: boolean
  distributionClass?: 'cloud_proprietary' | 'runtime_public'
  key: string
  runtimeSkillId: string
}

export interface CatalogAgentDocument {
  avatar: RelatedMedia
  category: RelatedCategory
  introduction: string
  minimumRuntimeVersion?: null | string
  minimumStudioVersion?: null | string
  name: string
  releaseVersion: number
  rolePrompt: string
  skills?: RelatedSkill[]
  tags?: Array<{ value: string }>
  templateKey: string
}

export function buildCatalog(
  docs: CatalogAgentDocument[],
  serverURL: string,
  generatedAt = new Date().toISOString(),
) {
  const experts = docs
    .filter((doc) => doc.category?.active !== false)
    .map((doc) => ({
      avatarUrl: new URL(doc.avatar.url, serverURL).toString(),
      category: { key: doc.category.key, name: doc.category.name },
      compatibility: {
        minimumRuntimeVersion: doc.minimumRuntimeVersion || null,
        minimumStudioVersion: doc.minimumStudioVersion || null,
      },
      introduction: doc.introduction,
      name: doc.name,
      releaseVersion: doc.releaseVersion,
      rolePrompt: doc.rolePrompt,
      skills: (doc.skills || [])
        .filter(
          (skill) => skill.active !== false && skill.distributionClass !== 'cloud_proprietary',
        )
        .map((skill) => ({ key: skill.key, runtimeSkillId: skill.runtimeSkillId })),
      tags: (doc.tags || []).map((tag) => tag.value),
      templateKey: doc.templateKey,
    }))
    .sort(
      (a, b) =>
        a.category.key.localeCompare(b.category.key) ||
        a.name.localeCompare(b.name, 'zh-CN') ||
        a.templateKey.localeCompare(b.templateKey),
    )

  return {
    catalogVersion: createHash('sha256').update(JSON.stringify(experts)).digest('hex'),
    experts,
    generatedAt,
  }
}
