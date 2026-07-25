import { beforeEach, describe, expect, it, vi } from 'vitest';
import { callCloud } from './cloud';
import { getCloudDeviceStats, getCloudOperation } from './cloud-users';
import { listOfficialAgentAuditEvents } from './cloud-official-agents';

vi.mock('./cloud', () => ({ callCloud: vi.fn() }));

describe('cloud P7 service additions', () => {
  beforeEach(() => vi.mocked(callCloud).mockReset());

  it('loads cloud device distribution stats through the registered operation', async () => {
    const stats = {
      platforms: [{ count: 12, platform: 'darwin' }],
      versions: [{ client_version: '1.2.3', count: 7 }]
    };
    vi.mocked(callCloud).mockResolvedValueOnce({ data: stats, meta: {}, requestId: 'devices-stats' });

    await expect(getCloudDeviceStats()).resolves.toEqual(stats);
    expect(callCloud).toHaveBeenCalledWith('cloudDeviceStats', { signal: undefined });
  });

  it('queries a cloud command operation by operation_id', async () => {
    const operation = { operation_id: 'op-123', status: 'succeeded', updated_at: '2026-07-25T00:00:00Z' };
    vi.mocked(callCloud).mockResolvedValueOnce({ data: operation, meta: {}, requestId: 'operation' });

    await expect(getCloudOperation('op-123')).resolves.toEqual(operation);
    expect(callCloud).toHaveBeenCalledWith('getCloudOperation', { params: { operation_id: 'op-123' }, signal: undefined });
  });

  it('loads official agent audit events with cursor pagination', async () => {
    const page = {
      items: [
        {
          action: 'draft.submitted',
          actor_admin_id: 'admin-1',
          audit_event_id: 'evt-1',
          created_at: '2026-07-25T00:00:00Z',
          definition_id: 'def-1',
          operation_id: 'op-1'
        }
      ],
      next_cursor: 'next-1'
    };
    vi.mocked(callCloud).mockResolvedValueOnce({ data: page, meta: {}, requestId: 'audit' });

    await expect(listOfficialAgentAuditEvents({ cursor: 'cur-1', limit: 25 })).resolves.toEqual(page);
    expect(callCloud).toHaveBeenCalledWith('listOfficialAgentAuditEvents', {
      params: { cursor: 'cur-1', limit: 25 },
      signal: undefined
    });
  });
});
