import {
  AuditOutlined,
  CheckSquareOutlined,
  DashboardOutlined,
  DatabaseOutlined,
  DesktopOutlined,
  MenuFoldOutlined,
  MenuUnfoldOutlined,
  SafetyCertificateOutlined,
  SearchOutlined,
  SettingOutlined,
  TeamOutlined,
} from '@ant-design/icons';
import { Avatar, Breadcrumb, Button, Input, Layout, Menu, Space, Tag, Typography } from 'antd';
import { useMemo, useState } from 'react';
import { Outlet, useLocation, useNavigate } from 'react-router-dom';

import '../styles/global.css';

const { Content, Header, Sider } = Layout;

const navigation = [
  { key: '/dashboard', label: '工作台', icon: <DashboardOutlined /> },
  { key: '/security/admins', label: '内部管理员', icon: <TeamOutlined /> },
  { key: '/security/roles', label: '角色与权限', icon: <SafetyCertificateOutlined /> },
  { key: '/cloud/users', label: '用户与访问', icon: <DatabaseOutlined /> },
  { key: '/cloud/devices', label: '设备与会话', icon: <DesktopOutlined /> },
  { key: '/approvals', label: '处置审批', icon: <CheckSquareOutlined /> },
  { key: '/audit', label: '审计记录', icon: <AuditOutlined /> },
  { key: '/system/health', label: '服务健康', icon: <SettingOutlined /> },
] as const;

export function AdminLayout() {
  const [collapsed, setCollapsed] = useState(false);
  const location = useLocation();
  const navigate = useNavigate();
  const active = useMemo(
    () => navigation.find((item) => location.pathname.startsWith(item.key)) ?? navigation[0],
    [location.pathname],
  );

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
          items={navigation.map((item) => ({ ...item }))}
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
            <Input
              className="admin-global-search"
              prefix={<SearchOutlined />}
              placeholder="搜索用户 ID、设备 ID 或操作 ID"
              aria-label="全局搜索"
            />
          </Space>
          <Space size={12}>
            <Tag color="blue">内部系统</Tag>
            <Avatar size={32}>管</Avatar>
            <span className="admin-operator">
              <strong>管理员</strong>
              <small>安全会话</small>
            </span>
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
