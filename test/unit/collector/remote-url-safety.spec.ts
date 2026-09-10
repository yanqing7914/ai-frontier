import { validateSafeUrl } from '../../../server/modules/collector/trace-engine';

jest.mock('node:dns/promises', () => ({
  lookup: jest.fn(),
}));

import { lookup } from 'node:dns/promises';

describe('remote URL DNS safety', () => {
  it('rejects a public hostname resolving to a private address', async () => {
    (lookup as jest.Mock).mockResolvedValue([{ address: '10.0.0.8', family: 4 }]);
    await expect(validateSafeUrl('https://example.test/feed')).resolves.toMatchObject({
      safe: false,
      reason: 'dns_private_or_empty',
    });
  });

  it('accepts a hostname resolving only to a public address', async () => {
    (lookup as jest.Mock).mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
    await expect(validateSafeUrl('https://example.test/feed')).resolves.toMatchObject({
      safe: true,
      address: '93.184.216.34',
    });
  });
});
