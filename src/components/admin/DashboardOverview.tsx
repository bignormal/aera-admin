import type { ServerProps } from 'payload'

import { AdminIcon, type AdminIconName } from './AdminIcon'

const dashboardItems: {
  collection: 'agent-templates' | 'expert-categories' | 'media' | 'skill-catalog'
  href: string
  icon: AdminIconName
  label: string
}[] = [
  {
    collection: 'agent-templates',
    href: '/admin/collections/agent-templates',
    icon: 'agents',
    label: '官方智能体',
  },
  {
    collection: 'expert-categories',
    href: '/admin/collections/expert-categories',
    icon: 'categories',
    label: '智能体分类',
  },
  {
    collection: 'skill-catalog',
    href: '/admin/collections/skill-catalog',
    icon: 'skills',
    label: '技能目录',
  },
  { collection: 'media', href: '/admin/collections/media', icon: 'media', label: '媒体资源' },
]

export async function DashboardOverview({ payload, user }: ServerProps) {
  const values = await Promise.all(
    dashboardItems.map(async (item) => {
      try {
        const result = await payload.count({
          collection: item.collection,
          overrideAccess: false,
          user,
        })
        return result.totalDocs
      } catch {
        return null
      }
    }),
  )

  return (
    <section className="ae-dashboard" data-testid="agentera-dashboard-overview">
      <div className="ae-dashboard__welcome">
        <div>
          <h1>欢迎回来</h1>
          <p>在这里维护 AgentEra 桌面端使用的官方专家内容。</p>
        </div>
        <span className="ae-dashboard__date">
          {new Intl.DateTimeFormat('zh-CN', { dateStyle: 'long' }).format(new Date())}
        </span>
      </div>
      <div className="ae-dashboard__grid">
        {dashboardItems.map((item, index) => (
          <a className="ae-dashboard-card" href={item.href} key={item.collection}>
            <span className="ae-dashboard-card__icon">
              <AdminIcon name={item.icon} />
            </span>
            <span>
              <small>{item.label}</small>
              <strong>{values[index] ?? '—'}</strong>
            </span>
          </a>
        ))}
      </div>
    </section>
  )
}
