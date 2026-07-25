import { computed, reactive, ref } from 'vue';
import { defineStore } from 'pinia';
import { SetupStoreId } from '@/enum';
import { useRouterPush } from '@/hooks/common/router';
import { getCurrentAdmin, loginAdmin, logoutAdmin } from '@/service/auth';
import type { AdminUser } from '@/service/auth';
import { ApiError, setUnauthorizedHandler } from '@/service/http';
import { useRouteStore } from '@/store/modules/route';
import { useTabStore } from '@/store/modules/tab';

export const useAuthStore = defineStore(SetupStoreId.Auth, () => {
  const routeStore = useRouteStore();
  const tabStore = useTabStore();
  const { toLogin, redirectFromLogin } = useRouterPush(false);

  const initialized = ref(false);
  const loginLoading = ref(false);
  const userInfo = reactive<Api.Auth.UserInfo>({
    userId: '',
    userName: '',
    email: '',
    role: '',
    roles: [],
    buttons: []
  });

  const isLogin = computed(() => Boolean(userInfo.userId));
  const isStaticSuper = computed(() => userInfo.role === 'super_admin');

  function applyUser(user: AdminUser | null) {
    Object.assign(
      userInfo,
      user
        ? {
            userId: String(user.id),
            userName: user.displayName,
            email: user.email,
            role: user.role,
            roles: [user.role],
            buttons: []
          }
        : { userId: '', userName: '', email: '', role: '', roles: [], buttons: [] }
    );
  }

  async function clearSession(redirect = true) {
    applyUser(null);
    initialized.value = true;
    await tabStore.clearTabs();
    await routeStore.resetStore();

    if (redirect) await toLogin();
  }

  async function resetStore() {
    await clearSession(true);
  }

  async function login(email: string, password: string, redirect = true) {
    loginLoading.value = true;

    try {
      const user = await loginAdmin(email, password);
      applyUser(user);
      initialized.value = true;
      await routeStore.initAuthRoute();
      await redirectFromLogin(redirect);
      window.$notification?.success({
        title: '登录成功',
        content: `欢迎回来，${user.displayName}`,
        duration: 3000
      });
    } catch (error) {
      if (error instanceof ApiError) window.$message?.error(error.message);
    } finally {
      loginLoading.value = false;
    }
  }

  async function initUserInfo() {
    if (initialized.value) return;

    try {
      applyUser(await getCurrentAdmin());
    } catch (error) {
      if (error instanceof ApiError && error.status !== 401) {
        window.$message?.error(error.message);
      }
    } finally {
      initialized.value = true;
    }
  }

  async function logout() {
    try {
      await logoutAdmin();
      await clearSession(true);
    } catch (error) {
      if (error instanceof ApiError) window.$message?.error(error.message);
    }
  }

  setUnauthorizedHandler(() => {
    void resetStore();
  });

  return {
    initialized,
    isLogin,
    isStaticSuper,
    loginLoading,
    userInfo,
    initUserInfo,
    login,
    logout,
    resetStore
  };
});
