import { resolveApiBaseUrl } from '../../client/src/lib/api-base-url';
import { validateApiResponse } from '../../client/src/lib/validate-api-response';
import { parseHotlistResponse, parsePaginatedResponse } from '../../client/src/lib/api-contract';
import { getDevelopmentAdminHeaders } from '../../client/src/lib/admin-auth';

describe('API base URL resolution', () => {
  it('uses same-origin proxy by default', () => {
    expect(resolveApiBaseUrl(undefined)).toBe('/');
  });

  it('normalizes trailing slash and an optional /api suffix', () => {
    expect(resolveApiBaseUrl(' https://api.example.test/api/ ')).toBe('https://api.example.test');
  });
});

describe('http response validation', () => {
  it('rejects HTML returned for an API request', async () => {
    expect(() => validateApiResponse('<!doctype html>', 'text/html')).toThrow('API returned HTML');
  });

  it('accepts JSON responses', () => {
    expect(() => validateApiResponse({ items: [] }, 'application/json')).not.toThrow();
  });
});

describe('API contract validation', () => {
  it('rejects malformed paginated responses', () => {
    expect(() => parsePaginatedResponse({ items: [] }, 'Hot articles')).toThrow('total');
    expect(() => parsePaginatedResponse({ total: 1 }, 'Hot articles')).toThrow('items');
  });

  it('preserves an unavailable hotlist envelope instead of treating it as empty data', () => {
    expect(parseHotlistResponse({ ok: false, kind: 'github', source: 'none', items: [], reason: 'no_snapshot' })).toMatchObject({
      ok: false,
      source: 'none',
      reason: 'no_snapshot',
    });
  });

  it('rejects malformed hotlist envelopes', () => {
    expect(() => parseHotlistResponse({ ok: true, kind: 'github', source: 'live' })).toThrow('items');
  });
});

describe('development admin authentication', () => {
  it('sends a token only for an explicitly enabled local development build', () => {
    expect(getDevelopmentAdminHeaders(true, true, ' dev-token ')).toEqual({
      'x-admin-token': 'dev-token',
    });
  });

  it('never sends the token in production or without the local opt-in', () => {
    expect(getDevelopmentAdminHeaders(false, true, 'prod-token')).toEqual({});
    expect(getDevelopmentAdminHeaders(true, false, 'token')).toEqual({});
    expect(getDevelopmentAdminHeaders(true, true, '')).toEqual({});
  });
});
