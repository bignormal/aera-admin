import { ReloadOutlined, SearchOutlined } from '@ant-design/icons';
import { useQuery } from '@tanstack/react-query';
import type { ColumnsType } from 'antd/es/table';
import {
  Alert,
  Button,
  Card,
  DatePicker,
  Descriptions,
  Drawer,
  Empty,
  Form,
  Input,
  Select,
  Space,
  Table,
  Tag,
  Typography,
} from 'antd';
import { useMemo, useState } from 'react';

import { APIError, listAuditEvents } from '../api/client';
import {
  type AdminRole,
  type AuditEvent,
  type AuditOutcome,
  isAdminRole,
  roleLabels,
} from '../api/contracts';
import { useAuth } from '../auth/AuthProvider';

interface DateValue {
  toISOString(): string;
}

interface AuditFilterForm {
  actor_admin_id?: string;
  event_type?: string;
  object_type?: string;
  object_id?: string;
  outcome?: AuditOutcome;
  reason_code?: string;
  time_range?: [DateValue | null, DateValue | null];
}

interface AppliedFilters {
  actorAdminID: string;
  eventType: string;
  objectType: string;
  objectID: string;
  outcome: AuditOutcome | '';
  reasonCode: string;
  from: string;
  to: string;
}

const emptyFilters: AppliedFilters = {
  actorAdminID: '',
  eventType: '',
  objectType: '',
  objectID: '',
  outcome: '',
  reasonCode: '',
  from: '',
  to: '',
};

const outcomePresentation: Record<AuditOutcome, { label: string; color: string }> = {
  success: { label: '成功', color: 'green' },
  failure: { label: '失败', color: 'red' },
  denied: { label: '已拒绝', color: 'gold' },
};

const safeStateKeys = new Set([
  'account_status',
  'active',
  'approval_status',
  'audit_retention_days',
  'category',
  'device_status',
  'execution_status',
  'filter_actor',
  'filter_event',
  'filter_object',
  'filter_outcome',
  'filter_reason',
  'filter_time',
  'label_changed',
  'mfa_status',
  'operation_status',
  'reason_code',
  'result_count',
  'revision',
  'role',
  'security_version',
  'session_absolute_hours',
  'session_idle_minutes',
  'session_status',
  'status',
]);
const safeStateValue = /^[A-Za-z0-9._:-]{1,128}$/;
const sensitiveText = /(?:[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9.-]+|(?:\+?86[ -]?)?1[3-9](?:[ -]?[0-9]){9})/i;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

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
    second: '2-digit',
    hour12: false,
  }).format(value);
}

function safeOptionalText(raw?: string): string {
  if (!raw) return '—';
  return sensitiveText.test(raw) ? '已隐藏敏感内容' : raw;
}

function stateEntries(state?: Record<string, string>): Array<[string, string]> {
  if (!state) return [];
  return Object.entries(state)
    .filter(([key, value]) => safeStateKeys.has(key) && safeStateValue.test(value) && !sensitiveText.test(value))
    .sort(([left], [right]) => left.localeCompare(right));
}

function buildQuery(filters: AppliedFilters, cursor: string): URLSearchParams {
  const query = new URLSearchParams({ limit: '20' });
  if (filters.actorAdminID) query.set('actor_admin_id', filters.actorAdminID);
  if (filters.eventType) query.set('event_type', filters.eventType);
  if (filters.objectType) query.set('object_type', filters.objectType);
  if (filters.objectID) query.set('object_id', filters.objectID);
  if (filters.outcome) query.set('outcome', filters.outcome);
  if (filters.reasonCode) query.set('reason_code', filters.reasonCode);
  if (filters.from) query.set('from', filters.from);
  if (filters.to) query.set('to', filters.to);
  if (cursor) query.set('cursor', cursor);
  return query;
}

function roleLabel(role?: AdminRole): string {
  return role && isAdminRole(role) ? roleLabels[role] : '系统';
}

export function AuditPage() {
  const auth = useAuth();
  const [form] = Form.useForm<AuditFilterForm>();
  const [filters, setFilters] = useState<AppliedFilters>(emptyFilters);
  const [cursor, setCursor] = useState('');
  const [cursorHistory, setCursorHistory] = useState<string[]>([]);
  const [selectedEvent, setSelectedEvent] = useState<AuditEvent | null>(null);
  const role = auth.session?.administrator.role;
  const fullScope = role === 'super_admin' || role === 'auditor';
  const ownScope = role === 'operator' || role === 'support';
  const queryParameters = useMemo(() => buildQuery(filters, cursor), [cursor, filters]);

  const events = useQuery({
    queryKey: ['audit-events', queryParameters.toString()],
    queryFn: () => listAuditEvents(queryParameters),
    enabled: Boolean(auth.session) && (fullScope || ownScope),
    retry: false,
  });

  const columns: ColumnsType<AuditEvent> = [
    {
      title: '事件',
      dataIndex: 'event_type',
      width: 220,
      render: (value: string, event) => (
        <div className="table-primary-cell">
          <strong>{value}</strong>
          <span>{event.id}</span>
        </div>
      ),
    },
    {
      title: '操作人',
      key: 'actor',
      width: 230,
      render: (_, event) => (
        <div className="table-primary-cell">
          <strong>{roleLabel(event.actor_role)}</strong>
          <span>{event.actor_admin_id ?? '系统'}</span>
        </div>
      ),
    },
    {
      title: '对象',
      key: 'object',
      width: 230,
      render: (_, event) => (
        <div className="table-primary-cell">
          <strong>{event.object_type}</strong>
          <span>{event.object_id ?? '—'}</span>
        </div>
      ),
    },
    {
      title: '结果',
      dataIndex: 'outcome',
      width: 100,
      render: (value: AuditOutcome) => (
        <Tag color={outcomePresentation[value]?.color ?? 'default'}>
          {outcomePresentation[value]?.label ?? '未知'}
        </Tag>
      ),
    },
    { title: '标准原因', dataIndex: 'reason_code', width: 150, render: safeOptionalText },
    { title: '发生时间', dataIndex: 'created_at', width: 185, render: formatTime },
    {
      title: '操作',
      key: 'action',
      width: 110,
      fixed: 'right',
      render: (_, event) => <Button type="link" onClick={() => setSelectedEvent(event)}>查看详情</Button>,
    },
  ];

  const applyFilters = (values: AuditFilterForm) => {
    const from = values.time_range?.[0]?.toISOString() ?? '';
    const to = values.time_range?.[1]?.toISOString() ?? '';
    setFilters({
      actorAdminID: fullScope ? values.actor_admin_id?.trim() ?? '' : '',
      eventType: values.event_type?.trim() ?? '',
      objectType: values.object_type?.trim() ?? '',
      objectID: values.object_id?.trim() ?? '',
      outcome: values.outcome ?? '',
      reasonCode: values.reason_code?.trim() ?? '',
      from,
      to,
    });
    setCursor('');
    setCursorHistory([]);
  };

  const items = events.data?.items ?? [];
  const errorMessage =
    events.error instanceof APIError && events.error.code === 'AUDIT_UNAVAILABLE'
      ? '审计服务暂时不可用'
      : '审计记录加载失败';
  const beforeState = stateEntries(selectedEvent?.before_state);
  const afterState = stateEntries(selectedEvent?.after_state);

  return (
    <div className="audit-page">
      <div className="page-heading">
        <div>
          <Typography.Title level={3}>审计记录</Typography.Title>
          <Typography.Paragraph type="secondary">
            查询采用不可变审计链的安全投影，不展示来源 IP 摘要、User-Agent 或哈希链字段。
          </Typography.Paragraph>
        </div>
        <Button icon={<ReloadOutlined />} loading={events.isFetching} onClick={() => void events.refetch()}>
          刷新记录
        </Button>
      </div>

      <Alert
        className="page-alert"
        showIcon
        type={fullScope ? 'info' : 'warning'}
        message={fullScope ? '可查看全部管理员审计记录' : '仅显示本人操作记录'}
        description={
          fullScope
            ? '可按操作人和对象筛选；每次查询本身也会写入审计。'
            : '操作人范围由服务端根据当前会话强制限定，无法通过页面参数扩大。'
        }
      />

      <Card className="filter-card">
        <Form<AuditFilterForm> form={form} layout="vertical" onFinish={applyFilters}>
          <Space wrap align="end" size={10}>
            {fullScope && (
              <Form.Item
                label="操作人 ID"
                name="actor_admin_id"
                rules={[{ pattern: uuidPattern, message: '请输入有效 UUID' }]}
              >
                <Input allowClear style={{ width: 270 }} autoComplete="off" />
              </Form.Item>
            )}
            <Form.Item
              label="事件类型"
              name="event_type"
              rules={[{ pattern: /^[a-z][a-z0-9_.]{0,99}$/, message: '事件类型格式无效' }]}
            >
              <Input allowClear style={{ width: 205 }} autoComplete="off" />
            </Form.Item>
            <Form.Item
              label="对象类型"
              name="object_type"
              rules={[{ pattern: /^[a-z][a-z0-9_.]{0,99}$/, message: '对象类型格式无效' }]}
            >
              <Input allowClear style={{ width: 185 }} autoComplete="off" />
            </Form.Item>
            <Form.Item
              label="对象 ID"
              name="object_id"
              rules={[{ pattern: uuidPattern, message: '请输入有效 UUID' }]}
            >
              <Input allowClear style={{ width: 270 }} autoComplete="off" />
            </Form.Item>
            <Form.Item label="结果" name="outcome">
              <Select
                allowClear
                style={{ width: 130 }}
                options={Object.entries(outcomePresentation).map(([value, item]) => ({ value, label: item.label }))}
              />
            </Form.Item>
            <Form.Item
              label="标准原因"
              name="reason_code"
              rules={[{ pattern: /^[a-z][a-z0-9_]{2,63}$/, message: '原因码格式无效' }]}
            >
              <Input allowClear style={{ width: 180 }} autoComplete="off" />
            </Form.Item>
            <Form.Item label="时间范围" name="time_range">
              <DatePicker.RangePicker showTime allowClear />
            </Form.Item>
            <Form.Item>
              <Space>
                <Button aria-label="查询审计" type="primary" htmlType="submit" icon={<SearchOutlined />}>
                  查询审计
                </Button>
                <Button
                  onClick={() => {
                    form.resetFields();
                    setFilters(emptyFilters);
                    setCursor('');
                    setCursorHistory([]);
                  }}
                >
                  重置
                </Button>
              </Space>
            </Form.Item>
          </Space>
        </Form>
      </Card>

      {events.isError && (
        <Alert
          className="page-alert"
          showIcon
          type="error"
          message={errorMessage}
          description="查询已失败关闭，不会展示可能不完整的审计数据。"
          action={<Button onClick={() => void events.refetch()}>重试</Button>}
        />
      )}

      {!events.isError && (
        <Card className="data-card">
          <div className="data-card-toolbar">
            <Typography.Text strong>审计事件</Typography.Text>
            <Space>
              <Button
                disabled={cursorHistory.length === 0 || events.isFetching}
                onClick={() => {
                  const history = [...cursorHistory];
                  setCursor(history.pop() ?? '');
                  setCursorHistory(history);
                }}
              >
                上一页
              </Button>
              <Button
                disabled={!events.data?.next_cursor || events.isFetching}
                onClick={() => {
                  if (!events.data?.next_cursor) return;
                  setCursorHistory((history) => [...history, cursor]);
                  setCursor(events.data.next_cursor ?? '');
                }}
              >
                下一页
              </Button>
            </Space>
          </div>
          {events.isSuccess && items.length === 0 ? (
            <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="没有符合条件的审计记录" />
          ) : (
            <Table
              rowKey="id"
              loading={events.isPending}
              dataSource={items}
              columns={columns}
              pagination={false}
              scroll={{ x: 1195 }}
            />
          )}
        </Card>
      )}

      <Drawer
        title="审计详情"
        width={640}
        open={Boolean(selectedEvent)}
        closable={false}
        destroyOnHidden
        extra={<Button aria-label="关闭" onClick={() => setSelectedEvent(null)}>关闭</Button>}
        onClose={() => setSelectedEvent(null)}
      >
        {selectedEvent && (
          <Descriptions column={1} size="small" bordered>
            <Descriptions.Item label="事件 ID">{selectedEvent.id}</Descriptions.Item>
            <Descriptions.Item label="事件类型">{selectedEvent.event_type}</Descriptions.Item>
            <Descriptions.Item label="操作人角色">{roleLabel(selectedEvent.actor_role)}</Descriptions.Item>
            <Descriptions.Item label="操作人 ID">{selectedEvent.actor_admin_id ?? '系统'}</Descriptions.Item>
            <Descriptions.Item label="对象类型">{selectedEvent.object_type}</Descriptions.Item>
            <Descriptions.Item label="对象 ID">{selectedEvent.object_id ?? '—'}</Descriptions.Item>
            <Descriptions.Item label="结果">
              {outcomePresentation[selectedEvent.outcome]?.label ?? '未知'}
            </Descriptions.Item>
            <Descriptions.Item label="标准原因">{safeOptionalText(selectedEvent.reason_code)}</Descriptions.Item>
            <Descriptions.Item label="工单编号">{safeOptionalText(selectedEvent.ticket_reference)}</Descriptions.Item>
            <Descriptions.Item label="补充说明">{safeOptionalText(selectedEvent.note)}</Descriptions.Item>
            <Descriptions.Item label="审批 ID">{selectedEvent.approval_id ?? '—'}</Descriptions.Item>
            <Descriptions.Item label="操作 ID">{selectedEvent.operation_id ?? '—'}</Descriptions.Item>
            <Descriptions.Item label="错误码">{safeOptionalText(selectedEvent.error_code)}</Descriptions.Item>
            <Descriptions.Item label="请求 ID">{selectedEvent.request_id}</Descriptions.Item>
            <Descriptions.Item label="发生时间">{formatTime(selectedEvent.created_at)}</Descriptions.Item>
            <Descriptions.Item label="变更前状态">
              {beforeState.length === 0 ? '—' : beforeState.map(([key, value]) => `${key}: ${value}`).join(' · ')}
            </Descriptions.Item>
            <Descriptions.Item label="变更后状态">
              {afterState.length === 0 ? '—' : afterState.map(([key, value]) => `${key}: ${value}`).join(' · ')}
            </Descriptions.Item>
          </Descriptions>
        )}
      </Drawer>
    </div>
  );
}
