import { beforeEach, describe, expect, it, vi } from 'vitest';
import { apiRequest } from './http';
import { listAuditLogs } from './audit';

vi.mock('./http', () => ({ apiRequest: vi.fn() }));

describe('audit service', () => {
  beforeEach(() => vi.mocked(apiRequest).mockReset());

  it('uses server pagination and searches only the action field', async () => {
    vi.mocked(apiRequest).mockResolvedValueOnce({ docs: [], totalDocs: 0, totalPages: 1, page: 2 });

    await listAuditLogs({ limit: 20, page: 2, search: 'runtime', sort: '-occurredAt' });

    expect(apiRequest).toHaveBeenCalledWith(
      '/audit-logs?page=2&limit=20&sort=-occurredAt&where%5Baction%5D%5Bcontains%5D=runtime',
      { signal: undefined }
    );
  });
});
