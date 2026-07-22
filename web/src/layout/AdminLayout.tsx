import {
  AuditOutlined,
  CheckSquareOutlined,
  ControlOutlined,
  DashboardOutlined,
  DatabaseOutlined,
  DesktopOutlined,
  MenuFoldOutlined,
  MenuUnfoldOutlined,
  LogoutOutlined,
  FileProtectOutlined,
  RobotOutlined,
  RocketOutlined,
  SafetyCertificateOutlined,
  SettingOutlined,
  TeamOutlined,
} from '@ant-design/icons';
import { Avatar, Breadcrumb, Button, Dropdown, Layout, Menu, Space, Tag, Typography } from 'antd';
import { useMemo, useState } from 'react';
import { Outlet, useLocation, useNavigate } from 'react-router-dom';

import { hasAnyPermission, roleLabels, type Permission } from '../api/contracts';
import { useAuth } from '../auth/AuthProvider';
import { FullPageLoader } from '../auth/PermissionGate';
import '../styles/global.css';

const { Content, Header, Sider } = Layout;

interface NavigationItem {
  key: string;
  label: string;
  icon: React.ReactNode;
  permissions?: readonly Permission[];
}

const navigation: NavigationItem[] = [
  { key: '/dashboard', label: '工作台', icon: <DashboardOutlined /> },
  { key: '/security/admins', label: '内部管理员', icon: <TeamOutlined />, permissions: ['administrator.read'] },
  { key: '/security/roles', label: '角色与权限', icon: <SafetyCertificateOutlined />, permissions: ['administrator.read'] },
  { key: '/cloud/users', label: '用户与访问', icon: <DatabaseOutlined />, permissions: ['cloud_user.read'] },
  { key: '/cloud/devices', label: '设备与会话', icon: <DesktopOutlined />, permissions: ['cloud_device.read'] },
  { key: '/approvals', label: '处置审批', icon: <CheckSquareOutlined />, permissions: ['account_lifecycle.initiate', 'account_lifecycle.approve'] },
  { key: '/official-agents', label: '官方 Agent', icon: <RobotOutlined />, permissions: ['official_agent.read'] },
  { key: '/official-agent-reviews', label: '内容审核', icon: <FileProtectOutlined />, permissions: ['official_agent.review'] },
  {
    key: '/official-agent-releases',
    label: '发布与回滚',
    icon: <RocketOutlined />,
    permissions: ['official_agent.release.manage', 'official_agent.rollback.request', 'official_agent.audit.read'],
  },
  { key: '/audit', label: '审计记录', icon: <AuditOutlined />, permissions: ['audit.read_full', 'audit.read_own'] },
  { key: '/system/settings', label: '系统设置', icon: <ControlOutlined />, permissions: ['system_settings.read'] },
  { key: '/system/health', label: '服务健康', icon: <SettingOutlined />, permissions: ['service_health.read'] },
];

export function AdminLayout() {
  const [collapsed, setCollapsed] = useState(false);
  const location = useLocation();
  const navigate = useNavigate();
  const auth = useAuth();
  const role = auth.session?.administrator.role;
  const visibleNavigation = useMemo(
    () => navigation.filter((item) => !item.permissions || (role && hasAnyPermission(role, item.permissions))),
    [role],
  );
  const active = useMemo(
    () => visibleNavigation.find((item) => location.pathname.startsWith(item.key)) ?? visibleNavigation[0],
    [location.pathname, visibleNavigation],
  );

  if (!auth.session || !active) return <FullPageLoader />;

  return (
    <Layout className="admin-shell">
      <Sider
        className="admin-sider"
        width={224}
        collapsedWidth={72}
        collapsed={collapsed}
        trigger={null}
      >
        <div className="admin-brand">
          <span className="admin-brand-mark" aria-hidden="true">
            A
          </span>
          {!collapsed && (
            <span className="admin-brand-copy">
              <strong>Aera Admin</strong>
              <small>内部运营控制台</small>
            </span>
          )}
        </div>
        <Menu
          theme="dark"
          mode="inline"
          selectedKeys={[active.key]}
          items={visibleNavigation.map((item) => ({ ...item }))}
          onClick={({ key }) => void navigate(key)}
        />
        {!collapsed && (
          <div className="admin-environment">
            <span className="admin-environment-dot" />
            内部安全网络
          </div>
        )}
      </Sider>

      <Layout>
        <Header className="admin-header">
          <Space size={12}>
            <Button
              type="text"
              aria-label={collapsed ? '展开侧栏' : '收起侧栏'}
              icon={collapsed ? <MenuUnfoldOutlined /> : <MenuFoldOutlined />}
              onClick={() => setCollapsed((value) => !value)}
            />
            <Typography.Text strong>{active.label}</Typography.Text>
          </Space>
          <Space size={12}>
            <Tag color="blue">内部系统</Tag>
            <Tag color={auth.session.administrator.mfa_method === 'recovery' ? 'orange' : 'green'}>
              {auth.session.administrator.mfa_method === 'recovery' ? '恢复会话' : 'TOTP 会话'}
            </Tag>
            <Dropdown
              trigger={['click']}
              menu={{
                items: [{ key: 'logout', icon: <LogoutOutlined />, label: '安全退出' }],
                onClick: () =>
                  void auth
                    .logout()
                    .catch(() => undefined)
                    .finally(() => navigate('/login', { replace: true })),
              }}
            >
              <Button type="text" className="admin-account-button">
                <Avatar size={32}>{auth.session.display_name.slice(0, 1)}</Avatar>
                <span className="admin-operator">
                  <strong>{auth.session.display_name}</strong>
                  <small>{roleLabels[auth.session.administrator.role]}</small>
                </span>
              </Button>
            </Dropdown>
          </Space>
        </Header>

        <div className="admin-context-bar">
          <Breadcrumb items={[{ title: 'Aera' }, { title: active.label }]} />
          <Typography.Text type="secondary">仅供公司内部授权人员使用</Typography.Text>
        </div>

        <div className="admin-tabs" role="navigation" aria-label="已打开页面">
          <span className="admin-tab admin-tab-active">{active.label}</span>
        </div>

        <Content className="admin-content">
          <Outlet />
        </Content>
      </Layout>
    </Layout>
  );
}
