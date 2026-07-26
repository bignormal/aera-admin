import { Alert, Button, Result, Spin } from 'antd';
import type { PropsWithChildren, ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router-dom';

import { hasAnyPermission, hasPermission, type Permission } from '../api/contracts';
import { useAuth } from './AuthProvider';

export function FullPageLoader() {
  return (
    <div className="auth-boundary-state" role="status" aria-label="正在验证管理员会话">
      <Spin size="large" />
      <span>正在验证安全会话…</span>
    </div>
  );
}

export function ProtectedRoute({ children }: PropsWithChildren) {
  const auth = useAuth();
  const location = useLocation();
  if (auth.loading) return <FullPageLoader />;
  if (auth.unavailable) {
    return (
      <Result
        status="500"
        title="认证服务暂时不可用"
        subTitle="为保护内部数据，系统未在认证状态不明时降级放行。"
        extra={<Button onClick={() => void auth.refreshSession()}>重新检查</Button>}
      />
    );
  }
  if (!auth.session) return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  return children;
}

interface RequirePermissionProps extends PropsWithChildren {
  permission?: Permission;
  anyOf?: readonly Permission[];
}

export function RequirePermission({ permission, anyOf, children }: RequirePermissionProps) {
  const auth = useAuth();
  if (!auth.session) return <Navigate to="/login" replace />;
  const granted = auth.session.administrator.permissions;
  const allowed = permission ? hasPermission(granted, permission) : hasAnyPermission(granted, anyOf ?? []);
  if (!allowed) {
    return (
      <Result
        status="403"
        title="无权访问此页面"
        subTitle="菜单过滤只改善体验，Aera Admin 后端仍会独立校验每一次操作。"
      />
    );
  }
  return children;
}

interface PermissionGateProps {
  permission?: Permission;
  anyOf?: readonly Permission[];
  fallback?: ReactNode;
  children: ReactNode;
}

export function PermissionGate({ permission, anyOf, fallback = null, children }: PermissionGateProps) {
  const auth = useAuth();
  if (!auth.session) return fallback;
  const granted = auth.session.administrator.permissions;
  const allowed = permission ? hasPermission(granted, permission) : hasAnyPermission(granted, anyOf ?? []);
  return allowed ? children : fallback;
}

export function SecurityNotice() {
  return (
    <Alert
      type="info"
      showIcon
      message="仅供公司内部授权人员使用"
      description="所有认证、授权拒绝和高风险操作都会进入防篡改审计链。"
    />
  );
}
