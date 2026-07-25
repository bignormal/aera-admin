import { apiRequest } from './http';

export interface Category {
  id: number | string;
  key: string;
  name: string;
  englishName?: string | null;
  description?: string | null;
  sortOrder: number;
  active: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface CategoryInput {
  key: string;
  name: string;
  englishName: string;
  description: string;
  sortOrder: number;
  active: boolean;
}

export interface CategoryQuery {
  page: number;
  pageSize: number;
  search: string;
  sort: 'name' | '-name' | 'sortOrder' | '-sortOrder';
}

export interface Paginated<T> {
  docs: T[];
  totalDocs: number;
  limit: number;
  totalPages: number;
  page: number;
  hasNextPage: boolean;
  hasPrevPage: boolean;
}

type MutationResponse<T> = { doc: T; message: string };

export function buildCategorySearchParams(query: CategoryQuery): URLSearchParams {
  const params = new URLSearchParams({
    page: String(query.page),
    limit: String(query.pageSize),
    sort: query.sort
  });

  if (query.search.trim()) params.set('where[name][contains]', query.search.trim());

  return params;
}

export function listCategories(query: CategoryQuery): Promise<Paginated<Category>> {
  return apiRequest(`/expert-categories?${buildCategorySearchParams(query)}`);
}

export async function createCategory(input: CategoryInput): Promise<Category> {
  const result = await apiRequest<MutationResponse<Category>>('/expert-categories', {
    method: 'POST',
    body: input
  });

  return result.doc;
}

export async function updateCategory(id: Category['id'], input: CategoryInput): Promise<Category> {
  const result = await apiRequest<MutationResponse<Category>>(`/expert-categories/${id}`, {
    method: 'PATCH',
    body: input
  });

  return result.doc;
}

export async function deleteCategory(id: Category['id']): Promise<Category> {
  const result = await apiRequest<MutationResponse<Category>>(`/expert-categories/${id}`, {
    method: 'DELETE'
  });

  return result.doc;
}
