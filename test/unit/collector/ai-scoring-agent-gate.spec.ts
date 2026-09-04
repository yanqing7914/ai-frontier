import { AiScoringService } from '../../../server/modules/collector/ai-scoring.service';
import { createAgentRegistry } from '../../../server/modules/collector/agents';

const key = 'AI_FRONTIER_CONTENT_EVALUATOR_API_KEY';
const verified = {
  status: 'verified' as const,
  verifiedAt: '2026-09-02T00:00:00Z',
  verifier: 'operator',
  evidence: ['test'],
};

function registryWith(overrides: Record<string, unknown> = {}) {
  return createAgentRegistry({
    environment: { [key]: 'value' },
    overrides: {
      content_evaluator: {
        status: 'active',
        verification: verified,
        capability: {
          capabilityId: 'ai_article_scoring_1',
          action: 'textToJson',
          inputContract: 'ContractArticleInput',
          outputContract: 'ContentEvaluationOutput',
          invocation: 'available',
        },
        ...overrides,
      },
    },
  });
}

const article = [
  'AI title',
  'AI article content with enough source text to process.',
];

describe('AiScoringService agent registry gate', () => {
  it('does not load the capability while the scoring agent is unverified', async () => {
    const load = jest.fn();
    const service = new AiScoringService(
      { load } as any,
      createAgentRegistry({
        environment: { [key]: 'value' },
        overrides: {
          content_evaluator: {
            capability: {
              capabilityId: 'ai_article_scoring_1',
              action: 'textToJson',
              inputContract: 'ContractArticleInput',
              outputContract: 'ContentEvaluationOutput',
              invocation: 'available',
            },
          },
        },
      }),
      { environment: { [key]: 'value' }, adapters: { capability: { load } } },
    );
    await service.scoreArticle(article[0], article[1], 'authoritative');
    expect(load).not.toHaveBeenCalled();
  });

  it('does not load the capability when the configured key is missing', async () => {
    const load = jest.fn();
    const service = new AiScoringService({ load } as any, registryWith(), {
      environment: {},
      adapters: { capability: { load } },
    });
    await service.scoreArticle(article[0], article[1], 'authoritative');
    expect(load).not.toHaveBeenCalled();
  });

  it('does not load the capability while the agent is disabled', async () => {
    const load = jest.fn();
    const service = new AiScoringService(
      { load } as any,
      registryWith({ enabled: false, status: 'disabled' }),
      {
        environment: { [key]: 'value' },
        adapters: { capability: { load } },
      },
    );
    await service.scoreArticle(article[0], article[1], 'authoritative');
    expect(load).not.toHaveBeenCalled();
  });

  it('does not load the capability when the adapter is malformed', async () => {
    const load = jest.fn();
    const service = new AiScoringService({ load } as any, registryWith(), {
      environment: { [key]: 'value' },
      adapters: { capability: {} as any },
    });
    await service.scoreArticle(article[0], article[1], 'authoritative');
    expect(load).not.toHaveBeenCalled();
  });

  it('loads and invokes exactly once after all registry gates pass', async () => {
    const capabilityLoad = jest.fn();
    const call = jest.fn().mockResolvedValue({});
    const load = jest.fn().mockReturnValue({ call });
    const service = new AiScoringService(
      { load: capabilityLoad } as any,
      registryWith(),
      { environment: { [key]: 'value' }, adapters: { capability: { load } } },
    );
    await service.scoreArticle(article[0], article[1], 'authoritative');
    expect(capabilityLoad).not.toHaveBeenCalled();
    expect(load).toHaveBeenCalledTimes(1);
    expect(load).toHaveBeenCalledWith('ai_article_scoring_1');
    expect(call).toHaveBeenCalledTimes(1);
    expect(call).toHaveBeenCalledWith(
      'textToJson',
      expect.any(Object),
      undefined,
    );
  });
});
