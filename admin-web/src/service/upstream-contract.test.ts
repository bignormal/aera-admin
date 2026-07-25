import { describe, expect, it } from 'vitest';
import {
  ContractError,
  asResourceRecord,
  asUpstreamRecord,
  normalizeUpstreamArray,
  normalizeUpstreamPage,
  unwrapUpstream
} from './upstream-contract';

describe('upstream contract parsing', () => {
  it('unwraps a success envelope and rejects malformed or failed envelopes', () => {
    expect(unwrapUpstream({ code: 0, data: { id: 1 }, message: 'success' })).toEqual({ id: 1 });
    expect(() => unwrapUpstream({ code: 500, data: null, message: 'failed' })).toThrow(ContractError);
    expect(() => unwrapUpstream({ data: [] })).toThrow(ContractError);
  });

  it('normalizes a real page and rejects non-array items', () => {
    expect(
      normalizeUpstreamPage(
        { items: [{ id: 1 }], page: 2, page_size: 10, pages: 3, total: 21 },
        { page: 2, limit: 10 },
        asResourceRecord
      )
    ).toMatchObject({ docs: [{ id: 1 }], page: 2, limit: 10, totalDocs: 21, totalPages: 3 });

    expect(() => normalizeUpstreamPage({ items: null }, { page: 1, limit: 10 }, asResourceRecord)).toThrow(
      ContractError
    );
  });

  it.each([
    { page: 0 },
    { page: 1.5 },
    { page_size: 0 },
    { page_size: Number.POSITIVE_INFINITY },
    { pages: -1 },
    { total: -1 }
  ])('rejects invalid pagination metadata %o', metadata => {
    expect(() =>
      normalizeUpstreamPage({ items: [{ id: 1 }], ...metadata }, { page: 1, limit: 10 }, asResourceRecord)
    ).toThrow(ContractError);
  });

  it('normalizes only an explicitly declared upstream array', () => {
    expect(normalizeUpstreamArray([{ id: 1 }], { page: 1, limit: 10 }, asResourceRecord)).toMatchObject({
      docs: [{ id: 1 }],
      totalDocs: 1
    });
    expect(() => normalizeUpstreamArray({ items: [{ id: 1 }] }, { page: 1, limit: 10 }, asResourceRecord)).toThrow(
      ContractError
    );
  });

  it('accepts only an object for upstream record endpoints', () => {
    expect(asUpstreamRecord({ qps: 2 })).toEqual({ qps: 2 });
    expect(() => asUpstreamRecord([])).toThrow(ContractError);
    expect(() => asUpstreamRecord(null)).toThrow(ContractError);
  });

  it('rejects an empty resource id', () => {
    expect(() => asResourceRecord({ id: '' })).toThrow(ContractError);
  });
});
