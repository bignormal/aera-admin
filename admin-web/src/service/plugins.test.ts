import { describe, expect, it, vi } from 'vitest';
import { apiRequest } from './http';
import { createPlugin, listPlugins } from './plugins';

vi.mock('./http', () => ({ apiRequest: vi.fn() }));

describe('plugin service', () => {
  it('lists and creates versioned plugin records', async () => {
    vi.mocked(apiRequest)
      .mockResolvedValueOnce({ docs: [], totalDocs: 0 })
      .mockResolvedValueOnce({ doc: { id: 4 } });
    await listPlugins({ page: 1, limit: 10, search: '', sort: '-updatedAt' });
    await createPlugin({ name: '网页搜索' } as never);
    expect(apiRequest).toHaveBeenNthCalledWith(1, '/plugin-catalog?page=1&limit=10&sort=-updatedAt&draft=true', {
      signal: undefined
    });
    expect(apiRequest).toHaveBeenNthCalledWith(2, '/plugin-catalog?draft=true', {
      method: 'POST',
      body: { name: '网页搜索' }
    });
  });

  it('keeps the Desktop delivery status server-derived and read-only', async () => {
    vi.mocked(apiRequest).mockResolvedValueOnce({ docs: [{ id: 1, deliveryStatus: 'registered' }], totalDocs: 1 });
    await expect(listPlugins({ page: 1, limit: 10, search: '', sort: '-updatedAt' })).resolves.toMatchObject({
      docs: [{ deliveryStatus: 'registered' }]
    });
  });
});
