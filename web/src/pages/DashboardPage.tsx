import {
  ApiOutlined,
  AuditOutlined,
  LockOutlined,
  SafetyCertificateOutlined,
} from '@ant-design/icons';
import { useQuery } from '@tanstack/react-query';
import { Alert, Badge, Card, Col, Row, Space, Steps, Tag, Typography } from 'antd';
import type { ReactNode } from 'react';

import { request } from '../api/client';
import {
  hasPermission,
  type CloudAvailability,
  type Page,
  type ApprovalRequest,
  type SystemHealth,
} from '../api/contracts';
import { useAuth } from '../auth/AuthProvider';

const { Paragraph, Text, Title } = Typography;

interface StatusPresentation {
  content: ReactNode;
  color: string;
}

const cloudPresentation: Record<CloudAvailability, StatusPresentation> = {
  available: { content: '可用', color: 'success' },
  unavailable: { content: '暂时不可用', color: 'error' },
  not_configured: { content: '未配置', color: 'default' },
  contract_error: { content: '契约异常', color: 'warning' },
};

function pendingStatus(): StatusPresentation {
  return { content: '加载中', color: 'processing' };
}

function unavailableStatus(): StatusPresentation {
  return { content: '不可用', color: 'default' };
}

function deniedStatus(): StatusPresentation {
  return { content: '无访问权限', color: 'default' };
}

export function DashboardPage() {
  const auth = useAuth();
  const role = auth.session?.administrator.role;
  const canReadHealth = role ? hasPermission(role, 'service_health.read') : false;
  const approvalView = role === 'super_admin' ? 'pending_for_me' : role === 'operator' ? 'mine' : null;

  const health = useQuery({
    queryKey: ['system-health'],
    queryFn: () => request<SystemHealth>('/system/health'),
    enabled: Boolean(role && canReadHealth),
    retry: false,
    refetchInterval: 15_000,
  });
  const approvals = useQuery({
    queryKey: ['approval-requests', approvalView, 'dashboard'],
    queryFn: () => request<Page<ApprovalRequest>>(`/approval-requests?view=${approvalView}&limit=5`),
    enabled: Boolean(approvalView),
    retry: false,
    refetchInterval: 15_000,
  });

  const adminStatus = !canReadHealth
    ? deniedStatus()
    : health.isSuccess
      ? { content: health.data.admin === 'ok' ? '正常' : '不可用', color: health.data.admin === 'ok' ? 'success' : 'error' }
      : health.isError
        ? unavailableStatus()
        : pendingStatus();
  const cloudStatus = !canReadHealth
    ? deniedStatus()
    : health.isSuccess
      ? cloudPresentation[health.data.cloud.availability]
      : health.isError
        ? unavailableStatus()
        : pendingStatus();
  const approvalStatus = !approvalView
    ? deniedStatus()
    : approvals.isSuccess
      ? {
          content: role === 'super_admin'
            ? `${approvals.data.items.length} 项待处理`
            : `${approvals.data.items.length} 项申请`,
          color: approvals.data.items.length > 0 ? 'processing' : 'success',
        }
      : approvals.isError
        ? unavailableStatus()
        : pendingStatus();

  const foundationCards: Array<{
    title: string;
    description: string;
    status: StatusPresentation;
    icon: ReactNode;
  }> = [
    {
      title: '管理员安全底座',
      description: '独立账号、强制 TOTP、会话与固定 RBAC',
      status: adminStatus,
      icon: <LockOutlined />,
    },
    {
      title: '多因素认证策略',
      description: '所有内部角色必须完成密码与 TOTP',
      status: { content: '强制启用', color: 'blue' },
      icon: <SafetyCertificateOutlined />,
    },
    {
      title: 'Aera Cloud 管理链路',
      description: '独立 Internal Admin API 与 mTLS 服务身份',
      status: cloudStatus,
      icon: <ApiOutlined />,
    },
    {
      title: '双人审批队列',
      description: role === 'operator' ? '我发起的账号处置申请' : '等待当前角色处理的账号处置申请',
      status: approvalStatus,
      icon: <AuditOutlined />,
    },
  ];

  return (
    <div className="dashboard-page">
      <div className="page-heading">
        <div>
          <Title level={3}>内部运营工作台</Title>
          <Paragraph type="secondary">
            当前展示工程真实接入状态；未连接的数据源不会生成演示指标。
          </Paragraph>
        </div>
        <Space>
          <Badge status="processing" text="Admin Foundation V1" />
          <Tag color="blue">Phase 1</Tag>
        </Space>
      </div>

      <Alert
        showIcon
        type="info"
        message="Cloud 管理链路严格失败关闭"
        description="请求受理、审批通过和 Cloud 执行成功是三个独立状态；不可达或对账中不会显示成功。"
      />

      <Row gutter={[14, 14]} className="foundation-grid">
        {foundationCards.map((item) => (
          <Col xs={24} sm={12} xl={6} key={item.title}>
            <Card className="foundation-card" variant="outlined">
              <div className="foundation-icon">{item.icon}</div>
              <Text type="secondary">{item.title}</Text>
              <Title level={5}>{item.description}</Title>
              <Tag color={item.status.color}>{item.status.content}</Tag>
            </Card>
          </Col>
        ))}
      </Row>

      <Card title="一期交付顺序" className="delivery-card">
        <Steps
          current={3}
          items={[
            { title: '安全底座', description: '账号、TOTP、RBAC' },
            { title: 'Cloud 只读链路', description: '用户、设备、会话' },
            { title: '单项处置', description: '撤销会话或设备' },
            { title: '双人审批', description: '账号禁用与恢复' },
          ]}
        />
      </Card>
    </div>
  );
}
