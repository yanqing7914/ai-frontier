import { BadRequestException, ConflictException } from '@nestjs/common';
import { parseFeedSourcePagination } from '../../../server/modules/feed-source/feed-source.controller';
import {
  canonicalizeFeedUrl,
  FeedSourceService,
} from '../../../server/modules/feed-source/feed-source.service';

const validSource = {
  name: ' Example Feed ',
  url: 'HTTPS://Example.COM/feed/?b=2&a=1#latest',
  tier: 'signal' as const,
  feedType: 'rss' as const,
  sourceCategoryId: 'media_analysis',
  originPolicy: 'aggregator' as const,
};

function query(result: unknown[] = []) {
  const promise = Promise.resolve(result);
  const chain: Record<string, jest.Mock> = {};
  for (const method of ['select', 'from', 'where', 'limit', 'offset', 'orderBy', 'update', 'set', 'insert', 'values', 'returning']) {
    chain[method] = jest.fn(() => chain);
  }
  Object.assign(chain, { then: promise.then.bind(promise), catch: promise.catch.bind(promise) });
  return chain;
}

describe('feed source URL validation', () => {
  it('canonicalizes equivalent public URLs', () => {
    expect(canonicalizeFeedUrl(validSource.url)).toBe('https://example.com/feed?a=1&b=2');
    expect(canonicalizeFeedUrl('https://example.com/feed')).toBe('https://example.com/feed');
  });

  it.each([
    'file:///etc/passwd',
    'http://user:pass@example.com/feed',
    'http://localhost/feed',
    'http://service.internal/feed',
    'http://127.0.0.1/feed',
    'http://2130706433/feed',
    'http://0x7f000001/feed',
    'http://10.1.2.3/feed',
    'http://172.16.0.1/feed',
    'http://192.168.1.1/feed',
    'http://169.254.169.254/latest/meta-data',
    'http://[::1]/feed',
    'http://[fe80::1]/feed',
    'http://[::ffff:127.0.0.1]/feed',
    'https://example.com:8443/feed',
  ])('rejects unsafe URL %s', (url) => {
    expect(() => canonicalizeFeedUrl(url)).toThrow(BadRequestException);
  });
});

describe('feed source writes', () => {
  it('normalizes category metadata before insert', async () => {
    const db = query([{ id: 'source-1' }]);
    db.insert = jest.fn(() => db);
    const service = new FeedSourceService(db as any);

    await service.create(validSource);

    expect(db.values).toHaveBeenCalledWith(expect.objectContaining({
      name: 'Example Feed',
      url: 'https://example.com/feed?a=1&b=2',
      sourceCategory: '媒体分析',
      sourceCategoryId: 'media_analysis',
    }));
  });

  it.each([
    [{ ...validSource, tier: 'unknown' }],
    [{ ...validSource, feedType: 'ftp' }],
    [{ ...validSource, sourceCategoryId: 'unknown' }],
    [{ ...validSource, originPolicy: 'unknown' }],
    [{ ...validSource, region: 'private' }],
    [{ ...validSource, primaryDirectionId: 'unknown' }],
    [{ ...validSource, tier: 'authoritative', originPolicy: 'aggregator' }],
  ])('rejects invalid enum or reliability combinations', async (dto) => {
    const service = new FeedSourceService(query() as any);
    await expect(service.create(dto as any)).rejects.toThrow(BadRequestException);
  });

  it('maps concurrent unique violations to a conflict', async () => {
    const db = query();
    const rejected = Promise.reject({ code: '23505', constraint: 'feed_source_url_key' });
    Object.assign(db, { then: rejected.then.bind(rejected), catch: rejected.catch.bind(rejected) });
    const service = new FeedSourceService(db as any);
    await expect(service.create(validSource)).rejects.toThrow(ConflictException);
  });

  it('clears only cooldown state when re-enabled', async () => {
    const db = query([{ id: 'source-1', enabled: true }]);
    const service = new FeedSourceService(db as any);
    await service.toggle('source-1', { enabled: true });
    expect(db.set).toHaveBeenCalledWith({ enabled: true, nextFetchAt: null });
  });

  it('builds the fixed enabled and cooldown eligibility query with caller time', async () => {
    const db = query([{ id: 'source-1' }]);
    const service = new FeedSourceService(db as any);
    await expect(service.findEligibleForIngest(new Date('2026-08-19T00:00:00Z')))
      .resolves.toEqual([{ id: 'source-1' }]);
    expect(db.where).toHaveBeenCalledTimes(1);
  });
});

describe('feed source pagination', () => {
  it('uses bounded defaults', () => {
    expect(parseFeedSourcePagination()).toEqual({ page: 1, pageSize: 20 });
  });

  it.each([['0', '20'], ['1', '0'], ['1', '201'], ['10001', '20'], ['1.5', '20']])(
    'rejects invalid pagination (%s, %s)',
    (page, pageSize) => expect(() => parseFeedSourcePagination(page, pageSize)).toThrow(BadRequestException),
  );
});
