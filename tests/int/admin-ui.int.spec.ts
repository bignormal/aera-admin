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
      new URL('../../admin-web/src/views/publishing/modules/official-agents-panel.vue', import.meta.url),
      'utf8',
    )

    expect(source).toContain('executeOfficialRollback(row.releaseId, row.approvalId)')
    expect(source).not.toContain('executeOfficialRollback(row.releaseId, row.id)')
  })
})
