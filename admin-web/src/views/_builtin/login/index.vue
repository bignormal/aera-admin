<script setup lang="ts">
import { computed } from 'vue';
import { getPaletteColorByNumber, mixColor } from '@sa/color';
import { useThemeStore } from '@/store/modules/theme';
import PwdLogin from './modules/pwd-login.vue';

defineOptions({ name: 'LoginPage' });

const themeStore = useThemeStore();
const bgThemeColor = computed(() =>
  themeStore.darkMode ? getPaletteColorByNumber(themeStore.themeColor, 600) : themeStore.themeColor
);
const bgColor = computed(() => mixColor('#ffffff', themeStore.themeColor, themeStore.darkMode ? 0.5 : 0.2));
</script>

<template>
  <div class="relative size-full flex-center overflow-hidden" :style="{ backgroundColor: bgColor }">
    <WaveBg :theme-color="bgThemeColor" />
    <NCard data-testid="agentera-login-form" :bordered="false" class="relative z-4 w-auto rd-12px">
      <div class="w-400px lt-sm:w-300px">
        <header class="flex-y-center gap-12px" data-testid="agentera-brand">
          <SystemLogo class="size-56px lt-sm:size-44px" />
          <div>
            <h1 class="m-0 text-26px text-primary font-600 lt-sm:text-22px">Aera 管理系统</h1>
            <p class="mb-0 mt-4px text-13px text-gray-500">平台管理员正式后台</p>
          </div>
        </header>
        <main class="pt-28px">
          <h2 class="m-0 text-18px text-primary font-500">管理员登录</h2>
          <div class="pt-20px"><PwdLogin /></div>
        </main>
      </div>
    </NCard>
  </div>
</template>
