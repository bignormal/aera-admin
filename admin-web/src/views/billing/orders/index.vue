<script setup lang="ts">
import type {
  ResourceCreate,
  ResourceDelete,
  ResourceList,
  ResourceRowAction,
  ResourceUpdate
} from '@/components/platform/resource-crud';
import { useCapability } from '@/composables/use-capability';
import { useStepUp } from '@/composables/use-step-up';
import { cancelPaymentOrder, listBillingResources, processRefund, queryPaymentRefund, retryPaymentOrder } from '@/service/billing';

defineOptions({ name: 'BillingOrdersPage' });
const { can } = useCapability();
const { onStepUpCancelled, onStepUpVerified, runProtected, showStepUp } = useStepUp();
const list: ResourceList = (query, signal) => listBillingResources('orders', query, signal);
const noopCreate: ResourceCreate = async () => undefined;
const noopUpdate: ResourceUpdate = async () => undefined;
const noopDelete: ResourceDelete = async () => undefined;

async function refundOrder(id: string | number) {
  const amount = window.prompt('请输入退款金额；留空表示全额退款', '');
  if (amount === null) return;
  const reason = window.prompt('请输入退款原因', '管理员退款');
  if (reason === null) return;
  const body: Record<string, unknown> = { reason };
  if (amount.trim()) body.amount = Number(amount);
  await runProtected(() => processRefund(id, body));
}

async function queryRefund(id: string | number) {
  const result = await runProtected(() => queryPaymentRefund(id));
  window.$dialog?.info({ title: '退款状态', content: JSON.stringify(result, null, 2), positiveText: '关闭' });
}

const actions: ResourceRowAction[] = [
  { label: '取消', type: 'error', handler: row => cancelPaymentOrder(row.id, { reason: '管理员取消' }) },
  { label: '重试履约', type: 'warning', handler: row => retryPaymentOrder(row.id) },
  { label: '退款', type: 'error', handler: row => refundOrder(row.id) },
  { label: '查退款', type: 'info', handler: row => queryRefund(row.id) }
];
</script>

<template>
  <div>
    <ResourceCrudPage
      title="订单中心"
      description="查看充值订单并执行取消、重试履约、退款与退款状态查询；退款类高危操作会触发 TOTP StepUp"
      :can-write="can('billing:write')"
      hide-create
      hide-edit
      hide-delete
      :columns="[
        { key: 'out_trade_no', label: '订单号' },
        { key: 'user_email', label: '用户' },
        { key: 'amount', label: '金额' },
        { key: 'currency', label: '币种' },
        { key: 'provider', label: '渠道' },
        { key: 'status', label: '状态' },
        { key: 'created_at', label: '创建时间', kind: 'date' }
      ]"
      :fields="[]"
      :list="list"
      :create="noopCreate"
      :update="noopUpdate"
      :remove="noopDelete"
      :row-actions="actions"
    />
    <StepUpDialog v-model:show="showStepUp" @verified="onStepUpVerified" @cancelled="onStepUpCancelled" />
  </div>
</template>
