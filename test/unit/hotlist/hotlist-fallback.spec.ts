import { HotlistService } from '../../../server/modules/hotlist/hotlist.service';

describe('HotlistService snapshot fallback contract', () => {
  function serviceWith(loader: jest.Mock): HotlistService {
    const service = new HotlistService({} as any, {} as any);
    (service as any).loadSnapshot = loader;
    return service;
  }

  it('distinguishes an empty result with no snapshot from live data', async () => {
    const response = await (serviceWith(jest.fn().mockResolvedValue(null)) as any)
      .fallbackToSnapshot('github');
    expect(response).toMatchObject({ ok: false, source: 'none', reason: 'no_snapshot', items: [] });
  });

  it('surfaces snapshot database failures instead of claiming no live data', async () => {
    const response = await (serviceWith(jest.fn().mockResolvedValue({
      items: [], updatedAt: '2026-09-08T00:00:00.000Z', unavailable: true,
    })) as any).fallbackToSnapshot('weibo');
    expect(response).toMatchObject({ ok: false, source: 'none', reason: 'snapshot_unavailable' });
  });
});
