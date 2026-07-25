<script setup lang="ts">
import { ref, watch } from 'vue';
import { confirmTotp, enrollTotp, getStepUpStatus, verifyStepUp } from '@/service/security';

defineOptions({ name: 'StepUpDialog' });

const show = defineModel<boolean>('show', { required: true });

const emit = defineEmits<{
  cancelled: [];
  verified: [];
}>();

const phase = ref<'confirm' | 'enroll' | 'loading' | 'verify'>('loading');
const submitting = ref(false);
const code = ref('');
const secret = ref('');
const otpauthURL = ref('');
const errorText = ref('');

async function initialize() {
  phase.value = 'loading';
  code.value = '';
  errorText.value = '';
  try {
    const status = await getStepUpStatus();
    phase.value = status.totpEnabled ? 'verify' : 'enroll';
  } catch {
    errorText.value = '无法获取二次验证状态，请稍后重试。';
    phase.value = 'verify';
  }
}

watch(show, value => {
  if (value) void initialize();
});

async function startEnroll() {
  submitting.value = true;
  errorText.value = '';
  try {
    const enrollment = await enrollTotp();
    secret.value = enrollment.secret;
    otpauthURL.value = enrollment.otpauthURL;
    phase.value = 'confirm';
  } catch (error) {
    errorText.value = error instanceof Error ? error.message : '绑定 TOTP 失败。';
  } finally {
    submitting.value = false;
  }
}

async function submit() {
  if (!/^\d{6}$/.test(code.value)) {
    errorText.value = '请输入 6 位动态口令。';
    return;
  }
  submitting.value = true;
  errorText.value = '';
  try {
    if (phase.value === 'confirm') {
      await confirmTotp(code.value);
      code.value = '';
      phase.value = 'verify';
      window.$message?.success('TOTP 绑定成功，请再输入一次动态口令完成验证');
      return;
    }
    await verifyStepUp(code.value);
    code.value = '';
    emit('verified');
  } catch (error) {
    errorText.value = error instanceof Error ? error.message : '验证失败。';
  } finally {
    submitting.value = false;
  }
}

function cancel() {
  emit('cancelled');
}
</script>

<template>
  <NModal
    v-model:show="show"
    preset="card"
    title="高危操作二次验证"
    class="w-480px max-w-[calc(100vw-32px)]"
    :mask-closable="false"
    @close="cancel"
  >
    <NSpin :show="phase === 'loading'">
      <NAlert v-if="errorText" type="error" class="mb-12px" :show-icon="false">{{ errorText }}</NAlert>

      <template v-if="phase === 'enroll'">
        <NAlert type="warning" class="mb-12px" :show-icon="false">
          当前账号尚未绑定 TOTP 动态口令。执行高危操作前需要先完成绑定。
        </NAlert>
        <NButton type="primary" :loading="submitting" @click="startEnroll">生成绑定密钥</NButton>
      </template>

      <template v-else-if="phase === 'confirm'">
        <NAlert type="info" class="mb-12px" :show-icon="false">
          请在认证器 App（如 Google Authenticator）中添加以下密钥，然后输入生成的 6 位口令完成绑定。
        </NAlert>
        <NDescriptions :column="1" label-placement="left" bordered size="small" class="mb-12px">
          <NDescriptionsItem label="密钥">
            <NText code>{{ secret }}</NText>
          </NDescriptionsItem>
          <NDescriptionsItem label="otpauth 链接">
            <NText code class="break-all">{{ otpauthURL }}</NText>
          </NDescriptionsItem>
        </NDescriptions>
        <NInput
          v-model:value="code"
          placeholder="输入 6 位动态口令完成绑定"
          maxlength="6"
          @keyup.enter="submit"
        />
      </template>

      <template v-else-if="phase === 'verify'">
        <NAlert type="info" class="mb-12px" :show-icon="false">
          该操作属于高危操作，请输入认证器中的 6 位动态口令（验证通过后 5 分钟内有效）。
        </NAlert>
        <NInput v-model:value="code" placeholder="6 位动态口令" maxlength="6" @keyup.enter="submit" />
      </template>
    </NSpin>

    <template #footer>
      <NSpace justify="end">
        <NButton @click="cancel">取消</NButton>
        <NButton
          v-if="phase === 'confirm' || phase === 'verify'"
          type="primary"
          :loading="submitting"
          @click="submit"
        >
          {{ phase === 'confirm' ? '确认绑定' : '验证' }}
        </NButton>
      </NSpace>
    </template>
  </NModal>
</template>
