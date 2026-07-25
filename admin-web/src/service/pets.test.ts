import { describe, expect, it, vi } from 'vitest';
import { apiRequest } from './http';
import { listPets, updatePet } from './pets';

vi.mock('./http', () => ({ apiRequest: vi.fn() }));

describe('pet service', () => {
  it('lists drafts and updates pet metadata', async () => {
    vi.mocked(apiRequest)
      .mockResolvedValueOnce({ docs: [], totalDocs: 0 })
      .mockResolvedValueOnce({ doc: { id: 5 } });
    await listPets({ page: 1, limit: 10, search: 'Aera', sort: '-updatedAt' });
    await updatePet(5, { manifest: { id: 'aera' } });
    expect(apiRequest).toHaveBeenNthCalledWith(
      1,
      '/pet-assets?page=1&limit=10&sort=-updatedAt&draft=true&where%5Bname%5D%5Bcontains%5D=Aera',
      { signal: undefined }
    );
    expect(apiRequest).toHaveBeenNthCalledWith(2, '/pet-assets/5?draft=true', {
      method: 'PATCH',
      body: { manifest: { id: 'aera' } }
    });
  });
});
