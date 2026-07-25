import type { Capability } from '@/constants/capabilities';
import { hasCapability } from '@/constants/capabilities';
import { useAuthStore } from '@/store/modules/auth';

export function useCapability() {
  const authStore = useAuthStore();
  const can = (capability: Capability) => hasCapability(authStore.userInfo.role, capability);

  return { can };
}
