import type { AdminRole } from './auth';
import { apiRequest } from './http';
import {
  createResource,
  deleteResource,
  listResources,
  updateResource,
  type PayloadPage,
  type ResourceID,
  type ResourceQuery
} from './resources';

export interface AdminRecord {
  active: boolean;
  cloudActorId?: string;
  createdAt: string;
  displayName: string;
  email: string;
  id: ResourceID;
  role: AdminRole;
  totpEnabledAt?: string | null;
  updatedAt: string;
}

export interface AdminInput {
  active: boolean;
  displayName: string;
  email?: string;
  password?: string;
  role: AdminRole;
}

export function listAdmins(query: ResourceQuery, signal?: AbortSignal): Promise<PayloadPage<AdminRecord>> {
  return listResources('admins', query, signal, false, 'email');
}

export function createAdmin(input: AdminInput): Promise<AdminRecord> {
  return createResource('admins', input);
}

export function updateAdmin(id: ResourceID, input: Partial<AdminInput>): Promise<AdminRecord> {
  const data = { ...input };
  if (!data.password) delete data.password;
  return updateResource('admins', id, data);
}

export function resetAdminPassword(id: ResourceID, password: string): Promise<AdminRecord> {
  return updateResource('admins', id, { password });
}

export async function resetAdminTotp(id: ResourceID): Promise<{ adminId: string; reset: true; updatedAt?: string }> {
  const result = await apiRequest<{ data: { adminId: string; reset: true; updatedAt?: string } }>(
    `/security/totp/reset/${encodeURIComponent(String(id))}`,
    { method: 'POST' }
  );
  return result.data;
}

export function deleteAdmin(id: ResourceID): Promise<AdminRecord> {
  return deleteResource('admins', id);
}
