export type AgentCounts = {
  all: number
  draft: number
  published: number
  recent: number
}

export function toAgentStats(counts: AgentCounts) {
  return [
    { key: 'all', label: '全部智能体', value: counts.all },
    { key: 'published', label: '已发布', value: counts.published },
    { key: 'draft', label: '草稿', value: counts.draft },
    { key: 'recent', label: '本月新增', value: counts.recent },
  ] as const
}

export function agentInitial(name: null | string | undefined): string {
  return name?.trim().charAt(0).toUpperCase() || 'A'
}
