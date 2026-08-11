import { flushPromises, shallowMount } from '@vue/test-utils';
import { NButton, NDataTable } from 'naive-ui';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useCapability } from '@/composables/use-capability';
import {
  getDesktopCommand,
  listUserDesktopInstances,
  requestHealthCheck
} from '@/service/cloud-desktop-control';
import CloudUserDesktopPanel from './cloud-user-desktop-panel.vue';

vi.mock('@/composables/use-capability', () => ({ useCapability: vi.fn() }));
vi.mock('@/service/cloud-desktop-control', () => ({
  desktopHealthCodeLabels: {
    HEALTHY: '健康',
    DESKTOP_UNHEALTHY: '桌面配置异常',
    RUNTIME_UNAVAILABLE: 'Runtime 不可用',
    GATEWAY_UNAVAILABLE: 'Gateway 不可用',
    HEALTH_CHECK_TIMEOUT: '健康检查超时',
    CLIENT_INTERRUPTED: '客户端执行中断'
  },
  getDesktopCommand: vi.fn(),
  listUserDesktopInstances: vi.fn(),
  requestHealthCheck: vi.fn()
}));

const instance = {
  arch: 'arm64' as const,
  capabilities: ['diagnostics.health.read'] as const,
  client_version: '0.8.0',
  created_at: '2026-08-11T00:00:00Z',
  device_id: '10000000-0000-4000-8000-000000000001',
  display_name: 'Aera MacBook',
  effective_status: 'online' as const,
  health_status: 'unknown' as const,
  last_heartbeat_at: '2026-08-11T00:00:00Z',
  platform: 'darwin' as const,
  updated_at: '2026-08-11T00:00:00Z',
  user_id: '20000000-0000-4000-8000-000000000002'
};

function command(state: 'queued' | 'running' | 'succeeded') {
  return {
    command_id: '30000000-0000-4000-8000-000000000003',
    created_at: '2026-08-11T00:00:01Z',
    created_by_admin_id: '40000000-0000-4000-8000-000000000004',
    device_id: instance.device_id,
    expires_at: '2026-08-11T00:10:01Z',
    request_id: 'desktop-health-1',
    required_capability: 'diagnostics.health.read' as const,
    result_code: state === 'succeeded' ? ('HEALTHY' as const) : undefined,
    server_time: '2026-08-11T00:00:01Z',
    state,
    type: 'health_check' as const,
    updated_at: '2026-08-11T00:00:01Z'
  };
}

function mountPanel(canCommand: boolean) {
  vi.mocked(useCapability).mockReturnValue({
    can: vi.fn(capability => capability === 'runtime:read' || canCommand)
  });
  return shallowMount(CloudUserDesktopPanel, {
    props: { userId: instance.user_id },
    global: {
      renderStubDefaultSlot: true,
      stubs: {
        NCard: { template: '<section><slot /></section>' },
        ResourceState: { template: '<div><slot /></div>' }
      }
    }
  });
}

describe('cloud user Desktop panel', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.mocked(listUserDesktopInstances).mockResolvedValue({
      items: [instance],
      server_time: '2026-08-11T00:00:00Z',
      total: 1
    });
    vi.mocked(requestHealthCheck).mockResolvedValue(command('queued'));
    vi.mocked(getDesktopCommand)
      .mockResolvedValueOnce(command('running'))
      .mockResolvedValueOnce(command('succeeded'));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it('shows Cloud online data and polls only the created health command', async () => {
    const wrapper = mountPanel(true);
    await flushPromises();

    const table = wrapper.findComponent(NDataTable);
    expect(table.props('data')).toEqual([instance]);
    const columns = table.props('columns') as Array<{
      key: string;
      render?: (row: typeof instance) => any;
    }>;
    const status = columns.find(column => column.key === 'effective_status')?.render?.(instance);
    expect(status.props['data-testid']).toBe('desktop-online-status');
    expect(status.children.default()).toBe('在线');
    const action = columns.find(column => column.key === 'actions')?.render?.(instance);
    expect(action.type).toBe(NButton);
    expect(action.children.default()).toBe('健康检查');

    await action.props.onClick();
    await flushPromises();
    let health = columns.find(column => column.key === 'health')?.render?.(instance);
    expect(health.children).toContain('已排队');

    await vi.advanceTimersByTimeAsync(1000);
    await flushPromises();
    health = columns.find(column => column.key === 'health')?.render?.(instance);
    expect(health.children).toContain('执行中');

    await vi.advanceTimersByTimeAsync(1000);
    await flushPromises();
    health = columns.find(column => column.key === 'health')?.render?.(instance);
    expect(health.props['data-testid']).toBe('desktop-health-result');
    expect(health.children).toContain('HEALTHY');
    expect(getDesktopCommand).toHaveBeenCalledTimes(2);
    expect(getDesktopCommand).toHaveBeenCalledWith(
      '30000000-0000-4000-8000-000000000003',
      expect.any(AbortSignal)
    );
    expect(wrapper.text()).not.toMatch(/注册码|registration|enrollment/i);
  });

  it('hides the command action without runtime command permission', async () => {
    const wrapper = mountPanel(false);
    await flushPromises();
    const table = wrapper.findComponent(NDataTable);
    const columns = table.props('columns') as Array<{
      key: string;
      render?: (row: typeof instance) => any;
    }>;

    expect(columns.find(column => column.key === 'actions')?.render?.(instance)).toBe('—');
  });
});
