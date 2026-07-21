import { Badge, Tag } from 'antd';

import type { OperationState } from '../api/contracts';

const presentation: Record<OperationState, { label: string; color: string; processing?: boolean }> = {
  queued: { label: '待执行', color: 'default' },
  executing: { label: '执行中', color: 'processing', processing: true },
  reconciling: { label: '状态未知，正在对账', color: 'warning', processing: true },
  succeeded: { label: '执行成功', color: 'success' },
  failed: { label: '执行失败', color: 'error' },
  conflict: { label: '状态冲突', color: 'warning' },
};

export function OperationStatus({ state }: { state: OperationState }) {
  const item = presentation[state];
  return item.processing ? (
    <Badge className="operation-status" status="processing" text={item.label} />
  ) : (
    <Tag className="operation-status" color={item.color}>
      {item.label}
    </Tag>
  );
}
