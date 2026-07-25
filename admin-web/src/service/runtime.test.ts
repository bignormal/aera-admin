import { beforeEach, describe, expect, it, vi } from 'vitest';
import { apiRequest } from './http';
import {
  consumeEnrollmentCode,
  createRuntimeCommand,
  deriveRuntimeStatus,
  runtimeResourceRows,
  supportsRuntimeCommand
} from './runtime';

vi.mock('./http', () => ({ apiRequest: vi.fn() }));

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

  it('discards a one-time enrollment code after it is consumed', () => {
    const code = consumeEnrollmentCode({ enrollmentCode: 'one-time', expiresAt: 'soon', instanceId: '7' });
    expect(code.take()).toBe('one-time');
    expect(code.take()).toBeNull();
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
