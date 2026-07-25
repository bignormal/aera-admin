import { beforeEach, describe, expect, it, vi } from 'vitest';
import { apiRequest } from './http';
import {
  buildCategorySearchParams,
  createCategory,
  deleteCategory,
  listCategories,
  updateCategory
} from './categories';

vi.mock('./http', () => ({ apiRequest: vi.fn() }));

const input = {
  key: 'content',
  name: '内容',
  englishName: 'Content',
  description: '内容智能体',
  sortOrder: 12,
  active: true
};

const category = {
  id: 12,
  ...input,
  createdAt: '2026-07-16T00:00:00.000Z',
  updatedAt: '2026-07-16T00:00:00.000Z'
};

describe('category service', () => {
  beforeEach(() => vi.mocked(apiRequest).mockReset());

  it('builds Payload list query parameters', () => {
    expect(buildCategorySearchParams({ page: 2, pageSize: 20, search: '内容', sort: '-sortOrder' }).toString()).toBe(
      'page=2&limit=20&sort=-sortOrder&where%5Bname%5D%5Bcontains%5D=%E5%86%85%E5%AE%B9'
    );
  });

  it('lists categories through the Payload collection endpoint', async () => {
    const page = {
      docs: [category],
      totalDocs: 1,
      limit: 10,
      totalPages: 1,
      page: 1,
      hasNextPage: false,
      hasPrevPage: false
    };
    vi.mocked(apiRequest).mockResolvedValueOnce(page);

    await expect(listCategories({ page: 1, pageSize: 10, search: '', sort: 'sortOrder' })).resolves.toEqual(page);
    expect(apiRequest).toHaveBeenCalledWith('/expert-categories?page=1&limit=10&sort=sortOrder');
  });

  it('unwraps Payload mutation documents', async () => {
    vi.mocked(apiRequest)
      .mockResolvedValueOnce({ doc: category, message: 'created' })
      .mockResolvedValueOnce({ doc: category, message: 'updated' })
      .mockResolvedValueOnce({ doc: category, message: 'deleted' });

    await expect(createCategory(input)).resolves.toEqual(category);
    await expect(updateCategory(12, input)).resolves.toEqual(category);
    await expect(deleteCategory(12)).resolves.toEqual(category);

    expect(apiRequest).toHaveBeenNthCalledWith(1, '/expert-categories', {
      method: 'POST',
      body: input
    });
    expect(apiRequest).toHaveBeenNthCalledWith(2, '/expert-categories/12', {
      method: 'PATCH',
      body: input
    });
    expect(apiRequest).toHaveBeenNthCalledWith(3, '/expert-categories/12', {
      method: 'DELETE'
    });
  });
});
