<script setup lang="ts">
import type { ResourceCreate, ResourceDelete, ResourceList, ResourceRowAction, ResourceUpdate } from '@/components/platform/resource-crud';
import { useCapability } from '@/composables/use-capability';
import {
  createAdmin,
  deleteAdmin,
  listAdmins,
  resetAdminPassword,
  resetAdminTotp,
  updateAdmin,
  type AdminInput
} from '@/service/admins';

defineOptions({ name: 'AdminsPage' });

const roleOptions = [
  { label: '超级管理员', value: 'super_admin' },
  { label: '运营管理员', value: 'operations_admin' },
  { label: '内容发布员', value: 'publisher' },
  { label: '财务管理员', value: 'finance_admin' },
  { label: '审计观察员', value: 'auditor' }
];
const { can } = useCapability();
const list: ResourceList = async (query, signal) => {
  const result = await listAdmins(query, signal);
  return {
    ...result,
    docs: result.docs.map(item => ({
      ...item,
      totpStatus: item.totpEnabledAt ? 'enabled' : 'disabled'
    }))
  };
};
const create: ResourceCreate = input => createAdmin(input as unknown as AdminInput);
const update: ResourceUpdate = (id, input) => updateAdmin(id, input as Partial<AdminInput>);
const remove: ResourceDelete = deleteAdmin;

const rowActions: ResourceRowAction[] = [
  {
    label: '重置密码',
    type: 'warning',
    async handler(row) {
      const password = window.prompt(`请输入“${String(row.email || row.id)}”的新密码（至少 8 位）`);
      if (!password) return;
      if (password.length < 8) {
        window.$message?.warning('新密码至少 8 位。');
        return;
      }
      await resetAdminPassword(row.id, password);
    }
  },
  {
    label: '重置 TOTP',
    type: 'error',
    async handler(row) {
      await new Promise<void>((resolve, reject) => {
        window.$dialog?.warning({
          title: '重置 TOTP',
          content: `确认清除“${String(row.email || row.id)}”的 TOTP 绑定与 StepUp 状态吗？`,
          positiveText: '确认重置',
          negativeText: '取消',
          onPositiveClick: async () => {
            try {
              await resetAdminTotp(row.id);
              resolve();
            } catch (error) {
              reject(error);
            }
          },
          onNegativeClick: () => reject(new Error('已取消'))
        });
      });
    }
  }
];
</script>

<template>
  <ResourceCrudPage
    title="平台管理员"
    description="管理固定五角色账号；密码只写入 Payload，不会在列表或编辑器中回显"
    :can-write="can('admins:write')"
    :columns="[
      { key: 'displayName', label: '姓名' },
      { key: 'email', label: '邮箱' },
      { key: 'role', label: '角色', options: roleOptions },
      { key: 'active', label: '状态', kind: 'boolean' },
      {
        key: 'totpStatus',
        label: 'TOTP',
        options: [
          { label: '已绑定', value: 'enabled' },
          { label: '未绑定', value: 'disabled' }
        ]
      },
      { key: 'cloudActorId', label: '云 Actor' },
      { key: 'updatedAt', label: '更新时间', kind: 'date' }
    ]"
    :fields="[
      { key: 'displayName', label: '姓名', required: true },
      { key: 'email', label: '邮箱', required: true },
      { key: 'role', label: '角色', type: 'select', options: roleOptions, required: true },
      { key: 'active', label: '启用', type: 'switch' },
      { key: 'password', label: '新密码', type: 'password', writeOnly: true, placeholder: '编辑时留空表示不修改' }
    ]"
    :defaults="{ role: 'publisher', active: true }"
    :list="list"
    :create="create"
    :update="update"
    :remove="remove"
    :row-actions="rowActions"
  />
</template>
