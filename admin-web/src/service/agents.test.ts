import { beforeEach, describe, expect, it, vi } from 'vitest';
import { apiRequest } from './http';
import { createAgent, listAgents, updateAgent } from './agents';

vi.mock('./http', () => ({ apiRequest: vi.fn() }));

describe('agent service', () => {
  beforeEach(() => vi.mocked(apiRequest).mockReset());

  it('uses the versioned agent collection with server pagination', async () => {
    vi.mocked(apiRequest).mockResolvedValueOnce({ docs: [], totalDocs: 0 });
    await listAgents({ page: 2, limit: 20, search: '产品', sort: '-updatedAt' });
    expect(apiRequest).toHaveBeenCalledWith(
      '/agent-templates?page=2&limit=20&sort=-updatedAt&draft=true&where%5Bname%5D%5Bcontains%5D=%E4%BA%A7%E5%93%81',
      { signal: undefined }
    );
  });

  it('creates and updates drafts through Payload mutation envelopes', async () => {
    const rawInput = { name: '产品经理', templateKey: 'product-manager' };
    const input = rawInput as never;
    vi.mocked(apiRequest).mockResolvedValue({ doc: { id: 1, ...rawInput } });
    await createAgent(input);
    await updateAgent(1, input);
    expect(apiRequest).toHaveBeenNthCalledWith(1, '/agent-templates?draft=true', {
      method: 'POST',
      body: input
    });
    expect(apiRequest).toHaveBeenNthCalledWith(2, '/agent-templates/1?draft=true', {
      method: 'PATCH',
      body: input
    });
  });
});
