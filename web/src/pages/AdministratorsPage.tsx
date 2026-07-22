import { zodResolver } from '@hookform/resolvers/zod';
import {
  CopyOutlined,
  PlusOutlined,
  TeamOutlined,
} from '@ant-design/icons';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { ColumnsType } from 'antd/es/table';
import {
  Alert,
  Button,
  Card,
  Checkbox,
  Empty,
  Form,
  Input,
  Modal,
  Select,
  Space,
  Table,
  Tag,
  Typography,
  message,
} from 'antd';
import { useRef, useState } from 'react';
import { Controller, type Control, type FieldErrors, type FieldValues, type Path, useForm } from 'react-hook-form';
import { z } from 'zod';

import { APIError, postJSON, putJSON, request } from '../api/client';
import { useReasonCodes } from '../api/settings';
import {
  hasPermission,
  roleLabels,
  roles,
  type AdminRole,
  type Administrator,
  type AdministratorList,
  type InvitationResult,
  type ReasonCode,
} from '../api/contracts';
import { useAuth } from '../auth/AuthProvider';
import { StepUpModal } from '../auth/StepUpModal';
import { copySensitiveText } from '../security/clipboard';

const reasonFields = {
  reasonCode: z.string().min(1, '请选择标准原因'),
  ticketReference: z.string().trim().max(120, '工单编号过长'),
  note: z.string().trim().max(500, '补充说明最多 500 字'),
};

const inviteSchema = z.object({
  email: z.string().trim().email('请输入有效的内部邮箱').max(254),
  displayName: z.string().trim().min(1, '请输入显示名称').max(80),
  role: z.enum(roles),
  ...reasonFields,
});

const actionSchema = z.object({
  role: z.enum(roles),
  ...reasonFields,
});

type InviteFields = z.infer<typeof inviteSchema>;
type ActionFields = z.infer<typeof actionSchema>;
type ActionKind = 'role' | 'suspend' | 'sessions' | 'totp';
type ProtectedOutcome = 'completed' | 'step-up';

interface SelectedAction {
  kind: ActionKind;
  administrator: Administrator;
}

const statusPresentation = {
  invited: { label: '待激活', color: 'gold' },
  active: { label: '有效', color: 'green' },
  suspended: { label: '已暂停', color: 'red' },
} as const;

function formatTime(raw?: string): string {
  if (!raw) return '从未登录';
  const value = new Date(raw);
  if (Number.isNaN(value.getTime())) return '—';
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(value);
}

function apiMessage(error: unknown): string {
  return error instanceof APIError ? error.message : '请求未能完成，请稍后重试';
}

interface ReasonValues {
  reasonCode: string;
  ticketReference: string;
  note: string;
}

function ReasonControls<T extends FieldValues & ReasonValues>({
  control,
  errors,
  reasons,
  loading,
  unavailable,
}: {
  control: Control<T>;
  errors: FieldErrors<T>;
  reasons: ReasonCode[];
  loading: boolean;
  unavailable: boolean;
}) {
  const reasonError = errors.reasonCode?.message as string | undefined;
  const ticketError = errors.ticketReference?.message as string | undefined;
  const noteError = errors.note?.message as string | undefined;
  return (
    <>
      {unavailable && <Alert type="error" showIcon message="标准原因暂时不可用，当前操作已禁止提交" />}
      {!loading && !unavailable && reasons.length === 0 && (
        <Alert type="warning" showIcon message="暂无适用于此操作的有效标准原因，当前操作已禁止提交" />
      )}
      <Form.Item label="标准原因" validateStatus={reasonError ? 'error' : undefined} help={reasonError}>
        <Controller
          name={'reasonCode' as Path<T>}
          control={control}
          render={({ field }) => (
            <Select
              {...field}
              aria-label="标准原因"
              loading={loading}
              disabled={loading || unavailable || reasons.length === 0}
              virtual={false}
              options={reasons.map((reason) => ({ value: reason.code, label: reason.label }))}
            />
          )}
        />
      </Form.Item>
      <Form.Item label="工单编号" validateStatus={ticketError ? 'error' : undefined} help={ticketError}>
        <Controller
          name={'ticketReference' as Path<T>}
          control={control}
          render={({ field }) => <Input {...field} aria-label="工单编号" placeholder="可选，例如 SEC-1024" />}
        />
      </Form.Item>
      <Form.Item label="补充说明" validateStatus={noteError ? 'error' : undefined} help={noteError}>
        <Controller
          name={'note' as Path<T>}
          control={control}
          render={({ field }) => <Input.TextArea {...field} aria-label="补充说明" rows={3} showCount maxLength={500} />}
        />
      </Form.Item>
    </>
  );
}

export function AdministratorsPage() {
  const auth = useAuth();
  const queryClient = useQueryClient();
  const [inviteOpen, setInviteOpen] = useState(false);
  const [selectedAction, setSelectedAction] = useState<SelectedAction | null>(null);
  const [oneTimeResult, setOneTimeResult] = useState<InvitationResult | null>(null);
  const [acknowledged, setAcknowledged] = useState(false);
  const [oneTimeCopyError, setOneTimeCopyError] = useState<string | null>(null);
  const [pageError, setPageError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [stepUpOpen, setStepUpOpen] = useState(false);
  const [pendingAction, setPendingAction] = useState<(() => Promise<void>) | null>(null);
  const submissionLock = useRef(false);
  const role = auth.session?.administrator.role;
  const canManage = role ? hasPermission(role, 'administrator.manage') : false;
  const currentAdminID = auth.session?.administrator.admin_id;

  const administratorReasons = useReasonCodes(
    'administrator',
    canManage && (inviteOpen || Boolean(selectedAction && selectedAction.kind !== 'sessions')),
  );
  const sessionReasons = useReasonCodes(
    'session',
    canManage && selectedAction?.kind === 'sessions',
  );
  const activeAdministratorReasons = (administratorReasons.data?.items ?? []).filter((reason) => reason.active);
  const activeSessionReasons = (sessionReasons.data?.items ?? []).filter((reason) => reason.active);
  const selectedReasonCatalog = selectedAction?.kind === 'sessions' ? sessionReasons : administratorReasons;
  const selectedReasons = selectedAction?.kind === 'sessions' ? activeSessionReasons : activeAdministratorReasons;
  const inviteReasonsReady = administratorReasons.isSuccess && activeAdministratorReasons.length > 0;
  const actionReasonsReady = selectedReasonCatalog.isSuccess && selectedReasons.length > 0;

  const administrators = useQuery({
    queryKey: ['administrators'],
    queryFn: () => request<AdministratorList>('/admin-users'),
    enabled: Boolean(auth.session),
    retry: false,
  });

  const inviteForm = useForm<InviteFields>({
    resolver: zodResolver(inviteSchema),
    defaultValues: {
      email: '', displayName: '', role: 'support', reasonCode: '', ticketReference: '', note: '',
    },
  });
  const actionForm = useForm<ActionFields>({
    resolver: zodResolver(actionSchema),
    defaultValues: { role: 'support', reasonCode: '', ticketReference: '', note: '' },
  });

  const refresh = async () => {
    await queryClient.invalidateQueries({ queryKey: ['administrators'] });
  };

  const beginSubmission = () => {
    if (submissionLock.current) return false;
    submissionLock.current = true;
    setSubmitting(true);
    return true;
  };

  const finishSubmission = () => {
    submissionLock.current = false;
    setSubmitting(false);
  };

  const executeProtected = async (operation: () => Promise<void>): Promise<ProtectedOutcome> => {
    setPageError(null);
    try {
      await operation();
      return 'completed';
    } catch (error) {
      if (error instanceof APIError && error.code === 'STEP_UP_REQUIRED') {
        setPendingAction(() => operation);
        setStepUpOpen(true);
        return 'step-up';
      }
      setPageError(apiMessage(error));
      return 'completed';
    }
  };

  const invite = async () => {
    if (!beginSubmission()) return;
    let outcome: ProtectedOutcome = 'completed';
    await inviteForm.handleSubmit(async (values) => {
      const operation = async () => {
        const invitation = await postJSON<InvitationResult>('/admin-users/invitations', {
          email: values.email.trim(),
          display_name: values.displayName.trim(),
          role: values.role,
          reason_code: values.reasonCode,
          ticket_reference: values.ticketReference.trim(),
          note: values.note.trim(),
        });
        setOneTimeResult(invitation);
        setAcknowledged(false);
        setOneTimeCopyError(null);
        setInviteOpen(false);
        inviteForm.reset();
        await refresh();
      };
      outcome = await executeProtected(operation);
    })();
    if (outcome === 'completed') finishSubmission();
  };

  const submitAction = async () => {
    if (!selectedAction) return;
    if (!beginSubmission()) return;
    let outcome: ProtectedOutcome = 'completed';
    await actionForm.handleSubmit(async (values) => {
      const target = selectedAction.administrator;
      const reason = {
        reason_code: values.reasonCode,
        ticket_reference: values.ticketReference.trim(),
        note: values.note.trim(),
      };
      const operation = async () => {
        if (selectedAction.kind === 'role') {
          await putJSON<{ status: string }>(`/admin-users/${target.id}/role`, { role: values.role, ...reason });
        } else if (selectedAction.kind === 'suspend') {
          await postJSON<{ status: string }>(`/admin-users/${target.id}/suspend`, reason);
        } else if (selectedAction.kind === 'sessions') {
          await postJSON<{ status: string }>(`/admin-users/${target.id}/sessions/revoke`, reason);
        } else {
          const invitation = await postJSON<InvitationResult>(`/admin-users/${target.id}/totp/reset`, reason);
          setOneTimeResult(invitation);
          setAcknowledged(false);
          setOneTimeCopyError(null);
        }
        setSelectedAction(null);
        actionForm.reset();
        await refresh();
      };
      outcome = await executeProtected(operation);
    })();
    if (outcome === 'completed') finishSubmission();
  };

  const openAction = (kind: ActionKind, administrator: Administrator) => {
    setPageError(null);
    actionForm.reset({
      role: administrator.role,
      reasonCode: '',
      ticketReference: '',
      note: '',
    });
    setSelectedAction({ kind, administrator });
  };

  const columns: ColumnsType<Administrator> = [
      {
        title: '内部身份',
        key: 'identity',
        width: 230,
        render: (_, item) => (
          <div className="table-primary-cell">
            <strong>{item.display_name}</strong>
            <span>{item.masked_identity}</span>
          </div>
        ),
      },
      { title: '角色', dataIndex: 'role', width: 130, render: (value: AdminRole) => roleLabels[value] },
      {
        title: '状态', dataIndex: 'status', width: 105,
        render: (value: Administrator['status']) => {
          const presentation = statusPresentation[value];
          return <Tag color={presentation.color}>{presentation.label}</Tag>;
        },
      },
      {
        title: 'MFA', dataIndex: 'mfa_enabled', width: 100,
        render: (enabled: boolean) => <Tag color={enabled ? 'blue' : 'default'}>{enabled ? '已启用' : '未启用'}</Tag>,
      },
      { title: '最近登录', dataIndex: 'last_login_at', width: 180, render: (value?: string) => formatTime(value) },
      { title: '安全版本', dataIndex: 'security_version', width: 100, align: 'center' },
      ...(canManage
        ? [
            {
              title: '操作', key: 'actions', width: 350, fixed: 'right' as const,
              render: (_: unknown, item: Administrator) => {
                const self = item.id === currentAdminID;
                return (
                  <Space size={2}>
                    <Button type="link" size="small" disabled={submitting || self} onClick={() => openAction('role', item)}>角色</Button>
                    <Button type="link" size="small" danger disabled={submitting || self || item.status !== 'active'} onClick={() => openAction('suspend', item)}>暂停</Button>
                    <Button type="link" size="small" disabled={submitting || self || item.status !== 'active'} onClick={() => openAction('sessions', item)}>撤销会话</Button>
                    <Button type="link" size="small" disabled={submitting || self || !item.mfa_enabled} onClick={() => openAction('totp', item)}>重置 MFA</Button>
                  </Space>
                );
              },
            },
          ]
        : []),
    ];

  const actionTitle = selectedAction
    ? selectedAction.kind === 'role'
      ? '调整管理员角色'
      : selectedAction.kind === 'suspend'
        ? '暂停管理员账号'
        : selectedAction.kind === 'sessions'
          ? '撤销管理员全部会话'
        : '重置管理员 MFA'
    : '';

  return (
    <>
      <div className="page-heading">
        <div>
          <Typography.Title level={3}>内部管理员</Typography.Title>
          <Typography.Text type="secondary">独立管理员身份、固定角色与强制 MFA 生命周期</Typography.Text>
        </div>
        {canManage && <Button type="primary" icon={<PlusOutlined />} disabled={submitting} onClick={() => setInviteOpen(true)}>邀请管理员</Button>}
      </div>

      <Card className="data-card" variant="borderless">
        <div className="data-card-toolbar">
          <Space>
            <TeamOutlined />
            <Typography.Text strong>管理员目录</Typography.Text>
            <Tag>{administrators.data?.items.length ?? 0} 人</Tag>
          </Space>
          <Typography.Text type="secondary">身份始终由后端脱敏后返回</Typography.Text>
        </div>
        {pageError && <Alert className="page-alert" type="error" showIcon closable message={pageError} onClose={() => setPageError(null)} />}
        {administrators.isError ? (
          <Empty description={apiMessage(administrators.error)}>
            <Button onClick={() => void administrators.refetch()}>重新加载</Button>
          </Empty>
        ) : (
          <Table
            rowKey="id"
            loading={administrators.isPending}
            dataSource={administrators.data?.items ?? []}
            columns={columns}
            pagination={false}
            scroll={{ x: 1170 }}
          />
        )}
      </Card>

      <Modal
        title="邀请内部管理员"
        open={inviteOpen}
        okText="生成一次性激活链接"
        cancelText="取消"
        width={620}
        confirmLoading={submitting}
        okButtonProps={{ disabled: submitting || !inviteReasonsReady }}
        maskClosable={false}
        closable={!submitting}
        cancelButtonProps={{ disabled: submitting }}
        onOk={() => void invite()}
        onCancel={() => {
          if (submitting) return;
          setInviteOpen(false);
          inviteForm.reset();
        }}
      >
        <Alert type="warning" showIcon message="完整邮箱仅用于精确创建身份，不会在列表或审计中明文展示。" />
        <Form layout="vertical" requiredMark={false} className="modal-form">
          <Form.Item label="内部邮箱" validateStatus={inviteForm.formState.errors.email ? 'error' : undefined} help={inviteForm.formState.errors.email?.message}>
            <Controller name="email" control={inviteForm.control} render={({ field }) => <Input {...field} aria-label="邀请邮箱" autoComplete="off" />} />
          </Form.Item>
          <Form.Item label="显示名称" validateStatus={inviteForm.formState.errors.displayName ? 'error' : undefined} help={inviteForm.formState.errors.displayName?.message}>
            <Controller name="displayName" control={inviteForm.control} render={({ field }) => <Input {...field} aria-label="显示名称" />} />
          </Form.Item>
          <Form.Item label="固定角色" validateStatus={inviteForm.formState.errors.role ? 'error' : undefined} help={inviteForm.formState.errors.role?.message}>
            <Controller
              name="role"
              control={inviteForm.control}
              render={({ field }) => <Select {...field} aria-label="固定角色" options={roles.map((value) => ({ value, label: roleLabels[value] }))} />}
            />
          </Form.Item>
          <ReasonControls
            control={inviteForm.control}
            errors={inviteForm.formState.errors}
            reasons={activeAdministratorReasons}
            loading={administratorReasons.isPending}
            unavailable={administratorReasons.isError}
          />
        </Form>
      </Modal>

      <Modal
        title={actionTitle}
        open={Boolean(selectedAction)}
        okText="确认执行"
        cancelText="取消"
        confirmLoading={submitting}
        okButtonProps={{ disabled: submitting || !actionReasonsReady }}
        maskClosable={false}
        closable={!submitting}
        cancelButtonProps={{ disabled: submitting }}
        onOk={() => void submitAction()}
        onCancel={() => {
          if (!submitting) setSelectedAction(null);
        }}
      >
        {selectedAction && (
          <Typography.Paragraph>
            目标：<strong>{selectedAction.administrator.display_name}</strong>（{selectedAction.administrator.masked_identity}）
          </Typography.Paragraph>
        )}
        {selectedAction?.kind === 'sessions' && (
          <Alert
            type="warning"
            showIcon
            message="目标管理员当前全部会话会立即失效"
            description="此操作不会暂停账号；目标管理员仍可使用有效凭证重新登录。重复执行不会重复变更安全版本。"
          />
        )}
        <Form layout="vertical" requiredMark={false} className="modal-form">
          {selectedAction?.kind === 'role' && (
            <Form.Item label="新角色" validateStatus={actionForm.formState.errors.role ? 'error' : undefined} help={actionForm.formState.errors.role?.message}>
              <Controller
                name="role"
                control={actionForm.control}
                render={({ field }) => <Select {...field} aria-label="新角色" options={roles.map((value) => ({ value, label: roleLabels[value] }))} />}
              />
            </Form.Item>
          )}
          <ReasonControls
            control={actionForm.control}
            errors={actionForm.formState.errors}
            reasons={selectedReasons}
            loading={selectedReasonCatalog.isPending}
            unavailable={selectedReasonCatalog.isError}
          />
        </Form>
      </Modal>

      <Modal
        title="一次性激活链接"
        open={Boolean(oneTimeResult)}
        closable={false}
        maskClosable={false}
        keyboard={false}
        footer={
          <Button
            type="primary"
            disabled={!acknowledged}
            onClick={() => {
              setOneTimeResult(null);
              setAcknowledged(false);
              setOneTimeCopyError(null);
            }}
          >
            已完成安全转交
          </Button>
        }
      >
        <Alert type="warning" showIcon message="链接仅展示一次" description="请通过公司批准的安全渠道交给目标人员，不要粘贴到工单正文或聊天记录。" />
        {oneTimeCopyError && <Alert className="page-alert" type="error" showIcon message={oneTimeCopyError} />}
        <div className="one-time-secret">
          <code>{oneTimeResult?.activation_url}</code>
          <Button
            icon={<CopyOutlined />}
            onClick={() => void (async () => {
              if (!oneTimeResult) return;
              setOneTimeCopyError(null);
              try {
                await copySensitiveText(oneTimeResult.activation_url);
                void message.success('一次性链接已复制');
              } catch {
                setOneTimeCopyError('复制失败，请手动选择并安全转交激活链接');
              }
            })()}
          >复制链接</Button>
        </div>
        <Checkbox checked={acknowledged} onChange={(event) => setAcknowledged(event.target.checked)}>
          我已通过批准的安全渠道转交
        </Checkbox>
      </Modal>

      <StepUpModal
        open={stepUpOpen}
        onCancel={() => {
          finishSubmission();
          setStepUpOpen(false);
          setPendingAction(null);
        }}
        onVerified={async () => {
          const operation = pendingAction;
          if (!operation) {
            finishSubmission();
            setStepUpOpen(false);
            return;
          }
          const outcome = await executeProtected(operation);
          if (outcome === 'completed') {
            finishSubmission();
            setStepUpOpen(false);
            setPendingAction(null);
          }
        }}
      />
    </>
  );
}
