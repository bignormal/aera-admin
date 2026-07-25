import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getCurrentAdmin, loginAdmin, logoutAdmin } from '@/service/auth';
import { ApiError } from '@/service/http';
import { useAuthStore } from './index';

const mocks = vi.hoisted(() => ({
  toLogin: vi.fn(),
  redirectFromLogin: vi.fn(),
  resetRoutes: vi.fn(),
  initAuthRoute: vi.fn(),
  clearTabs: vi.fn(),
  setUnauthorizedHandler: vi.fn()
}));

vi.mock('@/service/auth', () => ({
  getCurrentAdmin: vi.fn(),
  loginAdmin: vi.fn(),
  logoutAdmin: vi.fn()
}));

vi.mock('@/service/http', async importOriginal => ({
  ...(await importOriginal<typeof import('@/service/http')>()),
  setUnauthorizedHandler: mocks.setUnauthorizedHandler
}));

vi.mock('@/hooks/common/router', () => ({
  useRouterPush: () => ({
    toLogin: mocks.toLogin,
    redirectFromLogin: mocks.redirectFromLogin
  })
}));

vi.mock('@/store/modules/route', () => ({
  useRouteStore: () => ({
    resetStore: mocks.resetRoutes,
    initAuthRoute: mocks.initAuthRoute
  })
}));

vi.mock('@/store/modules/tab', () => ({
  useTabStore: () => ({ clearTabs: mocks.clearTabs })
}));

const admin = {
  id: 7,
  email: 'admin@agentera.local',
  displayName: '测试管理员',
  role: 'super_admin' as const
};

describe('Payload cookie auth store', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    localStorage.clear();
    vi.clearAllMocks();
  });

  it('logs in without storing a token', async () => {
    vi.mocked(loginAdmin).mockResolvedValue(admin);
    const store = useAuthStore();

    await store.login('admin@agentera.local', 'secret', false);

    expect(store.userInfo).toMatchObject({
      userId: '7',
      userName: '测试管理员',
      email: 'admin@agentera.local',
      role: 'super_admin',
      roles: ['super_admin']
    });
    expect(localStorage.getItem('token')).toBeNull();
    expect(mocks.initAuthRoute).toHaveBeenCalledOnce();
    expect(mocks.redirectFromLogin).toHaveBeenCalledWith(false);
  });

  it('restores the current user only once', async () => {
    vi.mocked(getCurrentAdmin).mockResolvedValue(admin);
    const store = useAuthStore();

    await store.initUserInfo();
    await store.initUserInfo();

    expect(getCurrentAdmin).toHaveBeenCalledOnce();
    expect(store.isLogin).toBe(true);
  });

  it('logs out through Payload then clears local state', async () => {
    vi.mocked(getCurrentAdmin).mockResolvedValue(admin);
    vi.mocked(logoutAdmin).mockResolvedValue(undefined);
    const store = useAuthStore();
    await store.initUserInfo();

    await store.logout();

    expect(logoutAdmin).toHaveBeenCalledOnce();
    expect(store.isLogin).toBe(false);
    expect(mocks.toLogin).toHaveBeenCalledOnce();
  });

  it('does not convert a network failure into remote logout', async () => {
    vi.mocked(getCurrentAdmin).mockRejectedValue(new ApiError(0, '网络连接失败，请稍后重试'));
    const store = useAuthStore();

    await store.initUserInfo();

    expect(logoutAdmin).not.toHaveBeenCalled();
    expect(mocks.toLogin).not.toHaveBeenCalled();
  });
});
