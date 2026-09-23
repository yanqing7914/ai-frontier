import { runClusterStage } from '../../../server/modules/collector/stages/cluster-stage';
import type { PipelineArticle } from '../../../server/modules/collector/pipeline-types';

const article = (id: string, title: string): PipelineArticle => ({
  id,
  title,
  url: `https://example.com/${id}`,
  dedupUrl: `https://example.com/${id}`,
  content: title,
  rawContent: title,
  feedSourceId: 'source-1',
  sourceUrl: 'https://example.com/feed',
  sourceTier: 'signal',
  sourceName: 'Example',
  sourceCategoryId: null,
  originPolicy: 'editorial',
});

describe('cluster stage', () => {
  const logger = { error: jest.fn(), warn: jest.fn() };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns an empty result without touching the database for an empty batch', async () => {
    const db = { select: jest.fn() } as never;

    await expect(runClusterStage(db, [], logger)).resolves.toEqual({
      groups: 0,
      comparisons: 0,
      degraded: false,
    });
    expect((db as { select: jest.Mock }).select).not.toHaveBeenCalled();
  });

  it('continues with batch-only clustering when history lookup fails', async () => {
    const db = {
      select: jest.fn(() => {
        throw new Error('history unavailable');
      }),
    } as never;
    const items = [
      article('a', 'OpenAI GPT-5 release with API access'),
      article('b', 'OpenAI GPT-5 release adds API access'),
    ];

    const result = await runClusterStage(db, items, logger);

    expect(result.degraded).toBe(true);
    expect(result.groups).toBeGreaterThanOrEqual(1);
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('history unavailable'));
  });

  it('assigns planned cluster ids only to new articles', async () => {
    const update = jest.fn(() => ({
      set: jest.fn(() => ({
        where: jest.fn().mockResolvedValue([]),
      })),
    }));
    const db = {
      select: jest.fn(() => ({
        from: jest.fn(() => ({
          where: jest.fn(() => ({
            limit: jest.fn().mockResolvedValue([
              {
                id: 'old',
                title: 'OpenAI GPT-5 release with API access',
                url: 'https://example.com/old',
                clusterId: 'evt_existing',
              },
            ]),
          })),
        })),
      })),
      update,
    } as never;
    const items = [article('new', 'OpenAI GPT-5 release adds API access')];

    const result = await runClusterStage(db, items, logger);

    expect(result.degraded).toBe(false);
    expect(update).toHaveBeenCalledTimes(1);
  });

  it('marks assignment failures as degraded without throwing', async () => {
    const db = {
      select: jest.fn(() => ({
        from: jest.fn(() => ({
          where: jest.fn(() => ({
            limit: jest.fn().mockResolvedValue([]),
          })),
        })),
      })),
      update: jest.fn(() => {
        throw new Error('assignment unavailable');
      }),
    } as never;

    const result = await runClusterStage(
      db,
      [
        article('a', 'OpenAI GPT-5 release with API access'),
        article('b', 'OpenAI GPT-5 release adds API access'),
      ],
      logger,
    );

    expect(result.degraded).toBe(true);
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('assignment unavailable'));
  });
});
