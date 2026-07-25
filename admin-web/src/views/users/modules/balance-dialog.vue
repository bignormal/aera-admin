<script setup lang="ts">
import { reactive, ref, watch } from 'vue';
import { PlatformServiceError } from '@/service/platform';
import { updateUserBalance, type BalanceUpdate, type PlatformUser } from '@/service/users';

defineOptions({ name: 'UserBalanceDialog' });

const props = defineProps<{
  show: boolean;
  user?: PlatformUser;
}>();
const emit = defineEmits<{
  saved: [];
  'update:show': [value: boolean];
}>();

const saving = ref(false);
const form = reactive<BalanceUpdate>({ balance: 0, operation: 'add', notes: '' });

watch(
  () => props.show,
  show => {
    if (show) Object.assign(form, { balance: 0, operation: 'add', notes: '' });
  }
);

async function save() {
  if (!props.user || form.balance <= 0) {
    window.$message?.warning('请输入大于 0 的调整金额');
    return;
  }
  if (!form.notes.trim()) {
    window.$message?.warning('请填写调整原因，便于审计追踪');
    return;
  }
  saving.value = true;
  try {
    await updateUserBalance(props.user.id, { ...form, notes: form.notes.trim() });
    window.$message?.success('余额调整成功');
    emit('update:show', false);
    emit('saved');
  } catch (error) {
    if (error instanceof PlatformServiceError) {
      const suffix = error.requestId ? `（请求 ID：${error.requestId}）` : '';
      window.$message?.error(`${error.message}${suffix}`);
    }
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <NModal
    :show="show"
    preset="card"
    title="调整用户余额"
    class="w-520px max-w-[calc(100vw-32px)]"
    @update:show="value => emit('update:show', value)"
  >
    <NAlert type="info" :bordered="false" class="mb-16px">
      {{ user?.email }} · 当前余额 {{ Number(user?.balance || 0).toFixed(4) }}
    </NAlert>
    <NForm :model="form" label-placement="top">
      <NFormItem label="调整方式" required>
        <NRadioGroup v-model:value="form.operation">
          <NRadioButton value="add">增加</NRadioButton>
          <NRadioButton value="subtract">扣减</NRadioButton>
          <NRadioButton value="set">设为</NRadioButton>
        </NRadioGroup>
      </NFormItem>
      <NFormItem label="金额" required>
        <NInputNumber v-model:value="form.balance" :min="0.0001" :precision="4" class="w-full" />
      </NFormItem>
      <NFormItem label="调整原因" required>
        <NInput v-model:value="form.notes" type="textarea" :rows="3" placeholder="将写入平台审计日志" />
      </NFormItem>
    </NForm>
    <template #footer>
      <NSpace justify="end">
        <NButton @click="emit('update:show', false)">取消</NButton>
        <NButton type="primary" :loading="saving" @click="save">确认调整</NButton>
      </NSpace>
    </template>
  </NModal>
</template>
