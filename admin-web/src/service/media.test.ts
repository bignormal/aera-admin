import { describe, expect, it, vi } from 'vitest';
import { apiRequest } from './http';
import { listMedia, uploadMedia } from './media';

vi.mock('./http', () => ({ apiRequest: vi.fn() }));

describe('media service', () => {
  it('searches media by its alt field', async () => {
    vi.mocked(apiRequest).mockResolvedValueOnce({ docs: [] });
    await listMedia({ page: 1, limit: 10, search: 'Aera', sort: '-updatedAt' });

    expect(apiRequest).toHaveBeenCalledWith(
      '/media?page=1&limit=10&sort=-updatedAt&where%5Balt%5D%5Bcontains%5D=Aera',
      { signal: undefined }
    );
  });

  it('uploads a multipart Payload media document without an authorization header', async () => {
    const file = new File(['image'], 'preview.png', { type: 'image/png' });
    vi.mocked(apiRequest).mockResolvedValueOnce({ doc: { id: 6 } });
    await uploadMedia(file, { alt: 'Aera preview', attribution: 'Aera' });

    const [path, options] = vi.mocked(apiRequest).mock.calls[0];
    expect(path).toBe('/media');
    expect(options?.method).toBe('POST');
    expect(options?.headers).toBeUndefined();
    expect(options?.body).toBeInstanceOf(FormData);
    const body = options?.body as FormData;
    expect(body.get('file')).toBe(file);
    expect(body.get('_payload')).toBe(JSON.stringify({ alt: 'Aera preview', attribution: 'Aera' }));
  });
});
