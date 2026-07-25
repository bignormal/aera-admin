import type { BeforeListServerProps } from 'payload'

import { AdminIcon } from './AdminIcon'
import { toAgentStats } from './adminStats'

const icons = ['agents', 'dashboard', 'categories', 'skills'] as const

export async function AgentListOverview({
  hasCreatePermission,
  newDocumentURL,
  payload,
  user,
}: BeforeListServerProps) {
  let stats: ReturnType<typeof toAgentStats> | null = null

  try {
    const monthStart = new Date()
    monthStart.setDate(monthStart.getDate() - 30)

    const [all, published, draft, recent] = await Promise.all([
      payload.count({ collection: 'agent-templates', overrideAccess: false, user }),
      payload.count({
        collection: 'agent-templates',
        overrideAccess: false,
        user,
        where: { _status: { equals: 'published' } },
      }),
      payload.count({
        collection: 'agent-templates',
        overrideAccess: false,
        user,
        where: { _status: { equals: 'draft' } },
      }),
      payload.count({
        collection: 'agent-templates',
        overrideAccess: false,
        user,
        where: { createdAt: { greater_than_equal: monthStart.toISOString() } },
      }),
    ])

    stats = toAgentStats({
      all: all.totalDocs,
      draft: draft.totalDocs,
      published: published.totalDocs,
      recent: recent.totalDocs,
    })
  } catch {
    stats = null
  }

  return (
    <section className="ae-agent-overview" data-testid="agent-list-overview">
      <div className="ae-page-intro">
        <div>
          <h1>官方智能体</h1>
          <p>维护桌面端可发现、安装和更新的官方专家模板</p>
        </div>
        {hasCreatePermission ? (
          <a className="ae-primary-action" href={newDocumentURL}>
            <span aria-hidden="true">＋</span>
            创建智能体
          </a>
        ) : null}
      </div>
      {stats ? (
        <div className="ae-agent-stats">
          {stats.map((stat, index) => (
            <article className={`ae-agent-stat ae-agent-stat--${stat.key}`} key={stat.key}>
              <span className="ae-agent-stat__icon">
                <AdminIcon name={icons[index]} />
              </span>
              <span>
                <small>{stat.label}</small>
                <strong>{stat.value}</strong>
              </span>
            </article>
          ))}
        </div>
      ) : (
        <div className="ae-overview-error">概览暂时无法加载，智能体列表仍可正常使用。</div>
      )}
    </section>
  )
}
