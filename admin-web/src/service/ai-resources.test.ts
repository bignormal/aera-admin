import { beforeEach, describe, expect, it, vi } from 'vitest';
import { callPlatform } from './platform';
import {
  createAIResource,
  createScheduledTest,
  deleteAIResource,
  listAIResources,
  refreshAccount,
  runAIResourceAction,
  testAccount,
  updateAIResource,
  updateScheduledTest
} from './ai-resources';

vi.mock('./platform', () => ({ callPlatform: vi.fn() }));

describe('AI resource service', () => {
  beforeEach(() => vi.mocked(callPlatform).mockReset());

  it.each(['groups', 'accounts', 'proxies', 'channels', 'monitors'] as const)(
    'maps %s pagination and removes credential values',
    async resource => {
      vi.mocked(callPlatform).mockResolvedValueOnce({
        data: {
          code: 0,
          message: 'success',
          data: {
            items: [
              {
                id: 1,
                name: 'resource',
                access_token: 'access-secret',
                refresh_token: 'refresh-secret',
                client_secret: 'client-secret',
                password: 'proxy-password'
              }
            ],
            total: 1,
            page: 1,
            page_size: 20,
            pages: 1
          }
        },
        meta: {},
        requestId: 'request-list'
      });

      const result = await listAIResources(resource, { page: 1, limit: 20, search: '', sort: '-updatedAt' });
      expect(JSON.stringify(result)).not.toContain('access-secret');
      expect(JSON.stringify(result)).not.toContain('refresh-secret');
      expect(JSON.stringify(result)).not.toContain('client-secret');
      expect(JSON.stringify(result)).not.toContain('proxy-password');
      expect(result).toMatchObject({ totalDocs: 1, page: 1, limit: 20, docs: [{ id: 1, name: 'resource' }] });
    }
  );

  it.each([
    ['monitorTemplates', { items: [{ id: 1, name: 'template' }] }],
    ['tlsProfiles', [{ id: 1, name: 'tls' }]],
    ['errorRules', [{ id: 1, name: 'rule' }]]
  ] as const)('parses the declared %s list shape', async (resource, data) => {
    vi.mocked(callPlatform).mockResolvedValueOnce({
      data: { code: 0, data, message: 'success' },
      meta: {},
      requestId: 'request-list-shape'
    });

    await expect(listAIResources(resource, { page: 1, limit: 20 })).resolves.toMatchObject({ totalDocs: 1 });
  });

  it('rejects an AI resource without an id', async () => {
    vi.mocked(callPlatform).mockResolvedValueOnce({
      data: { code: 0, data: { items: [{ name: 'invalid' }] }, message: 'success' },
      meta: {},
      requestId: 'invalid-ai-resource'
    });

    await expect(listAIResources('accounts', { page: 1, limit: 10 })).rejects.toThrow('资源缺少合法 id');
  });

  it('rejects id-less AI resource mutation responses', async () => {
    vi.mocked(callPlatform).mockResolvedValue({
      data: { code: 0, data: { name: 'missing-id' }, message: 'success' },
      meta: {},
      requestId: 'invalid-ai-mutation'
    });

    await expect(createAIResource('accounts', { name: 'account' })).rejects.toThrow('资源缺少合法 id');
    await expect(updateAIResource('accounts', 1, { name: 'account' })).rejects.toThrow('资源缺少合法 id');
    await expect(createScheduledTest({ name: 'test' })).rejects.toThrow('资源缺少合法 id');
    await expect(updateScheduledTest(1, { name: 'test' })).rejects.toThrow('资源缺少合法 id');
  });

  it('uses POST for account test and refresh actions', async () => {
    vi.mocked(callPlatform).mockResolvedValue({
      data: { code: 0, message: 'success', data: {} },
      meta: {},
      requestId: 'action'
    });

    await testAccount(12);
    await refreshAccount(12);

    expect(callPlatform).toHaveBeenNthCalledWith(1, 'testAccount', { method: 'POST', params: { id: 12 } });
    expect(callPlatform).toHaveBeenNthCalledWith(2, 'refreshAccount', { method: 'POST', params: { id: 12 } });
  });

  it('uses registered actions and explicit delete methods', async () => {
    vi.mocked(callPlatform).mockResolvedValue({
      data: { code: 0, message: 'success', data: {} },
      meta: {},
      requestId: 'action'
    });

    await runAIResourceAction('testProxy', 9);
    await deleteAIResource('channels', 9);

    expect(callPlatform).toHaveBeenNthCalledWith(1, 'testProxy', { method: 'POST', params: { id: 9 } });
    expect(callPlatform).toHaveBeenNthCalledWith(2, 'deleteChannel', { method: 'DELETE', params: { id: 9 } });
  });
});
