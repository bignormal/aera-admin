import { PlusOutlined, ReloadOutlined } from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ColumnsType } from 'antd/es/table';
import { Alert, Button, Card, Input, Modal, Space, Table, Tag, Typography } from 'antd';
import { useState } from 'react';
import { Link } from 'react-router-dom';

import { APIError, getOfficialDefinitions, newIdempotencyKey, postOfficialMutation } from '../api/client';
import type { OfficialDefinition, OfficialOperation, ReasonInput } from '../api/contracts';
import { useAuth } from '../auth/AuthProvider';
import { CloudBoundary } from '../components/CloudBoundary';
import { OperationStatus } from '../components/OperationStatus';
import { ReasonForm } from '../components/ReasonForm';

export function OfficialAgentsPage() {
  const auth = useAuth();
  const queryClient = useQueryClient();
  const developer = auth.session?.administrator.role === 'developer';
  const [createOpen, setCreateOpen] = useState(false);
  const [displayName, setDisplayName] = useState('');
  const [operation, setOperation] = useState<OfficialOperation | null>(null);
  const [error, setError] = useState<string | null>(null);

  const definitions = useQuery({
    queryKey: ['official-definitions'],
    queryFn: () => getOfficialDefinitions(new URLSearchParams({ limit: '50' })),
    retry: false,
  });

  const reserve = useMutation({
    mutationFn: (reason: ReasonInput) => postOfficialMutation(
      '/official-agents',
      {
        expected_revision: 1,
        reason_code: reason.reason_code,
        ticket_reference: reason.ticket_reference,
        note: reason.note,
        payload: { display_name: displayName.trim() },
      },
      newIdempotencyKey(),
    ),
    onSuccess: (result) => {
      setOperation(result);
      setCreateOpen(false);
      setDisplayName('');
      setError(null);
      void queryClient.invalidateQueries({ queryKey: ['official-definitions'] });
    },
    onError: (cause) => setError(cause instanceof APIError ? cause.message : '官方 Agent 创建请求未能排队'),
  });

  const columns: ColumnsType<OfficialDefinition> = [
    {
      title: '官方 Agent',
      key: 'definition',
      render: (_, item) => (
        <div className="table-primary-cell">
          <strong>{item.display_name}</strong>
          <span>{item.definition_id}</span>
        </div>
      ),
    },
    {
      title: '状态',
      dataIndex: 'status',
      width: 120,
      render: (value: OfficialDefinition['status']) => <Tag color={value === 'active' ? 'green' : 'default'}>{value === 'active' ? '有效' : '已归档'}</Tag>,
    },
    {
      title: '最新版本',
      dataIndex: 'latest_version_id',
      width: 300,
      render: (value?: string) => value ?? '尚未发布',
    },
    {
      title: '操作',
      width: 120,
      render: (_, item) => developer ? <Link to={`/official-agents/${item.definition_id}/edit`}>编辑草稿</Link> : <Typography.Text type="secondary">只读</Typography.Text>,
    },
  ];

  const items = definitions.data?.items ?? [];
  return (
    <div className="official-agents-page">
      <div className="page-heading">
        <div>
          <Typography.Title level={3}>官方 Agent</Typography.Title>
          <Typography.Paragraph type="secondary">平台只管理定义、版本、发布与审计，不接收用户运行数据。</Typography.Paragraph>
        </div>
        <Space>
          <Button icon={<ReloadOutlined aria-hidden />} loading={definitions.isFetching} onClick={() => void definitions.refetch()}>刷新</Button>
          {developer && <Button type="primary" icon={<PlusOutlined aria-hidden />} onClick={() => setCreateOpen(true)}>创建官方 Agent</Button>}
        </Space>
      </div>

      <Alert
        className="page-alert"
        type="info"
        showIcon
        message="官方 Agent 是平台来源类型，不是个人空间、工作空间或企业空间"
        description="发布和安装不会上传 Memory、会话、文件、私有 Skill 或 Hermes 本地学习数据。"
      />
      {operation && (
        <Alert
          className="page-alert"
          type="info"
          showIcon
          message={<Space>创建请求已进入本地队列 <OperationStatus state={operation.state} /></Space>}
          description="排队或对账不代表 Cloud 已完成；列表只在 Cloud 返回真实状态后更新。"
        />
      )}
      <CloudBoundary error={definitions.error} empty={definitions.isSuccess && items.length === 0} onRetry={() => void definitions.refetch()}>
        <Card className="data-card">
          <Table rowKey="definition_id" columns={columns} dataSource={items} pagination={false} />
        </Card>
      </CloudBoundary>

      <Modal
        title="创建官方 Agent 定义"
        open={createOpen}
        footer={null}
        destroyOnHidden
        onCancel={() => {
          if (reserve.isPending) return;
          setCreateOpen(false);
          setError(null);
        }}
      >
        <Typography.Paragraph type="secondary">这里只保留平台定义名称；草稿内容将在下一步编辑并经过审核发布。</Typography.Paragraph>
        <label htmlFor="official-display-name">显示名称</label>
        <Input
          id="official-display-name"
          aria-label="官方 Agent 显示名称"
          value={displayName}
          maxLength={100}
          autoComplete="off"
          onChange={(event) => setDisplayName(event.target.value)}
        />
        {error && <Alert className="page-alert" type="error" showIcon message={error} />}
        {createOpen && (
          <ReasonForm
            usage="official_agent"
            submitLabel="排队创建"
            pending={reserve.isPending}
            onSubmit={async (reason) => {
              if (!displayName.trim()) {
                setError('请输入显示名称');
                return;
              }
              await reserve.mutateAsync(reason);
            }}
          />
        )}
      </Modal>
    </div>
  );
}
