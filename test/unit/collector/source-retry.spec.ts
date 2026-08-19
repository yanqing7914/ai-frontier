import { getSourceRetryAt } from '../../../server/modules/feed-source/feed-source.service';

describe('source retry cooldown', () => {
  const now = new Date('2026-08-19T00:00:00.000Z');

  it('keeps the first two transient failures on the normal schedule', () => {
    expect(getSourceRetryAt('fetch failed', 0, now)).toBeNull();
    expect(getSourceRetryAt('fetch failed', 1, now)).toBeNull();
  });

  it('uses exponential backoff after the third transient failure', () => {
    expect(getSourceRetryAt('fetch failed', 2, now)?.toISOString()).toBe(
      '2026-08-19T02:00:00.000Z',
    );
    expect(getSourceRetryAt('fetch failed', 3, now)?.toISOString()).toBe(
      '2026-08-19T04:00:00.000Z',
    );
  });

  it('caps transient failures at a seven-day cooldown', () => {
    expect(getSourceRetryAt('Request timed out', 20, now)?.toISOString()).toBe(
      '2026-08-26T00:00:00.000Z',
    );
  });

  it('puts known permanent HTTP failures into a seven-day cooldown', () => {
    expect(getSourceRetryAt('HTTP 404 for https://example.com/feed', 2, now)?.toISOString()).toBe(
      '2026-08-26T00:00:00.000Z',
    );
    expect(getSourceRetryAt('HTTP 403 for https://example.com/feed', 10, now)?.toISOString()).toBe(
      '2026-08-26T00:00:00.000Z',
    );
  });
});
