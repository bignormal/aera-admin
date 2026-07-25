import { beforeEach, describe, expect, it, vi } from 'vitest';
import { apiRequest } from './http';
import { getCurrentAdmin, loginAdmin, logoutAdmin } from './auth';

vi.mock('./http', () => ({ apiRequest: vi.fn() }));

const admin = {
  id: 7,
  email: 'admin@agentera.local',
  displayName: '测试管理员',
  role: 'super_admin' as const
};

describe('Payload administrator service', () => {
  beforeEach(() => vi.mocked(apiRequest).mockReset());

  it('uses Payload login, me and logout endpoints', async () => {
    vi.mocked(apiRequest)
      .mockResolvedValueOnce({ user: admin })
      .mockResolvedValueOnce({ user: admin })
      .mockResolvedValueOnce({ message: 'ok' });

    await expect(loginAdmin('admin@agentera.local', 'secret')).resolves.toEqual(admin);
    await expect(getCurrentAdmin()).resolves.toEqual(admin);
    await expect(logoutAdmin()).resolves.toBeUndefined();

    expect(apiRequest).toHaveBeenNthCalledWith(1, '/admins/login', {
      method: 'POST',
      body: { email: 'admin@agentera.local', password: 'secret' }
    });
    expect(apiRequest).toHaveBeenNthCalledWith(2, '/admins/me');
    expect(apiRequest).toHaveBeenNthCalledWith(3, '/admins/logout', { method: 'POST' });
  });

  it('returns null for an anonymous me response', async () => {
    vi.mocked(apiRequest).mockResolvedValueOnce({ user: null });

    await expect(getCurrentAdmin()).resolves.toBeNull();
  });
});
