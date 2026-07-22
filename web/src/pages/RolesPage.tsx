import { CheckCircleFilled, CloseCircleOutlined, SafetyCertificateOutlined } from '@ant-design/icons';
import type { ColumnsType } from 'antd/es/table';
import { Alert, Card, Table, Tag, Typography } from 'antd';

import {
  hasPermission,
  permissions,
  roleLabels,
  roles,
  type AdminRole,
  type Permission,
} from '../api/contracts';

const permissionLabels: Record<Permission, { group: string; label: string }> = {
  'administrator.manage': { group: '管理员安全', label: '管理内部管理员' },
  'administrator.read': { group: '管理员安全', label: '查看内部管理员' },
  'cloud_user.read': { group: 'Cloud 用户', label: '查看脱敏用户信息' },
  'cloud_user.read_technical': { group: 'Cloud 用户', label: '查看技术字段' },
  'cloud_identity.lookup_exact': { group: 'Cloud 用户', label: '完整身份精确检索' },
  'cloud_device.read': { group: '设备与会话', label: '查看设备与会话' },
  'cloud_session.revoke': { group: '设备与会话', label: '撤销单个会话' },
  'cloud_device.revoke': { group: '设备与会话', label: '撤销单个设备' },
  'account_lifecycle.initiate': { group: '账号处置', label: '发起禁用或恢复' },
  'account_lifecycle.approve': { group: '账号处置', label: '审批禁用或恢复' },
  'audit.read_full': { group: '审计', label: '查看完整审计' },
  'audit.read_own': { group: '审计', label: '查看本人操作审计' },
  'service_health.read': { group: '系统', label: '查看服务健康' },
  'system_settings.read': { group: '系统设置', label: '查看安全策略与原因目录' },
  'system_settings.manage': { group: '系统设置', label: '管理安全策略与原因目录' },
};

interface PermissionRow {
  key: Permission;
  group: string;
  label: string;
}

const rows: PermissionRow[] = permissions.map((permission) => ({
  key: permission,
  ...permissionLabels[permission],
}));

const roleDescriptions: Record<AdminRole, string> = {
  super_admin: '管理员安全、审批与系统策略管理',
  developer: '技术诊断与服务健康',
  operator: '日常运营处置的发起方',
  support: '用户、设备与会话支持',
  finance: '一期不授予安全控制台权限',
  auditor: '只读管理员、审计、健康与系统设置',
};

export function RolesPage() {
  const columns: ColumnsType<PermissionRow> = [
    { title: '权限域', dataIndex: 'group', width: 130 },
    {
      title: '权限',
      key: 'permission',
      width: 220,
      render: (_, item) => (
        <div className="table-primary-cell">
          <strong>{item.label}</strong>
          <span>{item.key}</span>
        </div>
      ),
    },
    ...roles.map((role) => ({
      title: roleLabels[role],
      key: role,
      width: 120,
      align: 'center' as const,
      render: (_: unknown, item: PermissionRow) =>
        hasPermission(role, item.key) ? (
          <CheckCircleFilled className="permission-allowed" aria-label="允许" />
        ) : (
          <CloseCircleOutlined className="permission-denied" aria-label="不允许" />
        ),
    })),
  ];

  return (
    <>
      <div className="page-heading">
        <div>
          <Typography.Title level={3}>角色与权限</Typography.Title>
          <Typography.Text type="secondary">六种固定角色，只读展示，不支持自定义角色或越权叠加</Typography.Text>
        </div>
        <Tag icon={<SafetyCertificateOutlined />} color="blue">固定策略</Tag>
      </div>
      <Alert
        className="page-alert"
        type="info"
        showIcon
        message="页面矩阵与后端固定 RBAC 保持一致"
        description="菜单和路由守卫只用于减少误操作；每个 API 请求仍由后端基于当前会话角色独立授权。"
      />
      <div className="role-summary-grid">
        {roles.map((role) => (
          <Card key={role} size="small" className="role-summary-card">
            <Typography.Text strong>{roleLabels[role]}</Typography.Text>
            <Typography.Text type="secondary">{roleDescriptions[role]}</Typography.Text>
          </Card>
        ))}
      </div>
      <Card className="data-card" variant="borderless">
        <Table rowKey="key" columns={columns} dataSource={rows} pagination={false} scroll={{ x: 1100 }} size="middle" />
      </Card>
    </>
  );
}
