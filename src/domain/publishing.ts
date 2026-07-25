import { createHash } from 'node:crypto'
import {
  ValidationError,
  type CollectionBeforeChangeHook,
  type CollectionBeforeValidateHook,
} from 'payload'

function relationID(value: unknown): number | string | undefined {
  if (typeof value === 'string' || typeof value === 'number') return value
  if (value && typeof value === 'object' && 'id' in value) {
    return (value as { id: number | string }).id
  }
  return undefined
}

function fingerprint(data: Record<string, unknown>): string {
  const normalized = {
    avatar: relationID(data.avatar),
    category: relationID(data.category),
    introduction: data.introduction ?? '',
    minimumRuntimeVersion: data.minimumRuntimeVersion ?? null,
    minimumStudioVersion: data.minimumStudioVersion ?? null,
    name: data.name ?? '',
    rolePrompt: data.rolePrompt ?? '',
    skills: Array.isArray(data.skills)
      ? data.skills.map(relationID).filter((value) => value !== undefined).sort()
      : [],
    tags: data.tags ?? [],
    templateKey: data.templateKey ?? '',
  }

  return createHash('sha256').update(JSON.stringify(normalized)).digest('hex')
}

export const validateAgentPublish: CollectionBeforeValidateHook = async ({
  data,
  originalDoc,
  req,
}) => {
  const next = { ...originalDoc, ...data }
  if (next._status !== 'published') return data

  const errors: Array<{ message: string; path: string }> = []
  const categoryID = relationID(next.category)

  if (categoryID !== undefined) {
    const category = await req.payload.findByID({
      collection: 'expert-categories',
      id: categoryID,
      overrideAccess: true,
    })
    if (!category.active) {
      errors.push({ message: '发布前必须选择已启用的分类。', path: 'category' })
    }
  }

  for (const skillValue of Array.isArray(next.skills) ? next.skills : []) {
    const skillID = relationID(skillValue)
    if (skillID === undefined) continue
    const skill = await req.payload.findByID({
      collection: 'skill-catalog',
      id: skillID,
      overrideAccess: true,
    })
    if (!skill.active || !skill.runtimeSkillId) {
      errors.push({
        message: '发布前所有技能必须启用并配置 Runtime 技能标识。',
        path: 'skills',
      })
    }
  }

  const versionPattern = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/
  for (const key of ['minimumStudioVersion', 'minimumRuntimeVersion'] as const) {
    const value = next[key]
    if (value && !versionPattern.test(String(value))) {
      errors.push({ message: '版本必须使用 1.2.3 或 1.2.3-beta 格式。', path: key })
    }
  }

  if (errors.length) throw new ValidationError({ errors, req })
  return data
}

export const assignReleaseVersion: CollectionBeforeChangeHook = ({ data, originalDoc, req }) => {
  if (
    originalDoc?.releaseVersion &&
    data.templateKey !== undefined &&
    data.templateKey !== originalDoc.templateKey
  ) {
    throw new ValidationError({
      errors: [{ message: '首次发布后不能修改稳定标识。', path: 'templateKey' }],
      req,
    })
  }

  const next = { ...originalDoc, ...data }
  if (next._status !== 'published') return data

  const publishedFingerprint = fingerprint(next)
  if (publishedFingerprint === originalDoc?.publishedFingerprint) return data

  return {
    ...data,
    publishedFingerprint,
    releaseVersion: Number(originalDoc?.releaseVersion || 0) + 1,
  }
}
