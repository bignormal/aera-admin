<script setup lang="ts">
import { reactive, ref } from 'vue';
import type { InputHTMLAttributes } from 'vue';
import type { FormInst, FormRules } from 'naive-ui';
import { useAuthStore } from '@/store/modules/auth';

defineOptions({ name: 'PwdLogin' });

interface FormModel {
  email: string;
  password: string;
}

const authStore = useAuthStore();
const formRef = ref<FormInst | null>(null);
const model = reactive<FormModel>({ email: '', password: '' });
const emailInputProps = { 'data-testid': 'admin-email' } as InputHTMLAttributes;
const passwordInputProps = { 'data-testid': 'admin-password' } as InputHTMLAttributes;
const rules: FormRules = {
  email: [
    { required: true, message: '请输入管理员邮箱', trigger: ['input', 'blur'] },
    { type: 'email', message: '请输入有效邮箱', trigger: ['input', 'blur'] }
  ],
  password: [{ required: true, message: '请输入密码', trigger: ['input', 'blur'] }]
};

async function handleSubmit() {
  await formRef.value?.validate();
  await authStore.login(model.email, model.password);
}
</script>

<template>
  <NForm
    ref="formRef"
    :model="model"
    :rules="rules"
    size="large"
    :show-label="false"
    @keyup.enter="handleSubmit"
  >
    <NFormItem path="email">
      <NInput
        v-model:value="model.email"
        :input-props="emailInputProps"
        autocomplete="username"
        placeholder="请输入管理员邮箱"
      />
    </NFormItem>
    <NFormItem path="password">
      <NInput
        v-model:value="model.password"
        :input-props="passwordInputProps"
        autocomplete="current-password"
        type="password"
        show-password-on="click"
        placeholder="请输入密码"
      />
    </NFormItem>
    <NButton type="primary" size="large" round block :loading="authStore.loginLoading" @click="handleSubmit">
      登录
    </NButton>
  </NForm>
</template>
