import { Alert, Button, Empty } from 'antd';
import type { ReactNode } from 'react';

import { APIError } from '../api/client';

interface CloudBoundaryProps {
  error: unknown;
  empty: boolean;
  onRetry: () => void;
  children: ReactNode;
}

export function CloudBoundary({ error, empty, onRetry, children }: CloudBoundaryProps) {
  if (error instanceof APIError) {
    const contract = error.code === 'CLOUD_CONTRACT_VIOLATION';
    const notConfigured = error.code === 'CLOUD_NOT_CONFIGURED';
    return (
      <div className="cloud-boundary">
        <Alert
          showIcon
          type={contract ? 'error' : 'warning'}
          message={
            contract
              ? 'Cloud 安全契约异常'
              : notConfigured
                ? 'Cloud 管理服务尚未配置'
                : 'Cloud 管理服务暂时不可用'
          }
          description="系统未生成演示数据，也不会把失败显示为成功。"
          action={<Button onClick={onRetry}>重新检查</Button>}
        />
      </div>
    );
  }
  if (error) {
    return (
      <div className="cloud-boundary">
        <Alert showIcon type="error" message="请求未能完成" />
      </div>
    );
  }
  if (empty) {
    return <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="没有符合条件的数据" />;
  }
  return <>{children}</>;
}
