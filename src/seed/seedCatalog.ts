import type { DataFromCollectionSlug, Payload } from 'payload'

const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAEUlEQVR4nGNQTX79H4QZYAwAUe4JyX4GS0cAAAAASUVORK5CYII=',
  'base64',
)

const expertSeeds = [
  [
    'product-manager',
    '产品经理',
    'product',
    '产品',
    '负责需求分析和产品规划。',
    '你是一名产品经理，负责澄清需求、分析优先级并输出可执行的产品方案。',
  ],
  [
    'ui-ux-designer',
    'UI/UX 设计师',
    'design',
    '设计',
    '负责用户体验和界面设计。',
    '你是一名 UI/UX 设计师，负责研究用户目标并输出清晰、可实现的交互与视觉建议。',
  ],
  [
    'software-engineer',
    '软件工程师',
    'engineering',
    '研发',
    '负责软件设计、开发和验证。',
    '你是一名软件工程师，负责分析技术问题、设计可维护方案并通过测试验证实现。',
  ],
  [
    'data-analyst',
    '数据分析师',
    'data',
    '数据',
    '负责数据分析和洞察表达。',
    '你是一名数据分析师，负责验证数据口径、选择分析方法并清晰解释结论与限制。',
  ],
  [
    'content-creator',
    '内容创作专家',
    'content',
    '内容',
    '负责内容策划、撰写和优化。',
    '你是一名内容创作专家，负责理解受众和目标并产出结构清晰、符合渠道特点的内容。',
  ],
  [
    'marketing-operations',
    '市场运营专家',
    'marketing',
    '市场',
    '负责活动策划和运营复盘。',
    '你是一名市场运营专家，负责制定运营目标、设计活动方案并用数据评估效果。',
  ],
] as const

type SeedCollection = 'agent-templates' | 'expert-categories' | 'media' | 'skill-catalog'

async function findOne<TCollection extends SeedCollection>(
  payload: Payload,
  collection: TCollection,
  field: string,
  value: string,
): Promise<DataFromCollectionSlug<TCollection> | undefined> {
  const result = await payload.find({
    collection,
    limit: 1,
    overrideAccess: true,
    where: { [field]: { equals: value } },
  })

  return result.docs[0] as DataFromCollectionSlug<TCollection> | undefined
}

export async function seedCatalog(payload: Payload) {
  let avatar = await findOne(payload, 'media', 'attribution', 'agentera-seed:default-avatar')
  if (!avatar) {
    avatar = await payload.create({
      collection: 'media',
      data: {
        alt: 'Aera 默认专家头像',
        attribution: 'agentera-seed:default-avatar',
      },
      file: {
        data: png,
        mimetype: 'image/png',
        name: 'seed-agent-avatar.png',
        size: png.length,
      },
      overrideAccess: true,
    })
  }

  let skill = await findOne(payload, 'skill-catalog', 'key', 'general-research')
  if (!skill) {
    skill = await payload.create({
      collection: 'skill-catalog',
      data: {
        active: true,
        key: 'general-research',
        name: '通用研究',
        runtimeSkillId: 'web-research',
      },
      overrideAccess: true,
    })
  }

  let createdTemplates = 0
  let skippedTemplates = 0

  for (const [
    templateKey,
    name,
    categoryKey,
    categoryName,
    introduction,
    rolePrompt,
  ] of expertSeeds) {
    let category = await findOne(payload, 'expert-categories', 'key', categoryKey)
    if (!category) {
      category = await payload.create({
        collection: 'expert-categories',
        data: {
          active: true,
          key: categoryKey,
          name: categoryName,
          sortOrder: expertSeeds.findIndex((item) => item[0] === templateKey) + 1,
        },
        overrideAccess: true,
      })
    }

    const existing = await findOne(payload, 'agent-templates', 'templateKey', templateKey)
    if (existing) {
      skippedTemplates += 1
      continue
    }

    await payload.create({
      collection: 'agent-templates',
      data: {
        _status: 'draft',
        avatar: avatar.id,
        category: category.id,
        introduction,
        name,
        rolePrompt,
        skills: [skill.id],
        tags: [{ value: categoryName }],
        templateKey,
      },
      draft: true,
      overrideAccess: true,
    })
    createdTemplates += 1
  }

  return { createdTemplates, skippedTemplates }
}
