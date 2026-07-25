import { apiRequest } from './http';

export type AdminRole = 'auditor' | 'finance_admin' | 'operations_admin' | 'publisher' | 'super_admin';

export interface AdminUser {
  cloudActorId?: string;
  displayName: string;
  email: string;
  id: number | string;
  role: AdminRole;
  totpEnabledAt?: string | null;
}

type AuthResponse = { user: AdminUser };
type MeResponse = { user: AdminUser | null };

export async function loginAdmin(email: string, password: string): Promise<AdminUser> {
  const result = await apiRequest<AuthResponse>('/admins/login', {
    method: 'POST',
    body: { email, password }
  });

  return result.user;
}

export async function getCurrentAdmin(): Promise<AdminUser | null> {
  const result = await apiRequest<MeResponse>('/admins/me');

  return result.user;
}

export async function logoutAdmin(): Promise<void> {
  await apiRequest('/admins/logout', { method: 'POST' });
}
