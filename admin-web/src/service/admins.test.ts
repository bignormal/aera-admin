import { describe, expect, it, vi } from 'vitest';
import { apiRequest } from './http';
import { listAdmins, resetAdminPassword, updateAdmin } from './admins';

vi.mock('./http', () => ({ apiRequest: vi.fn() }));

describe('administrator service', () => {
  it('lists administrators and never sends an empty password', async () => {
    vi.mocked(apiRequest).mockResolvedValue({ docs: [], doc: { id: 7 } });
    await listAdmins({ page: 1, limit: 10, search: 'admin@agentera.local', sort: 'email' });
    await updateAdmin(7, { displayName: '运营员', password: '', role: 'operations_admin' });
    expect(apiRequest).toHaveBeenNthCalledWith(
      1,
      '/admins?page=1&limit=10&sort=email&where%5Bemail%5D%5Bcontains%5D=admin%40agentera.local',
      { signal: undefined }
    );
    expect(apiRequest).toHaveBeenNthCalledWith(2, '/admins/7', {
      method: 'PATCH',
      body: { displayName: '运营员', role: 'operations_admin' }
    });
  });

  it('resets a password through the admin document without echoing it elsewhere', async () => {
    vi.mocked(apiRequest).mockResolvedValueOnce({ doc: { id: 7 } });
    await resetAdminPassword(7, 'new-password');
    expect(apiRequest).toHaveBeenCalledWith('/admins/7', {
      method: 'PATCH',
      body: { password: 'new-password' }
    });
  });
});
