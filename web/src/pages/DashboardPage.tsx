import {
  ApiOutlined,
  AuditOutlined,
  LockOutlined,
  SafetyCertificateOutlined,
} from '@ant-design/icons';
import { Alert, Badge, Card, Col, Row, Space, Steps, Tag, Typography } from 'antd';

const { Paragraph, Text, Title } = Typography;

const foundationCards = [
  {
    title: '管理员安全底座',
    description: '独立账号、强制 TOTP、会话与固定 RBAC',
    status: '待初始化',
    color: 'gold',
    icon: <LockOutlined />,
  },
  {
    title: '多因素认证策略',
    description: '所有内部角色必须完成密码与 TOTP',
    status: '强制启用',
    color: 'blue',
    icon: <SafetyCertificateOutlined />,
  },
  {
    title: 'Aera Cloud 管理链路',
    description: '独立 Internal Admin API 与 mTLS 服务身份',
    status: '尚未接入',
    color: 'default',
    icon: <ApiOutlined />,
  },
  {
    title: '不可变审计',
    description: '追加写入、哈希链与敏感字段白名单',
    status: '待初始化',
    color: 'gold',
    icon: <AuditOutlined />,
  },
] as const;

export function DashboardPage() {
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
          <Badge status="processing" text="Security Foundation" />
          <Tag color="blue">Phase 1</Tag>
        </Space>
      </div>

      <Alert
        showIcon
        type="info"
        message="安全初始化完成前，用户处置与 MFA 重置功能保持锁定"
        description="系统需要至少两名已激活的超级管理员，之后才会开放运营功能。"
      />

      <Row gutter={[14, 14]} className="foundation-grid">
        {foundationCards.map((item) => (
          <Col span={6} key={item.title}>
            <Card className="foundation-card" variant="outlined">
              <div className="foundation-icon">{item.icon}</div>
              <Text type="secondary">{item.title}</Text>
              <Title level={5}>{item.description}</Title>
              <Tag color={item.color}>{item.status}</Tag>
            </Card>
          </Col>
        ))}
      </Row>

      <Card title="一期交付顺序" className="delivery-card">
        <Steps
          current={0}
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
