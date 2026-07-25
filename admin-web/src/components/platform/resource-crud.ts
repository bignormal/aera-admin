import type { ResourceID, ResourceQuery } from '@/service/resources';

export type ResourceRow = { id: ResourceID; [key: string]: unknown };

export type ResourcePage = {
  docs: ResourceRow[];
  page: number;
  totalDocs: number;
  totalPages: number;
};

export type ResourceColumn = {
  key: string;
  kind?: 'boolean' | 'date' | 'status' | 'text';
  label: string;
  options?: Array<{ label: string; value: string }>;
  width?: number;
};

export type ResourceField = {
  key: string;
  label: string;
  options?: Array<{ label: string; value: string }>;
  placeholder?: string;
  required?: boolean;
  rows?: number;
  type?: 'json' | 'number' | 'password' | 'select' | 'switch' | 'text' | 'textarea';
  writeOnly?: boolean;
};

export type ResourceList = (query: ResourceQuery, signal?: AbortSignal) => Promise<ResourcePage>;
export type ResourceCreate = (input: Record<string, unknown>) => Promise<unknown>;
export type ResourceUpdate = (id: ResourceID, input: Record<string, unknown>) => Promise<unknown>;
export type ResourceDelete = (id: ResourceID) => Promise<unknown>;
export type ResourcePublish = (id: ResourceID) => Promise<unknown>;
export type ResourceRowAction = {
  handler: (row: ResourceRow) => Promise<unknown>;
  label: string;
  type?: 'default' | 'error' | 'info' | 'primary' | 'success' | 'warning';
};
