import { beforeEach, describe, expect, it, vi } from 'vitest';
import { callPlatform } from './platform';
import { listUsers, updateUserBalance } from './users';

vi.mock('./platform', () => ({ callPlatform: vi.fn() }));

const platformUser = {
  id: 7,
  email: 'member@example.com',
  username: 'member',
  role: 'user' as const,
  balance: 18.5,
  concurrency: 3,
  rpm_limit: 60,
  status: 'active' as const,
  allowed_groups: null,
  balance_notify_enabled: false,
  balance_notify_threshold: null,
  balance_notify_extra_emails: null,
  created_at: '2026-07-16T00:00:00Z',
  updated_at: '2026-07-16T00:00:00Z',
  notes: ''
};

describe('platform users service', () => {
  beforeEach(() => vi.mocked(callPlatform).mockReset());

  it('maps the real API pagination envelope to a Payload page', async () => {
    const user = platformUser;
    vi.mocked(callPlatform).mockResolvedValueOnce({
      data: {
        code: 0,
        message: 'success',
        data: { items: [user], total: 21, page: 2, page_size: 10, pages: 3 }
      },
      meta: {},
      requestId: 'request-list'
    });

    await expect(
      listUsers({ page: 2, pageSize: 10, search: 'member', sortBy: 'created_at', sortOrder: 'desc' })
    ).resolves.toEqual({
      docs: [user],
      totalDocs: 21,
      limit: 10,
      totalPages: 3,
      page: 2,
      hasNextPage: true,
      hasPrevPage: true
    });
    expect(callPlatform).toHaveBeenCalledWith('listUsers', {
      params: {
        page: 2,
        page_size: 10,
        search: 'member',
        sort_by: 'created_at',
        sort_order: 'desc'
      },
      signal: undefined
    });
  });

  it('rejects a user resource without an id', async () => {
    vi.mocked(callPlatform).mockResolvedValueOnce({
      data: {
        code: 0,
        data: { items: [{ email: 'missing-id@example.com', role: 'user', status: 'active' }] },
        message: 'success'
      },
      meta: {},
      requestId: 'request-invalid-user'
    });

    await expect(listUsers({ page: 1, pageSize: 20 })).rejects.toThrow('资源缺少合法 id');
  });

  it('rejects a user missing a required contract field', async () => {
    const { username: _username, ...missingUsername } = platformUser;
    vi.mocked(callPlatform).mockResolvedValueOnce({
      data: { code: 0, data: { items: [missingUsername] }, message: 'success' },
      meta: {},
      requestId: 'request-invalid-user-contract'
    });

    await expect(listUsers({ page: 1, pageSize: 20 })).rejects.toThrow('用户格式不合法');
  });

  it('sends an explicit operation and notes for balance changes', async () => {
    vi.mocked(callPlatform).mockResolvedValueOnce({
      data: {
        code: 0,
        message: 'success',
        data: { ...platformUser, balance: 23.5 }
      },
      meta: {},
      requestId: 'request-balance'
    });

    await updateUserBalance(7, { balance: 5, operation: 'add', notes: '人工补偿' });

    expect(callPlatform).toHaveBeenCalledWith('updateUserBalance', {
      method: 'POST',
      params: { id: 7 },
      body: { balance: 5, operation: 'add', notes: '人工补偿' }
    });
  });
});
