import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

import { agentInitial, toAgentStats } from '../../src/components/admin/adminStats'

describe('admin UI helpers', () => {
  it('maps Payload counts to the official-agent overview', () => {
    expect(toAgentStats({ all: 6, draft: 4, published: 2, recent: 3 })).toEqual([
      { key: 'all', label: '全部智能体', value: 6 },
      { key: 'published', label: '已发布', value: 2 },
      { key: 'draft', label: '草稿', value: 4 },
      { key: 'recent', label: '本月新增', value: 3 },
    ])
  })

  it('uses a readable first character when no avatar is available', () => {
    expect(agentInitial('UI/UX 设计师')).toBe('U')
    expect(agentInitial('产品经理')).toBe('产')
    expect(agentInitial('')).toBe('A')
  })

  it('does not expose the deprecated data-management backup jobs', () => {
    const source = readFileSync(
      new URL('../../admin-web/src/views/system/data/index.vue', import.meta.url),
      'utf8',
    )

    expect(source).not.toContain('dataBackupJobs')
    expect(source).not.toContain('数据代理任务')
  })

  it('clears stale platform readiness before revalidation', () => {
    const source = readFileSync(
      new URL('../../admin-web/src/views/home/index.vue', import.meta.url),
      'utf8',
    )

    expect(source).toMatch(
      /async function validateResources\(\) \{[\s\S]*?readiness\.value = undefined;[\s\S]*?getPlatformReadiness\(\)/,
    )
  })

  it('uses the cloud approval id when executing official Agent rollback', () => {
    const source = readFileSync(
      new URL(
        '../../admin-web/src/views/publishing/modules/official-agents-panel.vue',
        import.meta.url,
      ),
      'utf8',
    )

    expect(source).toContain('executeOfficialRollback(row.releaseId, row.approvalId)')
    expect(source).not.toContain('executeOfficialRollback(row.releaseId, row.id)')
  })

  it('separates release and rollback controls by administrator duty', () => {
    const source = readFileSync(
      new URL(
        '../../admin-web/src/views/publishing/modules/official-agents-panel.vue',
        import.meta.url,
      ),
      'utf8',
    )

    expect(source).toContain(
      "const canRelease = computed(() => can('official-agents:release:write'))",
    )
    expect(source).toContain(
      "const canRollback = computed(() => can('official-agents:rollback:write'))",
    )
    expect(source).toMatch(/canRollback\.value[\s\S]*?openAction\('create-rollback'/)
    expect(source).toContain("if (!canRollback.value) return '只读'")
  })

  it('routes every real official Agent duty to the shared workbench', () => {
    const source = readFileSync(
      new URL('../../admin-web/src/router/elegant/routes.ts', import.meta.url),
      'utf8',
    )
    const publishingRoute = source.match(/name: 'publishing',[\s\S]*?\n  \},/)?.[0]

    expect(publishingRoute).toContain("capability: 'official-agents:read'")
  })

  it('keeps publishing on one element root for route transitions', () => {
    const source = readFileSync(
      new URL('../../admin-web/src/views/publishing/index.vue', import.meta.url),
      'utf8',
    )

    expect(source).toMatch(/<template>\s*<div[^>]*>[\s\S]*<ResourcePageShell/)
  })

  it('keeps every user-visible administration surface on the Aera brand', () => {
    const visibleFiles = [
      '../../src/components/admin/AgentEraLogo.tsx',
      '../../src/components/admin/DashboardOverview.tsx',
      '../../admin-web/.env',
      '../../admin-web/src/locales/langs/zh-cn.ts',
      '../../admin-web/src/views/_builtin/login/index.vue',
      '../../admin-web/src/views/home/index.vue',
      '../../admin-web/src/views/agents/index.vue',
    ]

    for (const relativePath of visibleFiles) {
      const source = readFileSync(new URL(relativePath, import.meta.url), 'utf8')
      expect(source, relativePath).toContain('Aera')
      expect(source, relativePath).not.toMatch(
        /\b(?:AgentEra|WorkBuddy|AionUI)\b|AgentEra Studio|Hermes (?:Studio|Runtime)/u,
      )
    }
  })
})
