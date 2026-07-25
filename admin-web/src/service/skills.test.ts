import { describe, expect, it, vi } from 'vitest';
import { apiRequest } from './http';
import { deleteSkill, listSkills } from './skills';

vi.mock('./http', () => ({ apiRequest: vi.fn() }));

describe('skill service', () => {
  it('uses the skill catalog collection', async () => {
    vi.mocked(apiRequest)
      .mockResolvedValueOnce({ docs: [], totalDocs: 0 })
      .mockResolvedValueOnce({ doc: { id: 3 } });
    await listSkills({ page: 1, limit: 10, search: '', sort: 'name' });
    await deleteSkill(3);
    expect(apiRequest).toHaveBeenNthCalledWith(1, '/skill-catalog?page=1&limit=10&sort=name&draft=true', {
      signal: undefined
    });
    expect(apiRequest).toHaveBeenNthCalledWith(2, '/skill-catalog/3', { method: 'DELETE' });
  });
});
