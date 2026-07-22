import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ColumnsType } from 'antd/es/table';
import {
  Alert,
  Button,
  Card,
  Empty,
  Input,
  Modal,
  Space,
  Table,
  Tag,
  Typography,
  message,
} from 'antd';
import { useEffect, useRef, useState } from 'react';
import { z } from 'zod';

import { APIError, newIdempotencyKey, postIdempotentJSON, request } from '../api/client';
import {
  hasPermission,
  type AdminOperation,
  type CloudDevice,
  type CloudDeviceStatus,
  type CloudSession,
  type CloudSessionStatus,
  type CloudUser,
  type Page,
  type ReasonInput,
} from '../api/contracts';
import { useAuth } from '../auth/AuthProvider';
import { StepUpModal } from '../auth/StepUpModal';
import { CloudBoundary } from '../components/CloudBoundary';
import { OperationStatus } from '../components/OperationStatus';
import { ReasonForm } from '../components/ReasonForm';

type RevokeTarget = { kind: 'device' | 'session'; id: string };

const userIDSchema = z.string().trim().uuid();

const deviceStatus: Record<CloudDeviceStatus, { label: string; color: string }> = {
  active: { label: '有效', color: 'green' },
  inactive: { label: '不活跃', color: 'default' },
  revoked: { label: '已撤销', color: 'red' },
};

const sessionStatus: Record<CloudSessionStatus, { label: string; color: string }> = {
  active: { label: '有效', color: 'green' },
  rotated: { label: '已轮换', color: 'blue' },
  expired: { label: '已过期', color: 'default' },
  revoked: { label: '已撤销', color: 'red' },
  replay_detected: { label: '检测到重放', color: 'volcano' },
};

function formatTime(raw?: string): string {
  if (!raw) return '—';
  const value = new Date(raw);
  if (Number.isNaN(value.getTime())) return '—';
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(value);
}

export function CloudDevicesPage() {
  const auth = useAuth();
  const queryClient = useQueryClient();
  const [messageAPI, messageContext] = message.useMessage();
  const [userIDInput, setUserIDInput] = useState('');
  const [userIDError, setUserIDError] = useState<string | null>(null);
  const [selectedUserID, setSelectedUserID] = useState<string | null>(null);
  const [target, setTarget] = useState<RevokeTarget | null>(null);
  const [idempotencyKey, setIdempotencyKey] = useState<string | null>(null);
  const [acceptedOperation, setAcceptedOperation] = useState<AdminOperation | null>(null);
  const [operationID, setOperationID] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [stepUpOpen, setStepUpOpen] = useState(false);
  const [pendingAfterStepUp, setPendingAfterStepUp] = useState<(() => Promise<AdminOperation>) | null>(null);
  const revokeInFlight = useRef(false);
  const role = auth.session?.administrator.role;
  const canRevokeDevice = role ? hasPermission(role, 'cloud_device.revoke') : false;
  const canRevokeSession = role ? hasPermission(role, 'cloud_session.revoke') : false;

  const user = useQuery({
    queryKey: ['cloud-user', selectedUserID],
    queryFn: () => request<CloudUser>(`/cloud-users/${selectedUserID}`),
    enabled: Boolean(selectedUserID),
    retry: false,
  });
  const devices = useQuery({
    queryKey: ['cloud-user-devices', selectedUserID],
    queryFn: () => request<Page<CloudDevice>>(`/cloud-users/${selectedUserID}/devices?limit=100`),
    enabled: Boolean(selectedUserID),
    retry: false,
  });
  const sessions = useQuery({
    queryKey: ['cloud-user-sessions', selectedUserID],
    queryFn: () => request<Page<CloudSession>>(`/cloud-users/${selectedUserID}/sessions?limit=100`),
    enabled: Boolean(selectedUserID),
    retry: false,
  });

  const revoke = useMutation({
    mutationFn: async (reason: ReasonInput) => {
      if (!target || !idempotencyKey || !user.data) throw new Error('revoke context is incomplete');
      const path =
        target.kind === 'device'
          ? `/cloud-devices/${target.id}/revoke`
          : `/cloud-sessions/${target.id}/revoke`;
      return postIdempotentJSON<AdminOperation>(
        path,
        {
          expected_revision: user.data.administrative_revision,
          reason_code: reason.reason_code,
          ticket_reference: reason.ticket_reference,
          note: reason.note,
        },
        idempotencyKey,
      );
    },
    onSuccess: (nextOperation) => {
      setAcceptedOperation(nextOperation);
      setOperationID(nextOperation.operation_id);
      setTarget(null);
      setActionError(null);
      setStepUpOpen(false);
      setPendingAfterStepUp(null);
    },
    onSettled: () => {
      revokeInFlight.current = false;
    },
  });

  const operation = useQuery({
    queryKey: ['admin-operation', operationID],
    queryFn: () => request<AdminOperation>(`/operations/${operationID}`),
    enabled: Boolean(operationID),
    retry: false,
    refetchInterval: (query) => {
      const state = query.state.data?.state;
      return state === 'queued' || state === 'executing' || state === 'reconciling' ? 1000 : false;
    },
  });

  const visibleOperation = operation.data ?? acceptedOperation;

  useEffect(() => {
    const state = operation.data?.state;
    if (!state || (state !== 'succeeded' && state !== 'failed' && state !== 'conflict')) return;
    if (state !== 'succeeded' || !selectedUserID) return;
    messageAPI.success('Cloud 已确认撤销成功');
    void queryClient.invalidateQueries({ queryKey: ['cloud-user', selectedUserID] });
    void queryClient.invalidateQueries({ queryKey: ['cloud-user-devices', selectedUserID] });
    void queryClient.invalidateQueries({ queryKey: ['cloud-user-sessions', selectedUserID] });
  }, [messageAPI, operation.data?.state, queryClient, selectedUserID]);

  const loadUser = () => {
    const parsed = userIDSchema.safeParse(userIDInput);
    if (!parsed.success) {
      setUserIDError('请输入有效的 Cloud 用户 UUID');
      return;
    }
    setUserIDError(null);
    setSelectedUserID(parsed.data);
    setTarget(null);
    setIdempotencyKey(null);
    setAcceptedOperation(null);
    setOperationID(null);
    setActionError(null);
  };

  const openRevoke = (next: RevokeTarget) => {
    setTarget(next);
    setIdempotencyKey(newIdempotencyKey());
    setActionError(null);
  };

  const submitRevoke = async (reason: ReasonInput) => {
    if (revokeInFlight.current) return;
    revokeInFlight.current = true;
    const retryReason = { ...reason };
    try {
      await revoke.mutateAsync(reason);
    } catch (error) {
      if (error instanceof APIError && error.code === 'STEP_UP_REQUIRED') {
        setPendingAfterStepUp(() => () => revoke.mutateAsync(retryReason));
        setStepUpOpen(true);
        return;
      }
      setActionError(error instanceof APIError ? error.message : '撤销请求未能提交，请稍后重试');
    }
  };

  const retryAfterStepUp = async () => {
    if (!pendingAfterStepUp || revokeInFlight.current) return;
    revokeInFlight.current = true;
    try {
      await pendingAfterStepUp();
    } catch (error) {
      setActionError(error instanceof APIError ? error.message : '撤销请求未能提交，请稍后重试');
      throw error;
    }
  };

  const deviceColumns: ColumnsType<CloudDevice> = [
    {
      title: '设备',
      key: 'device',
      render: (_, device) => (
        <div className="table-primary-cell">
          <strong>{device.display_name}</strong>
          <Typography.Text copyable={{ text: device.device_id }}>{device.device_id}</Typography.Text>
        </div>
      ),
    },
    { title: '平台', dataIndex: 'platform', width: 120 },
    { title: '客户端版本', dataIndex: 'client_version', width: 130 },
    {
      title: '状态',
      dataIndex: 'status',
      width: 110,
      render: (value: CloudDeviceStatus) => <Tag color={deviceStatus[value].color}>{deviceStatus[value].label}</Tag>,
    },
    { title: '最近在线', dataIndex: 'last_seen_at', width: 170, render: (value?: string) => formatTime(value) },
    {
      title: '操作',
      key: 'action',
      width: 110,
      render: (_, device) =>
        canRevokeDevice && device.status !== 'revoked' ? (
          <Button danger type="link" onClick={() => openRevoke({ kind: 'device', id: device.device_id })}>
            撤销设备
          </Button>
        ) : null,
    },
  ];

  const sessionColumns: ColumnsType<CloudSession> = [
    {
      title: '会话 ID',
      dataIndex: 'session_id',
      render: (value: string) => <Typography.Text copyable={{ text: value }}>{value}</Typography.Text>,
    },
    {
      title: '设备 ID',
      dataIndex: 'device_id',
      render: (value: string) => <Typography.Text copyable={{ text: value }}>{value}</Typography.Text>,
    },
    {
      title: '状态',
      dataIndex: 'status',
      width: 120,
      render: (value: CloudSessionStatus) => <Tag color={sessionStatus[value].color}>{sessionStatus[value].label}</Tag>,
    },
    { title: '签发时间', dataIndex: 'issued_at', width: 170, render: (value: string) => formatTime(value) },
    { title: '到期时间', dataIndex: 'expires_at', width: 170, render: (value: string) => formatTime(value) },
    {
      title: '操作',
      key: 'action',
      width: 110,
      render: (_, session) =>
        canRevokeSession && session.status === 'active' ? (
          <Button danger type="link" onClick={() => openRevoke({ kind: 'session', id: session.session_id })}>
            撤销会话
          </Button>
        ) : null,
    },
  ];

  return (
    <div className="cloud-devices-page">
      {messageContext}
      <div className="page-heading">
        <div>
          <Typography.Title level={3}>Cloud 设备与会话</Typography.Title>
          <Typography.Paragraph type="secondary">
            仅按内部用户 UUID 检查一个用户；页面不展示公钥、令牌、刷新族哈希、完整 IP 或身份密文。
          </Typography.Paragraph>
        </div>
      </div>

      <Card className="filter-card">
        <div className="filter-control filter-control-wide">
          <label htmlFor="cloud-device-user-id">Cloud 用户 ID</label>
          <Space.Compact block>
            <Input
              id="cloud-device-user-id"
              aria-label="Cloud 用户 ID"
              value={userIDInput}
              status={userIDError ? 'error' : undefined}
              autoComplete="off"
              placeholder="输入内部 Cloud 用户 UUID"
              onChange={(event) => {
                setUserIDInput(event.target.value);
                setUserIDError(null);
              }}
              onPressEnter={loadUser}
            />
            <Button type="primary" onClick={loadUser}>加载设备与会话</Button>
          </Space.Compact>
          {userIDError && <span className="filter-error">{userIDError}</span>}
        </div>
      </Card>

      {!selectedUserID && <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="输入 Cloud 用户 ID 后加载设备与会话" />}

      {selectedUserID && (
        <>
          <CloudBoundary error={user.error} empty={false} onRetry={() => void user.refetch()}>
            {user.data && (
              <Card className="selected-cloud-user" size="small">
                <Space size={18} wrap>
                  <Typography.Text strong>{user.data.masked_email ?? user.data.masked_phone ?? '—'}</Typography.Text>
                  <Typography.Text type="secondary">用户 ID：{user.data.user_id}</Typography.Text>
                  <Typography.Text type="secondary">管理修订号：{user.data.administrative_revision}</Typography.Text>
                </Space>
              </Card>
            )}
          </CloudBoundary>

          <CloudBoundary
            error={devices.error}
            empty={devices.isSuccess && (devices.data?.items.length ?? 0) === 0}
            onRetry={() => void devices.refetch()}
          >
            <Card className="data-card cloud-resource-card">
              <div className="data-card-toolbar"><Typography.Text strong>设备</Typography.Text></div>
              <Table
                rowKey="device_id"
                loading={devices.isPending}
                dataSource={devices.data?.items ?? []}
                columns={deviceColumns}
                pagination={false}
                scroll={{ x: 920 }}
              />
            </Card>
          </CloudBoundary>

          <CloudBoundary
            error={sessions.error}
            empty={sessions.isSuccess && (sessions.data?.items.length ?? 0) === 0}
            onRetry={() => void sessions.refetch()}
          >
            <Card className="data-card cloud-resource-card">
              <div className="data-card-toolbar"><Typography.Text strong>会话</Typography.Text></div>
              <Table
                rowKey="session_id"
                loading={sessions.isPending}
                dataSource={sessions.data?.items ?? []}
                columns={sessionColumns}
                pagination={false}
                scroll={{ x: 1040 }}
              />
            </Card>
          </CloudBoundary>
        </>
      )}

      {visibleOperation && (
        <Card className="operation-card" size="small" title="最近管理员操作">
          <Space direction="vertical" size={8}>
            <OperationStatus state={visibleOperation.state} />
            <Typography.Text type="secondary">操作 ID：{visibleOperation.operation_id}</Typography.Text>
            {visibleOperation.state === 'queued' && <Alert type="info" showIcon message="请求已受理，等待执行" />}
            {visibleOperation.state === 'reconciling' && (
              <Alert type="warning" showIcon message="Cloud 返回状态未知，系统正在安全对账" />
            )}
            {(visibleOperation.state === 'failed' || visibleOperation.state === 'conflict') && (
              <Alert
                type="error"
                showIcon
                message={visibleOperation.state === 'failed' ? '撤销执行失败' : '目标状态发生冲突'}
                description={visibleOperation.error_code ?? '未提供稳定错误代码'}
              />
            )}
            {visibleOperation.state === 'succeeded' && <Alert type="success" showIcon message="Cloud 已确认撤销成功" />}
          </Space>
        </Card>
      )}
      {operation.error && (
        <CloudBoundary error={operation.error} empty={false} onRetry={() => void operation.refetch()}>
          {null}
        </CloudBoundary>
      )}

      <Modal
        title={target?.kind === 'device' ? '撤销 Cloud 设备' : '撤销 Cloud 会话'}
        open={Boolean(target)}
        footer={null}
        destroyOnHidden
        maskClosable={!revoke.isPending}
        closable={!revoke.isPending}
        onCancel={() => {
          if (revoke.isPending) return;
          setTarget(null);
          setIdempotencyKey(null);
          setActionError(null);
        }}
      >
        <Alert
          className="page-alert"
          type="warning"
          showIcon
          message="请求被接受不等于执行成功"
          description="页面会持续显示可靠执行状态；对账中、失败或冲突不会使用成功文案。"
        />
        {actionError && <Alert className="page-alert" type="error" showIcon message={actionError} />}
        {target && (
          <ReasonForm
            usage={target.kind}
            submitLabel="确认撤销"
            pending={revoke.isPending}
            onSubmit={submitRevoke}
          />
        )}
      </Modal>

      <StepUpModal
        open={stepUpOpen}
        onCancel={() => {
          setStepUpOpen(false);
          setPendingAfterStepUp(null);
          setTarget(null);
          setIdempotencyKey(null);
          setActionError(null);
        }}
        onVerified={retryAfterStepUp}
      />
    </div>
  );
}
