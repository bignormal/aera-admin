import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useCapability } from './use-capability';
import { getCapabilityRouteRedirect } from '@/router/guard/route';

const authState = vi.hoisted(() => ({
  userInfo: { role: '' as Api.Auth.AdminRole | '' }
}));

vi.mock('@/store/modules/auth', () => ({ useAuthStore: () => authState }));
vi.mock('@/store/modules/route', () => ({ useRouteStore: () => ({}) }));

describe('Soybean platform capability guards', () => {
  beforeEach(() => {
    authState.userInfo.role = '';
  });

  it('allows publishers to publish agents but not refund orders', () => {
    authState.userInfo.role = 'publisher';
    const { can } = useCapability();

    expect(can('content:agents:publish')).toBe(true);
    expect(can('billing:order:refund')).toBe(false);
  });

  it('keeps auditors read-only', () => {
    authState.userInfo.role = 'auditor';
    const { can } = useCapability();

    expect(can('audit:read')).toBe(true);
    expect(can('users:balance:update')).toBe(false);
  });

  it('matches official Agent controls to Cloud duty roles', () => {
    const rollbackCapability = 'official-agents:rollback:write';
    const expected = {
      auditor: [true, false, false, false, false],
      operations_admin: [true, false, false, true, false],
      publisher: [true, true, false, false, false],
      super_admin: [true, false, true, false, true]
    } as const;

    for (const [role, permissions] of Object.entries(expected)) {
      authState.userInfo.role = role as Api.Auth.AdminRole;
      const { can } = useCapability();
      expect(
        [
          can('official-agents:read'),
          can('official-agents:draft:write'),
          can('official-agents:review:write'),
          can('official-agents:release:write'),
          can(rollbackCapability)
        ],
        role
      ).toEqual(permissions);
    }
  });

  it('resolves direct navigation without the route capability to 403', () => {
    expect(getCapabilityRouteRedirect('finance_admin', 'content:agents:write')).toEqual({
      name: '403'
    });
    expect(getCapabilityRouteRedirect('publisher', 'content:agents:write')).toBeNull();
  });
});
