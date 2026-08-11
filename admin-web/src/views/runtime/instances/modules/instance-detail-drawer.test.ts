import { flushPromises, shallowMount } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getDesktopCommand } from '@/service/cloud-desktop-control';
import InstanceDetailDrawer from './instance-detail-drawer.vue';

vi.mock('@/service/cloud-desktop-control', () => ({ getDesktopCommand: vi.fn() }));

describe('Cloud Desktop instance detail drawer', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.mocked(getDesktopCommand).mockResolvedValue({
      command_id: '30000000-0000-4000-8000-000000000003',
      created_at: '2026-08-11T00:00:01Z',
      created_by_admin_id: '40000000-0000-4000-8000-000000000004',
      device_id: '10000000-0000-4000-8000-000000000001',
      expires_at: '2026-08-11T00:10:01Z',
      request_id: 'desktop-health-1',
      required_capability: 'diagnostics.health.read',
      result_code: 'HEALTHY',
      result_summary: {
        code: 'HEALTHY',
        desktop_status: 'healthy',
        duration_ms: 12,
        gateway_status: 'healthy',
        runtime_status: 'healthy'
      },
      server_time: '2026-08-11T00:00:02Z',
      state: 'succeeded',
      type: 'health_check',
      updated_at: '2026-08-11T00:00:02Z'
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it('reads the one Cloud command ID and shows the bounded terminal result', async () => {
    const wrapper = shallowMount(InstanceDetailDrawer, {
      props: {
        healthCommandId: '30000000-0000-4000-8000-000000000003',
        instance: {
          arch: 'arm64',
          capabilities: ['diagnostics.health.read'],
          deviceId: '10000000-0000-4000-8000-000000000001',
          id: '10000000-0000-4000-8000-000000000001',
          instanceType: 'desktop',
          lastHeartbeatAt: '2026-08-11T00:00:00Z',
          name: 'Aera MacBook',
          os: 'darwin',
          status: 'online',
          userId: '20000000-0000-4000-8000-000000000002',
          version: '0.8.0'
        },
        show: true
      },
      global: { renderStubDefaultSlot: true }
    });
    await vi.advanceTimersByTimeAsync(1000);
    await flushPromises();

    expect(getDesktopCommand).toHaveBeenCalledWith(
      '30000000-0000-4000-8000-000000000003',
      expect.any(AbortSignal)
    );
    expect(wrapper.text()).toContain('HEALTHY');
  });
});
