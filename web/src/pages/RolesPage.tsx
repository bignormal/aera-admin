import {
  CheckCircleFilled,
  CloseCircleOutlined,
  DeleteOutlined,
  EditOutlined,
  PlusOutlined,
  SafetyCertificateOutlined,
} from '@ant-design/icons';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { ColumnsType } from 'antd/es/table';
import {
  Alert,
  Button,
  Card,
  Checkbox,
  Input,
  Modal,
  Popconfirm,
  Space,
  Table,
  Tag,
  Typography,
  message,
} from 'antd';
import { useRef, useState } from 'react';

import { APIError, postJSON, request } from '../api/client';
import {
  hasPermission,
  permissions as permissionCatalogFallback,
  roleLabel,
  type Permission,
  type RbacCatalog,
  type RbacRole,
  type RbacRoleList,
} from '../api/contracts';
import { useAuth } from '../auth/AuthProvider';
import { StepUpModal } from '../auth/StepUpModal';

const permissionLabels: Record<string, { group: string; label: string }> = {
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
  'official_agent.read': { group: '官方 Agent', label: '查看官方 Agent 资产' },
  'official_agent.draft.manage': { group: '官方 Agent', label: '创建与提交草稿' },
  'official_agent.review': { group: '官方 Agent', label: '审核并发布不可变版本' },
  'official_agent.release.manage': { group: '官方 Agent', label: '管理发布与灰度' },
  'official_agent.rollback.request': { group: '官方 Agent', label: '发起回滚审批' },
  'official_agent.rollback.approve': { group: '官方 Agent', label: '批准回滚审批' },
  'official_agent.audit.read': { group: '官方 Agent', label: '查看完整官方审计' },
};

function permissionLabel(code: string): { group: string; label: string } {
  return permissionLabels[code] ?? { group: '其他', label: code };
}

interface PermissionRow {
  key: string;
  group: string;
  label: string;
}

interface EditorState {
  mode: 'create' | 'edit';
  slug: string;
  name: string;
  description: string;
  isSystem: boolean;
  selected: string[];
}

const slugPattern = /^[a-z][a-z0-9_]{1,49}$/;

export function RolesPage() {
  const auth = useAuth();
  const queryClient = useQueryClient();
  const granted = auth.session?.administrator.permissions;
  const canManage = hasPermission(granted, 'administrator.manage');

  const catalogQuery = useQuery({
    queryKey: ['rbac-permissions'],
    queryFn: () => request<RbacCatalog>('/rbac/permissions'),
    enabled: Boolean(auth.session),
    retry: false,
  });
  const rolesQuery = useQuery({
    queryKey: ['rbac-roles'],
    queryFn: () => request<RbacRoleList>('/rbac/roles'),
    enabled: Boolean(auth.session),
    retry: false,
  });

  const [editor, setEditor] = useState<EditorState | null>(null);
  const [stepUpOpen, setStepUpOpen] = useState(false);
  const pendingRef = useRef<null | (() => Promise<void>)>(null);

  const catalog: string[] = catalogQuery.data?.permissions ?? [...permissionCatalogFallback];
  const rows: PermissionRow[] = catalog.map((code) => ({ key: code, ...permissionLabel(code) }));
  const roles: RbacRole[] = rolesQuery.data?.roles ?? [];

  const runProtected = async (operation: () => Promise<void>) => {
    try {
      await operation();
    } catch (error) {
      if (error instanceof APIError && error.code === 'STEP_UP_REQUIRED') {
        pendingRef.current = operation;
        setStepUpOpen(true);
        return;
      }
      message.error(error instanceof APIError ? error.message : '操作失败，请稍后重试');
    }
  };

  const afterStepUp = async () => {
    setStepUpOpen(false);
    const operation = pendingRef.current;
    pendingRef.current = null;
    if (operation) await runProtected(operation);
  };

  const openCreate = () =>
    setEditor({ mode: 'create', slug: '', name: '', description: '', isSystem: false, selected: [] });
  const openEdit = (role: RbacRole) =>
    setEditor({
      mode: 'edit',
      slug: role.slug,
      name: role.name,
      description: role.description,
      isSystem: role.is_system,
      selected: [...role.permissions],
    });

  const togglePermission = (code: string, checked: boolean) => {
    setEditor((current) => {
      if (!current) return current;
      const next = new Set(current.selected);
      if (checked) next.add(code);
      else next.delete(code);
      return { ...current, selected: Array.from(next) };
    });
  };

  const submitEditor = () => {
    if (!editor) return;
    const trimmedName = editor.name.trim();
    if (editor.mode === 'create' && !slugPattern.test(editor.slug)) {
      message.error('角色标识需为小写字母开头，仅含小写字母、数字与下划线');
      return;
    }
    if (trimmedName.length < 1) {
      message.error('请填写角色名称');
      return;
    }
    if (editor.slug === 'super_admin' && !editor.selected.includes('administrator.manage')) {
      message.error('超级管理员必须保留“管理内部管理员”权限');
      return;
    }
    const current = editor;
    void runProtected(async () => {
      if (current.mode === 'create') {
        await postJSON<RbacRole>('/rbac/roles', {
          slug: current.slug,
          name: trimmedName,
          description: current.description,
          permissions: current.selected,
        });
      } else {
        await request<RbacRole>(`/rbac/roles/${current.slug}`, {
          method: 'PATCH',
          body: JSON.stringify({
            name: trimmedName,
            description: current.description,
            permissions: current.selected,
          }),
        });
      }
      await queryClient.invalidateQueries({ queryKey: ['rbac-roles'] });
      message.success(current.mode === 'create' ? '角色已创建' : '角色已更新');
      setEditor(null);
    });
  };

  const deleteRole = (slug: string) => {
    void runProtected(async () => {
      await request<unknown>(`/rbac/roles/${slug}`, { method: 'DELETE' });
      await queryClient.invalidateQueries({ queryKey: ['rbac-roles'] });
      message.success('角色已删除');
    });
  };

  const matrixColumns: ColumnsType<PermissionRow> = [
    { title: '权限域', dataIndex: 'group', width: 120, fixed: 'left' as const },
    {
      title: '权限',
      key: 'permission',
      width: 220,
      fixed: 'left' as const,
      render: (_, item) => (
        <div className="table-primary-cell">
          <strong>{item.label}</strong>
          <span>{item.key}</span>
        </div>
      ),
    },
    ...roles.map((role) => ({
      title: roleLabel(role.slug),
      key: role.slug,
      width: 120,
      align: 'center' as const,
      render: (_: unknown, item: PermissionRow) =>
        role.permissions.includes(item.key as Permission) ? (
          <CheckCircleFilled className="permission-allowed" aria-label="允许" />
        ) : (
          <CloseCircleOutlined className="permission-denied" aria-label="不允许" />
        ),
    })),
  ];

  const groupedCatalog = Array.from(
    catalog.reduce((accumulator, code) => {
      const { group } = permissionLabel(code);
      const list = accumulator.get(group) ?? [];
      list.push(code);
      accumulator.set(group, list);
      return accumulator;
    }, new Map<string, string[]>()),
  );

  return (
    <>
      <div className="page-heading">
        <div>
          <Typography.Title level={3}>角色与权限</Typography.Title>
          <Typography.Text type="secondary">
            {canManage ? '可新建自定义角色并配置权限；系统内置角色不可删除。' : '只读查看角色权限矩阵。'}
          </Typography.Text>
        </div>
        <Space>
          <Tag icon={<SafetyCertificateOutlined />} color="blue">
            权限目录由代码定义
          </Tag>
          {canManage && (
            <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>
              新建角色
            </Button>
          )}
        </Space>
      </div>
      <Alert
        className="page-alert"
        type="info"
        showIcon
        message="角色改动即时生效，后端对每个请求独立授权"
        description="权限只能从代码定义的目录中勾选；超级管理员的“管理内部管理员”权限受保护，不可移除。"
      />

      <div className="role-summary-grid">
        {roles.map((role) => (
          <Card key={role.slug} size="small" className="role-summary-card">
            <Space direction="vertical" size={4} style={{ width: '100%' }}>
              <Space size={8} wrap>
                <Typography.Text strong>{role.name}</Typography.Text>
                {role.is_system ? <Tag color="geekblue">系统内置</Tag> : <Tag color="green">自定义</Tag>}
              </Space>
              <Typography.Text type="secondary">{role.description || '（无描述）'}</Typography.Text>
              <Typography.Text type="secondary">
                标识：{role.slug} · 权限 {role.permissions.length} 项 · 使用中 {role.user_count} 人
              </Typography.Text>
              {canManage && (
                <Space>
                  <Button size="small" icon={<EditOutlined />} onClick={() => openEdit(role)}>
                    编辑
                  </Button>
                  {!role.is_system && (
                    <Popconfirm
                      title="删除该角色？"
                      description={role.user_count > 0 ? '仍有管理员使用，需先改派后再删除。' : '此操作不可撤销。'}
                      okButtonProps={{ danger: true, disabled: role.user_count > 0 }}
                      onConfirm={() => deleteRole(role.slug)}
                    >
                      <Button size="small" danger icon={<DeleteOutlined />}>
                        删除
                      </Button>
                    </Popconfirm>
                  )}
                </Space>
              )}
            </Space>
          </Card>
        ))}
      </div>

      <Card className="data-card" variant="borderless">
        <Table
          rowKey="key"
          columns={matrixColumns}
          dataSource={rows}
          pagination={false}
          scroll={{ x: 900 }}
          size="middle"
          loading={rolesQuery.isPending || catalogQuery.isPending}
        />
      </Card>

      <Modal
        title={editor?.mode === 'create' ? '新建角色' : `编辑角色：${editor?.name ?? ''}`}
        open={Boolean(editor)}
        okText={editor?.mode === 'create' ? '创建' : '保存'}
        cancelText="取消"
        width={640}
        destroyOnHidden
        onOk={submitEditor}
        onCancel={() => setEditor(null)}
      >
        {editor && (
          <Space direction="vertical" size={14} style={{ width: '100%' }}>
            {editor.mode === 'create' ? (
              <div>
                <Typography.Text>角色标识（slug，创建后不可改）</Typography.Text>
                <Input
                  value={editor.slug}
                  placeholder="例如 content_reviewer"
                  onChange={(event) => setEditor({ ...editor, slug: event.target.value })}
                />
              </div>
            ) : (
              <Typography.Text type="secondary">
                标识：{editor.slug}
                {editor.isSystem ? ' · 系统内置角色' : ''}
              </Typography.Text>
            )}
            <div>
              <Typography.Text>角色名称</Typography.Text>
              <Input
                value={editor.name}
                maxLength={100}
                onChange={(event) => setEditor({ ...editor, name: event.target.value })}
              />
            </div>
            <div>
              <Typography.Text>描述</Typography.Text>
              <Input.TextArea
                value={editor.description}
                maxLength={500}
                autoSize={{ minRows: 2, maxRows: 4 }}
                onChange={(event) => setEditor({ ...editor, description: event.target.value })}
              />
            </div>
            <div>
              <Typography.Text strong>权限</Typography.Text>
              {groupedCatalog.map(([group, codes]) => (
                <div key={group} className="role-permission-group">
                  <Typography.Text type="secondary">{group}</Typography.Text>
                  <Space direction="vertical" size={2}>
                    {codes.map((code) => (
                      <Checkbox
                        key={code}
                        checked={editor.selected.includes(code)}
                        onChange={(event) => togglePermission(code, event.target.checked)}
                      >
                        {permissionLabel(code).label}
                        <Typography.Text type="secondary">（{code}）</Typography.Text>
                      </Checkbox>
                    ))}
                  </Space>
                </div>
              ))}
            </div>
          </Space>
        )}
      </Modal>

      <StepUpModal open={stepUpOpen} onCancel={() => setStepUpOpen(false)} onVerified={afterStepUp} />
    </>
  );
}
