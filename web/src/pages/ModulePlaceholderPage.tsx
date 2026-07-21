import { Card, Empty, Typography } from 'antd';

type ModulePlaceholderPageProps = {
  title: string;
};

export function ModulePlaceholderPage({ title }: ModulePlaceholderPageProps) {
  return (
    <Card>
      <Empty
        image={Empty.PRESENTED_IMAGE_SIMPLE}
        description={
          <span>
            <Typography.Text strong>{title}</Typography.Text>
            <br />
            <Typography.Text type="secondary">该模块将在对应安全能力完成后启用</Typography.Text>
          </span>
        }
      />
    </Card>
  );
}
