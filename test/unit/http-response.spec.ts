import { resolveApiBaseUrl } from '../../client/src/lib/api-base-url';
import { validateApiResponse } from '../../client/src/lib/validate-api-response';

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
