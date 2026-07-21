import {
  Navigate,
  createBrowserRouter,
  createMemoryRouter,
  type RouteObject,
} from 'react-router-dom';

import { AdminLayout } from '../layout/AdminLayout';
import { DashboardPage } from '../pages/DashboardPage';
import { ModulePlaceholderPage } from '../pages/ModulePlaceholderPage';

const routes: RouteObject[] = [
  {
    path: '/',
    element: <AdminLayout />,
    children: [
      { index: true, element: <Navigate to="/dashboard" replace /> },
      { path: 'dashboard', element: <DashboardPage /> },
      { path: 'security/admins', element: <ModulePlaceholderPage title="内部管理员" /> },
      { path: 'security/roles', element: <ModulePlaceholderPage title="角色与权限" /> },
      { path: 'cloud/users', element: <ModulePlaceholderPage title="用户与访问" /> },
      { path: 'cloud/devices', element: <ModulePlaceholderPage title="设备与会话" /> },
      { path: 'approvals', element: <ModulePlaceholderPage title="处置审批" /> },
      { path: 'audit', element: <ModulePlaceholderPage title="审计记录" /> },
      { path: 'system/health', element: <ModulePlaceholderPage title="服务健康" /> },
    ],
  },
];

export function createAppRouter(initialEntries?: string[]) {
  if (initialEntries) {
    return createMemoryRouter(routes, { initialEntries });
  }
  return createBrowserRouter(routes);
}
