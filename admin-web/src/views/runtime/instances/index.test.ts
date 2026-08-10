import { flushPromises, shallowMount } from '@vue/test-utils';
import { NButton, NDataTable } from 'naive-ui';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useCapability } from '@/composables/use-capability';
import { requestHealthCheck } from '@/service/cloud-desktop-control';
import { listRuntimeInstances } from '@/service/runtime';
import RuntimeInstancesPage from './index.vue';

vi.mock('@/composables/use-capability', () => ({ useCapability: vi.fn() }));
vi.mock('@/service/cloud-desktop-control', () => ({ requestHealthCheck: vi.fn() }));
vi.mock('@/service/runtime', () => ({ listRuntimeInstances: vi.fn() }));

const row = {
  arch: 'arm64',
  capabilities: ['diagnostics.health.read'],
  deviceId: '10000000-0000-4000-8000-000000000001',
  effectiveStatus: 'online',
  id: '10000000-0000-4000-8000-000000000001',
  instanceType: 'desktop',
  lastHeartbeatAt: '2026-08-11T00:00:00Z',
  name: 'Aera MacBook',
  os: 'darwin',
  status: 'online',
  userId: '20000000-0000-4000-8000-000000000002',
  version: '0.8.0'
};

describe('Cloud-backed runtime instances page', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(useCapability).mockReturnValue({ can: vi.fn(() => true) });
    vi.mocked(listRuntimeInstances).mockResolvedValue({
      docs: [row],
      hasNextPage: false,
      hasPrevPage: false,
      limit: 10,
      page: 1,
      totalDocs: 1,
      totalPages: 1
    });
    vi.mocked(requestHealthCheck).mockResolvedValue({
      command_id: '30000000-0000-4000-8000-000000000003'
    } as never);
  });

  it('lists Cloud instances, exposes device/user IDs, and removes registration controls', async () => {
    const wrapper = shallowMount(RuntimeInstancesPage, {
      global: {
        renderStubDefaultSlot: true,
        stubs: {
          InstanceDetailDrawer: { template: '<div />' },
          ResourcePageShell: { template: '<div><slot name="filters" /><slot /></div>' },
          ResourceState: { template: '<div><slot /></div>' }
        }
      }
    });
    await flushPromises();

    const table = wrapper.findComponent(NDataTable);
    expect(table.props('data')).toEqual([row]);
    expect(wrapper.text()).not.toMatch(/注册码|enrollment|registration/i);

    const columns = table.props('columns') as Array<{ key: string; render?: (value: typeof row) => any }>;
    const actions = columns.find(column => column.key === 'actions')?.render?.(row);
    const buttons = actions.children.default();
    expect(buttons.map((button: any) => button.type)).toContain(NButton);
    const healthButton = buttons.find((button: any) => button.children.default() === '健康检查');
    await healthButton.props.onClick();
    await flushPromises();
    expect(requestHealthCheck).toHaveBeenCalledWith(row.deviceId);
  });
});
