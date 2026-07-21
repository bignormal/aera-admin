import { CheckCircleOutlined, CloudServerOutlined, WarningOutlined } from '@ant-design/icons';
import { useQuery } from '@tanstack/react-query';
import { Card, Col, Row, Spin, Tag, Typography } from 'antd';

import { request } from '../api/client';
import type { CloudAvailability, SystemHealth } from '../api/contracts';
import { useAuth } from '../auth/AuthProvider';
import { CloudBoundary } from '../components/CloudBoundary';

type HealthState =
  | 'ok'
  | CloudAvailability
  | 'not_checked';

const presentation: Record<HealthState, { label: string; color: string }> = {
  ok: { label: '正常', color: 'success' },
  available: { label: '可用', color: 'success' },
  unavailable: { label: '暂时不可用', color: 'error' },
  not_configured: { label: '未配置', color: 'default' },
  contract_error: { label: '契约异常', color: 'warning' },
  not_checked: { label: '未检查', color: 'default' },
};

function formatTime(raw: string): string {
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

function HealthCard({ title, state }: { title: string; state: HealthState }) {
  const item = presentation[state];
  const healthy = state === 'ok' || state === 'available';
  return (
    <Card className="health-card" size="small">
      <div className={`health-card-icon ${healthy ? 'health-card-icon-ok' : ''}`} aria-hidden>
        {healthy ? <CheckCircleOutlined /> : <WarningOutlined />}
      </div>
      <div className="health-card-copy">
        <Typography.Text type="secondary">{title}</Typography.Text>
        <Tag color={item.color}>{item.label}</Tag>
      </div>
    </Card>
  );
}

export function SystemHealthPage() {
  const auth = useAuth();
  const health = useQuery({
    queryKey: ['system-health'],
    queryFn: () => request<SystemHealth>('/system/health'),
    enabled: Boolean(auth.session),
    retry: false,
    refetchInterval: 15_000,
  });

  return (
    <div className="system-health-page">
      <div className="page-heading">
        <div>
          <Typography.Title level={3}>服务健康</Typography.Title>
          <Typography.Paragraph type="secondary">
            仅显示安全状态分类，不暴露连接地址、证书信息、密钥路径或原始错误。
          </Typography.Paragraph>
        </div>
      </div>

      {health.isPending && (
        <div className="health-loading"><Spin size="large" /></div>
      )}
      {health.error && (
        <CloudBoundary error={health.error} empty={false} onRetry={() => void health.refetch()}>
          {null}
        </CloudBoundary>
      )}
      {health.data && (
        <>
          <Row gutter={[12, 12]}>
            <Col xs={24} sm={12} xl={6}><HealthCard title="Aera Admin" state={health.data.admin} /></Col>
            <Col xs={24} sm={12} xl={6}><HealthCard title="PostgreSQL" state={health.data.postgres} /></Col>
            <Col xs={24} sm={12} xl={6}><HealthCard title="Redis" state={health.data.redis} /></Col>
            <Col xs={24} sm={12} xl={6}>
              <HealthCard title="Cloud 管理链路" state={health.data.cloud.availability} />
            </Col>
          </Row>

          <Card
            className="cloud-health-card"
            title={<span><CloudServerOutlined aria-hidden /> Cloud 服务身份与上游</span>}
            extra={<Typography.Text type="secondary">检查时间：{formatTime(health.data.cloud.checked_at)}</Typography.Text>}
          >
            <Row gutter={[12, 12]}>
              <Col xs={24} md={8}><HealthCard title="mTLS" state={health.data.cloud.mtls} /></Col>
              <Col xs={24} md={8}><HealthCard title="服务令牌" state={health.data.cloud.service_jwt} /></Col>
              <Col xs={24} md={8}><HealthCard title="Cloud 上游" state={health.data.cloud.upstream} /></Col>
            </Row>
          </Card>
        </>
      )}
    </div>
  );
}
