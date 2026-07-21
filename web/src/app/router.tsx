import {
  Navigate,
  createBrowserRouter,
  createMemoryRouter,
  type RouteObject,
} from 'react-router-dom';
import { lazy, Suspense, type ReactNode } from 'react';

import { RequirePermission, ProtectedRoute, FullPageLoader } from '../auth/PermissionGate';
import { AdminLayout } from '../layout/AdminLayout';
import { ModulePlaceholderPage } from '../pages/ModulePlaceholderPage';

const LoginPage = lazy(() => import('../pages/LoginPage').then((module) => ({ default: module.LoginPage })));
const ActivatePage = lazy(() => import('../pages/ActivatePage').then((module) => ({ default: module.ActivatePage })));
const DashboardPage = lazy(() => import('../pages/DashboardPage').then((module) => ({ default: module.DashboardPage })));
const AdministratorsPage = lazy(() => import('../pages/AdministratorsPage').then((module) => ({ default: module.AdministratorsPage })));
const RolesPage = lazy(() => import('../pages/RolesPage').then((module) => ({ default: module.RolesPage })));

function suspended(content: ReactNode) {
  return <Suspense fallback={<FullPageLoader />}>{content}</Suspense>;
}

const routes: RouteObject[] = [
  { path: '/login', element: suspended(<LoginPage />) },
  { path: '/activate', element: suspended(<ActivatePage />) },
  {
    path: '/',
    element: <ProtectedRoute><AdminLayout /></ProtectedRoute>,
    children: [
      { index: true, element: <Navigate to="/dashboard" replace /> },
      { path: 'dashboard', element: suspended(<DashboardPage />) },
      {
        path: 'security/admins',
        element: <RequirePermission permission="administrator.read">{suspended(<AdministratorsPage />)}</RequirePermission>,
      },
      {
        path: 'security/roles',
        element: <RequirePermission permission="administrator.read">{suspended(<RolesPage />)}</RequirePermission>,
      },
      {
        path: 'cloud/users',
        element: <RequirePermission permission="cloud_user.read"><ModulePlaceholderPage title="用户与访问" /></RequirePermission>,
      },
      {
        path: 'cloud/devices',
        element: <RequirePermission permission="cloud_device.read"><ModulePlaceholderPage title="设备与会话" /></RequirePermission>,
      },
      {
        path: 'approvals',
        element: <RequirePermission anyOf={['account_lifecycle.initiate', 'account_lifecycle.approve']}><ModulePlaceholderPage title="处置审批" /></RequirePermission>,
      },
      {
        path: 'audit',
        element: <RequirePermission anyOf={['audit.read_full', 'audit.read_own']}><ModulePlaceholderPage title="审计记录" /></RequirePermission>,
      },
      {
        path: 'system/health',
        element: <RequirePermission permission="service_health.read"><ModulePlaceholderPage title="服务健康" /></RequirePermission>,
      },
    ],
  },
  { path: '*', element: <Navigate to="/dashboard" replace /> },
];

export function createAppRouter(initialEntries?: string[]) {
  if (initialEntries) {
    return createMemoryRouter(routes, { initialEntries });
  }
  return createBrowserRouter(routes);
}
