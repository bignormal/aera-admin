import { EyeOutlined, ReloadOutlined, SearchOutlined } from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ColumnsType } from 'antd/es/table';
import {
  Alert,
  Button,
  Card,
  Drawer,
  Input,
  Modal,
  Select,
  Space,
  Spin,
  Table,
  Tag,
  Typography,
  message,
} from 'antd';
import { useEffect, useRef, useState } from 'react';
import { z } from 'zod';

import { APIError, postJSON, request } from '../api/client';
import {
  type ApprovalRequest,
  type CloudUser,
  type CloudUserStatus,
  type Page,
  type ReasonInput,
} from '../api/contracts';
import { useAuth } from '../auth/AuthProvider';
import { StepUpModal } from '../auth/StepUpModal';
import { CloudBoundary } from '../components/CloudBoundary';
import { ReasonForm } from '../components/ReasonForm';

const exactIdentitySchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('email'), value: z.string().trim().email().max(320) }),
  z.object({ type: z.literal('phone'), value: z.string().trim().regex(/^\+?[0-9]{7,15}$/) }),
]);

type ExactIdentity = z.infer<typeof exactIdentitySchema>;
type LifecycleAction = 'disable_user' | 'enable_user';

const statusPresentation: Record<CloudUserStatus, { label: string; color: string }> = {
  active: { label: '有效', color: 'green' },
  pending_deletion: { label: '等待删除', color: 'gold' },
  disabled: { label: '已禁用', color: 'red' },
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

function maskedIdentity(user: CloudUser): string {
  return [user.masked_email, user.masked_phone].filter(Boolean).join(' / ') || '—';
}

function lifecycleFor(user: CloudUser | undefined): LifecycleAction | null {
  if (!user || user.deletion_finalized_at) return null;
  if (user.status === 'active' && !user.administratively_disabled) return 'disable_user';
  if (user.status === 'disabled' && user.administratively_disabled) return 'enable_user';
  return null;
}

export function CloudUsersPage() {
  const auth = useAuth();
  const queryClient = useQueryClient();
  const [messageAPI, messageContext] = message.useMessage();
  const [status, setStatus] = useState<CloudUserStatus | 'all'>('all');
  const [cursor, setCursor] = useState('');
  const [cursorHistory, setCursorHistory] = useState<string[]>([]);
  const [lookupValue, setLookupValue] = useState('');
  const [lookupValidation, setLookupValidation] = useState<string | null>(null);
  const [lookupResult, setLookupResult] = useState<CloudUser | null>(null);
  const lookupVariables = useRef<ExactIdentity | null>(null);
  const [selectedUserID, setSelectedUserID] = useState<string | null>(null);
  const [lifecycleAction, setLifecycleAction] = useState<LifecycleAction | null>(null);
  const [lifecycleError, setLifecycleError] = useState<string | null>(null);
  const [lifecyclePending, setLifecyclePending] = useState(false);
  const [stepUpOpen, setStepUpOpen] = useState(false);
  const [pendingAfterStepUp, setPendingAfterStepUp] = useState<(() => Promise<ApprovalRequest>) | null>(null);
  const role = auth.session?.administrator.role;

  const users = useQuery({
    queryKey: ['cloud-users', status, cursor],
    queryFn: () =>
      request<Page<CloudUser>>(
        `/cloud-users?limit=50${status === 'all' ? '' : `&status=${status}`}${
          cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''
        }`,
      ),
    enabled: Boolean(auth.session),
    retry: false,
  });

  const lookup = useMutation({
    mutationFn: (input: ExactIdentity) => postJSON<CloudUser>('/cloud-users/lookup', input),
    onSuccess: (result) => setLookupResult(result),
    onSettled: (_result, _error, variables) => {
      setLookupValue('');
      variables.value = '';
      if (lookupVariables.current === variables) lookupVariables.current = null;
    },
  });

  const detail = useQuery({
    queryKey: ['cloud-user', selectedUserID],
    queryFn: () => request<CloudUser>(`/cloud-users/${selectedUserID}`),
    enabled: Boolean(selectedUserID),
    retry: false,
  });

  useEffect(
    () => () => {
      if (lookupVariables.current) lookupVariables.current.value = '';
      lookupVariables.current = null;
    },
    [],
  );

  const submitLookup = () => {
    const value = lookupValue.trim();
    const parsed = exactIdentitySchema.safeParse({ type: value.includes('@') ? 'email' : 'phone', value });
    if (!parsed.success) {
      setLookupValidation('请输入完整且有效的邮箱或手机号');
      return;
    }
    setLookupValidation(null);
    setLookupResult(null);
    setLookupValue('');
    lookupVariables.current = parsed.data;
    lookup.mutate(parsed.data);
  };

  const finishLifecycle = async () => {
    setLifecycleAction(null);
    setLifecycleError(null);
    setPendingAfterStepUp(null);
    setStepUpOpen(false);
    messageAPI.success('申请已提交，等待另一名超级管理员审批');
    await queryClient.invalidateQueries({ queryKey: ['approval-requests'] });
  };

  const createLifecycleRequest = async (reason: ReasonInput) => {
    if (!detail.data || !lifecycleAction || lifecyclePending) return;
    const action = lifecycleAction;
    const targetUserID = detail.data.user_id;
    const execute = () =>
      postJSON<ApprovalRequest>('/approval-requests', {
        action,
        target_user_id: targetUserID,
        reason_code: reason.reason_code,
        ticket_reference: reason.ticket_reference,
        note: reason.note,
      });
    setLifecyclePending(true);
    setLifecycleError(null);
    try {
      await execute();
      await finishLifecycle();
    } catch (error) {
      if (error instanceof APIError && error.code === 'STEP_UP_REQUIRED') {
        setPendingAfterStepUp(() => execute);
        setStepUpOpen(true);
        return;
      }
      setLifecycleError(error instanceof APIError ? error.message : '申请未能提交，请稍后重试');
    } finally {
      setLifecyclePending(false);
    }
  };

  const retryAfterStepUp = async () => {
    if (!pendingAfterStepUp) return;
    setLifecyclePending(true);
    setLifecycleError(null);
    try {
      await pendingAfterStepUp();
      await finishLifecycle();
    } catch (error) {
      setLifecycleError(error instanceof APIError ? error.message : '申请未能提交，请稍后重试');
      throw error;
    } finally {
      setLifecyclePending(false);
    }
  };

  const columns: ColumnsType<CloudUser> = [
    {
      title: '脱敏身份',
      key: 'identity',
      width: 250,
      render: (_, user) => (
        <div className="table-primary-cell">
          <strong>{maskedIdentity(user)}</strong>
          <span>{user.user_id}</span>
        </div>
      ),
    },
    {
      title: '状态',
      dataIndex: 'status',
      width: 110,
      render: (value: CloudUserStatus) => <Tag color={statusPresentation[value].color}>{statusPresentation[value].label}</Tag>,
    },
    { title: '设备', dataIndex: 'device_count', width: 90, align: 'right' },
    { title: '活跃设备', dataIndex: 'active_device_count', width: 100, align: 'right' },
    { title: '活跃会话', dataIndex: 'active_session_count', width: 100, align: 'right' },
    {
      title: '最近 Cloud 活动',
      dataIndex: 'last_cloud_activity_at',
      width: 170,
      render: (value?: string) => formatTime(value),
    },
    {
      title: '操作',
      key: 'action',
      width: 110,
      fixed: 'right',
      render: (_, user) => (
        <Button type="link" icon={<EyeOutlined />} onClick={() => setSelectedUserID(user.user_id)}>
          查看详情
        </Button>
      ),
    },
  ];

  const items = users.data?.items ?? [];
  const currentLifecycle = lifecycleFor(detail.data);
  const lookupAPIError = lookup.error instanceof APIError ? lookup.error : null;
  const lookupNotFound = lookupAPIError?.code === 'NOT_FOUND';
  const lookupCloudFailure = lookupAPIError !== null && !lookupNotFound;

  return (
    <div className="cloud-users-page">
      {messageContext}
      <div className="page-heading">
        <div>
          <Typography.Title level={3}>Cloud 用户与访问</Typography.Title>
          <Typography.Paragraph type="secondary">
            列表与详情只展示 Cloud 返回的脱敏身份；完整邮箱或手机号仅用于一次性精确查找。
          </Typography.Paragraph>
        </div>
        <Button icon={<ReloadOutlined />} loading={users.isFetching} onClick={() => void users.refetch()}>
          刷新列表
        </Button>
      </div>

      <Card className="filter-card">
        <div className="filter-control filter-control-wide">
          <label htmlFor="cloud-user-lookup">完整邮箱或手机号</label>
          <Space.Compact block>
            <Input
              id="cloud-user-lookup"
              aria-label="完整邮箱或手机号"
              value={lookupValue}
              autoComplete="off"
              maxLength={320}
              status={lookupValidation ? 'error' : undefined}
              placeholder="仅用于精确查找，不写入 URL 或本地存储"
              onChange={(event) => {
                setLookupValue(event.target.value);
                setLookupValidation(null);
              }}
              onPressEnter={submitLookup}
            />
            <Button type="primary" icon={<SearchOutlined aria-hidden />} loading={lookup.isPending} onClick={submitLookup}>
              精确查找
            </Button>
          </Space.Compact>
          {lookupValidation && <span className="filter-error">{lookupValidation}</span>}
        </div>
        <div className="filter-control">
          <label htmlFor="cloud-user-status">账号状态</label>
          <Select
            id="cloud-user-status"
            value={status}
            style={{ width: 170 }}
            options={[
              { value: 'all', label: '全部状态' },
              { value: 'active', label: '有效' },
              { value: 'pending_deletion', label: '等待删除' },
              { value: 'disabled', label: '已禁用' },
            ]}
            onChange={(value: CloudUserStatus | 'all') => {
              setStatus(value);
              setCursor('');
              setCursorHistory([]);
            }}
          />
        </div>
      </Card>

      {lookupNotFound && <Alert className="page-alert" showIcon type="info" message="未找到匹配的 Cloud 用户" />}
      {lookupCloudFailure && (
        <Alert
          className="page-alert"
          showIcon
          type={lookupAPIError.code === 'CLOUD_CONTRACT_VIOLATION' ? 'error' : 'warning'}
          message={
            lookupAPIError.code === 'CLOUD_CONTRACT_VIOLATION'
              ? 'Cloud 安全契约异常'
              : lookupAPIError.code === 'CLOUD_NOT_CONFIGURED'
                ? 'Cloud 管理服务尚未配置'
                : 'Cloud 管理服务暂时不可用'
          }
          description="精确身份值已从页面状态清除；如需重试，请重新输入。"
        />
      )}
      {lookupResult && (
        <Card
          className="lookup-result-card"
          size="small"
          title="精确查找结果（仍为脱敏显示）"
          extra={<Button onClick={() => setSelectedUserID(lookupResult.user_id)}>查看详情</Button>}
        >
          <Space size={18} wrap>
            <Typography.Text strong>{maskedIdentity(lookupResult)}</Typography.Text>
            <Tag color={statusPresentation[lookupResult.status].color}>
              {statusPresentation[lookupResult.status].label}
            </Tag>
            <Typography.Text type="secondary">用户 ID：{lookupResult.user_id}</Typography.Text>
          </Space>
        </Card>
      )}

      <CloudBoundary error={users.error} empty={users.isSuccess && items.length === 0} onRetry={() => void users.refetch()}>
        <Card className="data-card">
          <div className="data-card-toolbar">
            <Typography.Text strong>Cloud 用户</Typography.Text>
            <Space>
              <Button
                disabled={cursorHistory.length === 0 || users.isFetching}
                onClick={() => {
                  const history = [...cursorHistory];
                  setCursor(history.pop() ?? '');
                  setCursorHistory(history);
                }}
              >
                上一页
              </Button>
              <Button
                disabled={!users.data?.next_cursor || users.isFetching}
                onClick={() => {
                  if (!users.data?.next_cursor) return;
                  setCursorHistory((history) => [...history, cursor]);
                  setCursor(users.data.next_cursor ?? '');
                }}
              >
                下一页
              </Button>
            </Space>
          </div>
          <Table
            rowKey="user_id"
            loading={users.isPending}
            dataSource={items}
            columns={columns}
            pagination={false}
            scroll={{ x: 1040 }}
          />
        </Card>
      </CloudBoundary>

      <Drawer
        title="Cloud 用户详情"
        width={520}
        open={Boolean(selectedUserID)}
        destroyOnHidden
        onClose={() => {
          setSelectedUserID(null);
          setLifecycleAction(null);
        }}
      >
        {detail.isPending && <Spin />}
        {detail.error && (
          <CloudBoundary error={detail.error} empty={false} onRetry={() => void detail.refetch()}>
            {null}
          </CloudBoundary>
        )}
        {detail.data && (
          <>
            <dl className="detail-drawer-grid">
              <dt>脱敏身份</dt><dd>{maskedIdentity(detail.data)}</dd>
              <dt>Cloud 用户 ID</dt><dd>{detail.data.user_id}</dd>
              <dt>状态</dt><dd>{statusPresentation[detail.data.status].label}</dd>
              <dt>管理修订号</dt><dd>{detail.data.administrative_revision}</dd>
              <dt>设备 / 活跃设备</dt><dd>{detail.data.device_count} / {detail.data.active_device_count}</dd>
              <dt>活跃会话</dt><dd>{detail.data.active_session_count}</dd>
              <dt>创建时间</dt><dd>{formatTime(detail.data.created_at)}</dd>
              <dt>最近 Cloud 活动</dt><dd>{formatTime(detail.data.last_cloud_activity_at)}</dd>
            </dl>
            {role === 'operator' && currentLifecycle && (
              <Button
                className="drawer-primary-action"
                type="primary"
                danger={currentLifecycle === 'disable_user'}
                onClick={() => {
                  setLifecycleError(null);
                  setLifecycleAction(currentLifecycle);
                }}
              >
                {currentLifecycle === 'disable_user' ? '发起禁用申请' : '发起恢复申请'}
              </Button>
            )}
          </>
        )}
      </Drawer>

      <Modal
        title={lifecycleAction === 'disable_user' ? '发起账号禁用申请' : '发起账号恢复申请'}
        open={Boolean(lifecycleAction)}
        footer={null}
        destroyOnHidden
        maskClosable={!lifecyclePending}
        closable={!lifecyclePending}
        onCancel={() => {
          if (lifecyclePending) return;
          setLifecycleAction(null);
          setLifecycleError(null);
        }}
      >
        <Alert
          className="page-alert"
          showIcon
          type="info"
          message="提交后不会立即变更 Cloud 账号"
          description="申请必须由另一名超级管理员审批，执行结果与审批结果会分别展示。"
        />
        {lifecycleError && <Alert className="page-alert" showIcon type="error" message={lifecycleError} />}
        <ReasonForm
          usage="account"
          submitLabel="提交审批申请"
          pending={lifecyclePending}
          onSubmit={createLifecycleRequest}
        />
      </Modal>

      <StepUpModal
        open={stepUpOpen}
        onCancel={() => {
          setStepUpOpen(false);
          setPendingAfterStepUp(null);
        }}
        onVerified={retryAfterStepUp}
      />
    </div>
  );
}
