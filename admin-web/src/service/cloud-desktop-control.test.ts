import { beforeEach, describe, expect, it, vi } from 'vitest';
import { callCloud } from './cloud';
import {
  getDesktopCommand,
  listDesktopInstances,
  mapDesktopStatus,
  requestHealthCheck
} from './cloud-desktop-control';

vi.mock('./cloud', () => ({ callCloud: vi.fn() }));

describe('cloud desktop control service', () => {
  beforeEach(() => vi.mocked(callCloud).mockReset());

  it('serializes the bounded global fleet query and forwards AbortSignal', async () => {
    const signal = new AbortController().signal;
    vi.mocked(callCloud).mockResolvedValueOnce({
      data: { items: [], server_time: '2026-08-11T00:00:00Z', total: 0 },
      meta: {},
      requestId: 'desktop-list-1'
    });

    await listDesktopInstances(
      {
        clientVersion: '0.8.0',
        effectiveStatus: 'online',
        limit: 25,
        offset: 50,
        organizationId: '10000000-0000-4000-8000-000000000001',
        platform: 'darwin',
        userId: '20000000-0000-4000-8000-000000000002'
      },
      signal
    );

    expect(callCloud).toHaveBeenCalledWith('listDesktopControlInstances', {
      params: {
        client_version: '0.8.0',
        effective_status: 'online',
        limit: 25,
        offset: 50,
        organization_id: '10000000-0000-4000-8000-000000000001',
        platform: 'darwin',
        user_id: '20000000-0000-4000-8000-000000000002'
      },
      signal
    });
  });

  it('renders the Cloud-computed status and rejects an unknown status', () => {
    expect(
      mapDesktopStatus({
        effective_status: 'offline',
        last_heartbeat_at: '2026-08-11T00:00:00Z',
        server_time: '2026-08-11T00:03:00Z'
      })
    ).toBe('offline');
    expect(() => mapDesktopStatus({ effective_status: 'client-online' })).toThrow(/effective_status/i);
  });

  it('creates only the fixed health check with a stable idempotency key', async () => {
    const command = {
      command_id: '30000000-0000-4000-8000-000000000003',
      created_at: '2026-08-11T00:00:00Z',
      created_by_admin_id: '40000000-0000-4000-8000-000000000004',
      device_id: '50000000-0000-4000-8000-000000000005',
      expires_at: '2026-08-11T00:10:00Z',
      request_id: 'desktop-command-1',
      required_capability: 'diagnostics.health.read' as const,
      server_time: '2026-08-11T00:00:00Z',
      state: 'queued' as const,
      type: 'health_check' as const,
      updated_at: '2026-08-11T00:00:00Z'
    };
    vi.mocked(callCloud).mockResolvedValueOnce({ data: command, meta: {}, requestId: 'desktop-command-1' });

    await expect(
      requestHealthCheck(command.device_id, 'desktop-health-check-1')
    ).resolves.toEqual(command);
    expect(callCloud).toHaveBeenCalledWith('createDesktopHealthCheck', {
      body: {},
      idempotencyKey: 'desktop-health-check-1',
      method: 'POST',
      params: { device_id: command.device_id }
    });
  });

  it('preserves Cloud failures while reading one command', async () => {
    const cloudFailure = new Error('cloud unavailable');
    vi.mocked(callCloud).mockRejectedValueOnce(cloudFailure);

    await expect(
      getDesktopCommand('30000000-0000-4000-8000-000000000003')
    ).rejects.toBe(cloudFailure);
  });
});
