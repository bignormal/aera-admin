import { beforeEach, describe, expect, it, vi } from 'vitest';
import { apiRequest } from './http';
import { listDesktopInstances } from './cloud-desktop-control';
import {
  createRuntimeCommand,
  deriveRuntimeStatus,
  listRuntimeInstances,
  runtimeResourceRows,
  supportsRuntimeCommand
} from './runtime';

vi.mock('./http', () => ({ apiRequest: vi.fn() }));
vi.mock('./cloud-desktop-control', () => ({ listDesktopInstances: vi.fn() }));

describe('runtime administration service', () => {
  beforeEach(() => vi.mocked(apiRequest).mockReset());

  it('derives offline state from server timestamps', () => {
    const now = Date.parse('2026-07-16T00:05:00Z');
    expect(deriveRuntimeStatus({ lastHeartbeatAt: '2026-07-16T00:04:00Z', status: 'online' }, now)).toBe('online');
    expect(deriveRuntimeStatus({ lastHeartbeatAt: '2026-07-16T00:00:00Z', status: 'online' }, now)).toBe('offline');
    expect(deriveRuntimeStatus({ status: 'disabled' }, now)).toBe('disabled');
  });

  it('allows only commands explicitly advertised by the instance', async () => {
    const instance = { capabilities: ['diagnostics.health.read'], id: 7, status: 'online' };
    expect(supportsRuntimeCommand(instance, 'health_check')).toBe(true);
    expect(supportsRuntimeCommand(instance, 'runtime_upgrade')).toBe(false);
    await expect(createRuntimeCommand(instance, 'runtime_upgrade')).rejects.toThrow('不支持');
    expect(apiRequest).not.toHaveBeenCalled();
  });

  it('reads global Runtime instances from the Cloud Desktop control plane', async () => {
    vi.mocked(listDesktopInstances).mockResolvedValueOnce({
      items: [
        {
          arch: 'arm64',
          capabilities: ['diagnostics.health.read'],
          client_version: '0.8.0',
          created_at: '2026-08-11T00:00:00Z',
          device_id: '10000000-0000-4000-8000-000000000001',
          display_name: 'Aera MacBook',
          effective_status: 'online',
          health_status: 'unknown',
          last_heartbeat_at: '2026-08-11T00:00:00Z',
          platform: 'darwin',
          updated_at: '2026-08-11T00:00:00Z',
          user_id: '20000000-0000-4000-8000-000000000002'
        }
      ],
      server_time: '2026-08-11T00:00:00Z',
      total: 1
    });

    const signal = new AbortController().signal;
    const result = await listRuntimeInstances(
      { limit: 10, page: 1, search: '', sort: '-lastHeartbeatAt' },
      signal
    );

    expect(listDesktopInstances).toHaveBeenCalledWith(
      { limit: 10, offset: 0 },
      signal
    );
    expect(result).toMatchObject({
      docs: [
        expect.objectContaining({
          id: '10000000-0000-4000-8000-000000000001',
          instanceType: 'desktop',
          name: 'Aera MacBook',
          status: 'online',
          userId: '20000000-0000-4000-8000-000000000002'
        })
      ],
      totalDocs: 1
    });
    expect(apiRequest).not.toHaveBeenCalled();
  });

  it('does not expose the removed enrollment entry point', async () => {
    const runtime = await import('./runtime');
    expect((runtime as Record<string, unknown>).createRuntimeEnrollment).toBeUndefined();
  });

  it('keeps runtime resource rows bounded and content-free', () => {
    const rows = runtimeResourceRows(
      'tasks',
      Array.from({ length: 120 }, (_, index) => ({
        deviceSecret: 'secret',
        id: String(index),
        prompt: 'private prompt',
        source: 'runtime',
        status: 'done'
      }))
    );
    expect(rows).toHaveLength(100);
    expect(JSON.stringify(rows)).not.toContain('private prompt');
    expect(JSON.stringify(rows)).not.toContain('secret');
  });
});
