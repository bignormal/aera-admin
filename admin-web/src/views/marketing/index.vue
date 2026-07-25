<script setup lang="ts">
import type {
  ResourceCreate,
  ResourceDelete,
  ResourceList,
  ResourceRowAction,
  ResourceUpdate
} from '@/components/platform/resource-crud';
import { useCapability } from '@/composables/use-capability';
import {
  clearAffiliateUser,
  createBillingResource,
  deleteBillingResource,
  deleteRedeemCode,
  expireRedeemCode,
  exportRedeemCodes,
  generateRedeemCodes,
  getPromoCodeUsages,
  getRedeemCodeStats,
  listBillingResources,
  updateAffiliateUser,
  updateBillingResource
} from '@/service/billing';

defineOptions({ name: 'MarketingPage' });
const { can } = useCapability();

const redeemList: ResourceList = (query, signal) => listBillingResources('redeem', query, signal);
const redeemCreate: ResourceCreate = generateRedeemCodes;
const redeemUpdate: ResourceUpdate = async () => undefined;
const redeemDelete: ResourceDelete = deleteRedeemCode;
const redeemActions: ResourceRowAction[] = [
  { label: '失效', type: 'warning', handler: row => expireRedeemCode(row.id) },
  {
    label: '统计',
    type: 'info',
    async handler() {
      const stats = await getRedeemCodeStats();
      window.$dialog?.info({ title: '兑换码统计', content: JSON.stringify(stats, null, 2), positiveText: '关闭' });
    }
  },
  {
    label: '导出',
    type: 'primary',
    async handler() {
      const exported = await exportRedeemCodes();
      window.$dialog?.info({ title: '兑换码导出结果', content: JSON.stringify(exported, null, 2), positiveText: '关闭' });
    }
  }
];

const promoList: ResourceList = (query, signal) => listBillingResources('promo', query, signal);
const promoCreate: ResourceCreate = input => createBillingResource('promo', input);
const promoUpdate: ResourceUpdate = (id, input) => updateBillingResource('promo', id, input);
const promoDelete: ResourceDelete = id => deleteBillingResource('promo', id);
const promoActions: ResourceRowAction[] = [
  {
    label: '使用记录',
    type: 'info',
    async handler(row) {
      const usages = await getPromoCodeUsages(row.id);
      window.$dialog?.info({ title: `优惠码使用记录：${String(row.code || row.id)}`, content: JSON.stringify(usages, null, 2), positiveText: '关闭' });
    }
  }
];

const affiliateList: ResourceList = (query, signal) => listBillingResources('affiliate', query, signal);
const affiliateCreate: ResourceCreate = async () => undefined;
const affiliateUpdate: ResourceUpdate = updateAffiliateUser;
const affiliateDelete: ResourceDelete = clearAffiliateUser;
const affiliateInviteList: ResourceList = (query, signal) => listBillingResources('affiliateInvites', query, signal);
const affiliateRebateList: ResourceList = (query, signal) => listBillingResources('affiliateRebates', query, signal);
const affiliateTransferList: ResourceList = (query, signal) => listBillingResources('affiliateTransfers', query, signal);
const noopCreate: ResourceCreate = async () => undefined;
const noopUpdate: ResourceUpdate = async () => undefined;
const noopDelete: ResourceDelete = async () => undefined;
</script>

<template>
  <ResourcePageShell title="营销工具" description="统一管理兑换码、优惠码和邀请返利配置">
    <NTabs type="segment" animated>
      <NTabPane name="redeem" tab="兑换码">
        <ResourceCrudPage
          title="兑换码"
          description="生成、查看、失效和删除兑换码"
          :can-write="can('billing:write')"
          hide-edit
          :columns="[
            { key: 'code', label: '兑换码' },
            { key: 'type', label: '类型' },
            { key: 'value', label: '面值' },
            { key: 'status', label: '状态' },
            { key: 'used_at', label: '使用时间', kind: 'date' },
            { key: 'created_at', label: '创建时间', kind: 'date' }
          ]"
          :fields="[
            { key: 'count', label: '生成数量', type: 'number', required: true },
            {
              key: 'type',
              label: '类型',
              type: 'select',
              options: [
                { label: '余额', value: 'balance' },
                { label: '订阅', value: 'subscription' }
              ],
              required: true
            },
            { key: 'value', label: '面值', required: true },
            { key: 'validity_days', label: '有效天数', type: 'number' },
            { key: 'notes', label: '批次备注', type: 'textarea' }
          ]"
          :defaults="{ count: 10, type: 'balance', validity_days: 30 }"
          :list="redeemList"
          :create="redeemCreate"
          :update="redeemUpdate"
          :remove="redeemDelete"
          :row-actions="redeemActions"
        />
      </NTabPane>

      <NTabPane name="promo" tab="优惠码">
        <ResourceCrudPage
          title="优惠码"
          description="维护充值优惠活动和使用限制"
          :can-write="can('billing:write')"
          :columns="[
            { key: 'code', label: '优惠码' },
            { key: 'discount_type', label: '优惠类型' },
            { key: 'discount_value', label: '优惠值' },
            { key: 'usage_count', label: '已使用' },
            { key: 'max_uses', label: '总次数' },
            { key: 'enabled', label: '启用', kind: 'boolean' }
          ]"
          :fields="[
            { key: 'code', label: '优惠码', required: true },
            { key: 'description', label: '活动说明', type: 'textarea' },
            {
              key: 'discount_type',
              label: '优惠类型',
              type: 'select',
              options: [
                { label: '固定金额', value: 'fixed' },
                { label: '百分比', value: 'percent' }
              ],
              required: true
            },
            { key: 'discount_value', label: '优惠值', required: true },
            { key: 'max_uses', label: '最大使用次数', type: 'number' },
            { key: 'enabled', label: '启用', type: 'switch' }
          ]"
          :defaults="{ discount_type: 'fixed', enabled: true }"
          :list="promoList"
          :create="promoCreate"
          :update="promoUpdate"
          :remove="promoDelete"
          :row-actions="promoActions"
        />
      </NTabPane>

      <NTabPane name="affiliate" tab="邀请返利">
        <ResourceCrudPage
          title="邀请返利"
          description="维护用户专属返利比例；不在此页面执行资金转移"
          :can-write="can('billing:write')"
          hide-create
          :columns="[
            { key: 'user_id', label: '用户 ID' },
            { key: 'email', label: '邮箱' },
            { key: 'aff_code', label: '邀请码' },
            { key: 'rebate_rate_percent', label: '返利比例 %' },
            { key: 'aff_count', label: '邀请数' }
          ]"
          :fields="[
            { key: 'rebate_rate_percent', label: '返利比例 %', type: 'number' },
            { key: 'enabled', label: '启用', type: 'switch' }
          ]"
          :list="affiliateList"
          :create="affiliateCreate"
          :update="affiliateUpdate"
          :remove="affiliateDelete"
        />
      </NTabPane>

      <NTabPane name="affiliate-invites" tab="邀请记录">
        <ResourceCrudPage
          title="邀请记录"
          description="只读查看联盟邀请关系"
          :can-write="false"
          hide-create
          hide-edit
          hide-delete
          :columns="[
            { key: 'invite_id', label: '邀请 ID' },
            { key: 'inviter_user_id', label: '邀请人' },
            { key: 'invitee_user_id', label: '被邀请人' },
            { key: 'status', label: '状态' },
            { key: 'created_at', label: '创建时间', kind: 'date' }
          ]"
          :fields="[]"
          :list="affiliateInviteList"
          :create="noopCreate"
          :update="noopUpdate"
          :remove="noopDelete"
        />
      </NTabPane>

      <NTabPane name="affiliate-rebates" tab="返利记录">
        <ResourceCrudPage
          title="返利记录"
          description="只读查看联盟返利流水"
          :can-write="false"
          hide-create
          hide-edit
          hide-delete
          :columns="[
            { key: 'rebate_id', label: '返利 ID' },
            { key: 'user_id', label: '用户 ID' },
            { key: 'amount', label: '金额' },
            { key: 'status', label: '状态' },
            { key: 'created_at', label: '创建时间', kind: 'date' }
          ]"
          :fields="[]"
          :list="affiliateRebateList"
          :create="noopCreate"
          :update="noopUpdate"
          :remove="noopDelete"
        />
      </NTabPane>

      <NTabPane name="affiliate-transfers" tab="转账记录">
        <ResourceCrudPage
          title="转账记录"
          description="只读查看联盟返利转账"
          :can-write="false"
          hide-create
          hide-edit
          hide-delete
          :columns="[
            { key: 'transfer_id', label: '转账 ID' },
            { key: 'user_id', label: '用户 ID' },
            { key: 'amount', label: '金额' },
            { key: 'status', label: '状态' },
            { key: 'created_at', label: '创建时间', kind: 'date' }
          ]"
          :fields="[]"
          :list="affiliateTransferList"
          :create="noopCreate"
          :update="noopUpdate"
          :remove="noopDelete"
        />
      </NTabPane>
    </NTabs>
  </ResourcePageShell>
</template>
