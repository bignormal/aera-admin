import { describe, expect, it, vi } from 'vitest';
import { apiRequest } from './http';
import { publishResource, saveResourceDraft } from './publishing';

vi.mock('./http', () => ({ apiRequest: vi.fn() }));

describe('publishing service', () => {
  it('uses explicit Payload draft and publish queries', async () => {
    vi.mocked(apiRequest).mockResolvedValue({ doc: { id: 8 } });
    await publishResource('plugin-catalog', 8);
    await saveResourceDraft('pet-assets', 9);
    await publishResource('skill-catalog', 10);
    expect(apiRequest).toHaveBeenNthCalledWith(1, '/plugin-catalog/8?draft=false', {
      method: 'PATCH',
      body: { _status: 'published' }
    });
    expect(apiRequest).toHaveBeenNthCalledWith(2, '/pet-assets/9?draft=true', {
      method: 'PATCH',
      body: { _status: 'draft' }
    });
    expect(apiRequest).toHaveBeenNthCalledWith(3, '/skill-catalog/10?draft=false', {
      method: 'PATCH',
      body: { _status: 'published' }
    });
  });
});
