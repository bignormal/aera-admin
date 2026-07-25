import type { ReactNode, SVGProps } from 'react'

export type AdminIconName =
  | 'agents'
  | 'announcements'
  | 'approvals'
  | 'audit'
  | 'categories'
  | 'dashboard'
  | 'media'
  | 'models'
  | 'orders'
  | 'plans'
  | 'runtime'
  | 'settings'
  | 'skills'
  | 'tasks'
  | 'tenants'
  | 'users'

const paths: Record<AdminIconName, ReactNode> = {
  agents: (
    <>
      <rect height="16" rx="3" width="18" x="3" y="4" />
      <path d="M8 9h8M8 13h5" />
    </>
  ),
  announcements: (
    <>
      <rect height="14" rx="2" width="18" x="3" y="5" />
      <path d="M7 9h10M7 13h7M7 17h4" />
    </>
  ),
  approvals: (
    <>
      <path d="M12 3l8 4v5c0 5-3.4 8.3-8 9-4.6-.7-8-4-8-9V7l8-4z" />
      <path d="M8 12l2.5 2.5L16 9" />
    </>
  ),
  audit: (
    <>
      <rect height="16" rx="2" width="14" x="5" y="4" />
      <path d="M9 8h6M9 12h6M9 16h4" />
    </>
  ),
  categories: <path d="M4 5h7l2 3h7v11H4z" />,
  dashboard: <path d="M3 12l9-8 9 8v8a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z" />,
  media: (
    <>
      <rect height="14" rx="2" width="18" x="3" y="5" />
      <circle cx="8" cy="10" r="2" />
      <path d="M21 16l-5-5-7 7" />
    </>
  ),
  models: (
    <>
      <rect height="4" rx="1" width="10" x="7" y="3" />
      <rect height="12" rx="2" width="14" x="5" y="9" />
      <path d="M9 13h6M9 17h4" />
    </>
  ),
  orders: (
    <>
      <rect height="13" rx="2" width="18" x="3" y="6" />
      <path d="M3 10h18M7 15h4" />
    </>
  ),
  plans: (
    <>
      <path d="M4 7h16v12H4zM7 4h10v3" />
      <path d="M8 12h8" />
    </>
  ),
  runtime: (
    <>
      <path d="M12 2v6M12 16v6M2 12h6M16 12h6" />
      <path d="M4.9 4.9l4.2 4.2M14.9 14.9l4.2 4.2M19.1 4.9l-4.2 4.2M9.1 14.9l-4.2 4.2" />
    </>
  ),
  settings: (
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M12 2.8v3M12 18.2v3M2.8 12h3M18.2 12h3M5.5 5.5l2.1 2.1M16.4 16.4l2.1 2.1M18.5 5.5l-2.1 2.1M7.6 16.4l-2.1 2.1" />
    </>
  ),
  skills: <path d="M12 3l2.2 4.6 5 .7-3.6 3.6.9 5.1-4.5-2.4L7.5 17l.9-5.1-3.6-3.6 5-.7z" />,
  tasks: (
    <>
      <rect height="14" rx="2" width="18" x="3" y="5" />
      <path d="M8 9l3 3-3 3M13 15h3" />
    </>
  ),
  tenants: (
    <>
      <path d="M4 21V7l8-4 8 4v14M8 21v-5h8v5" />
      <path d="M8 9h1M15 9h1M8 12h1M15 12h1" />
    </>
  ),
  users: (
    <>
      <circle cx="12" cy="8" r="4" />
      <path d="M4 21c.8-5 3.5-7 8-7s7.2 2 8 7" />
    </>
  ),
}

export function AdminIcon({ name, ...props }: { name: AdminIconName } & SVGProps<SVGSVGElement>) {
  return (
    <svg
      aria-hidden="true"
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      viewBox="0 0 24 24"
      {...props}
    >
      {paths[name]}
    </svg>
  )
}
