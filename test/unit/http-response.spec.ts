import { validateApiResponse } from '../../client/src/lib/validate-api-response';

describe('http response validation', () => {
  it('rejects HTML returned for an API request', async () => {
    expect(() => validateApiResponse('<!doctype html>', 'text/html')).toThrow('API returned HTML');
  });

  it('accepts JSON responses', () => {
    expect(() => validateApiResponse({ items: [] }, 'application/json')).not.toThrow();
  });
});
