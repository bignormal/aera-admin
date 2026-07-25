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

  it('resolves direct navigation without the route capability to 403', () => {
    expect(getCapabilityRouteRedirect('finance_admin', 'content:agents:write')).toEqual({ name: '403' });
    expect(getCapabilityRouteRedirect('publisher', 'content:agents:write')).toBeNull();
  });
});
