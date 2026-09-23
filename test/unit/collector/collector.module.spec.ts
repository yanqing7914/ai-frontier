import { createProductionAgentRegistry } from '../../../server/modules/collector/collector.module';

const providerEnvironment = {
  AI_PROVIDER_URL: 'https://provider.test/v1',
  AI_PROVIDER_API_KEY: 'fake-provider-key',
};

function contentEvaluator(environment: Record<string, string | undefined>) {
  return createProductionAgentRegistry(environment).agents.content_evaluator;
}

describe('production collector agent registry', () => {
  it.each(['openai', 'openai-compatible', 'openai_compatible'])(
    'activates content_evaluator for the %s protocol alias',
    (protocol) => {
      const agent = contentEvaluator({
        ...providerEnvironment,
        AI_PROVIDER_PROTOCOL: protocol,
      });

      expect(agent).toMatchObject({
        enabled: true,
        status: 'active',
        verification: { status: 'verified' },
        capability: { invocation: 'available' },
      });
    },
  );

  it.each([
    ['missing', undefined],
    ['legacy', 'legacy'],
    ['unsupported', 'custom-provider'],
  ])('keeps the safe default for a %s protocol', (_label, protocol) => {
    const agent = contentEvaluator({
      ...providerEnvironment,
      AI_PROVIDER_PROTOCOL: protocol,
    });

    expect(agent).toMatchObject({
      enabled: false,
      status: 'disabled',
      verification: { status: 'not_run' },
      capability: { invocation: 'not_configured' },
    });
  });

  it.each([
    ['URL', { AI_PROVIDER_API_KEY: 'fake-provider-key' }],
    ['API key', { AI_PROVIDER_URL: 'https://provider.test/v1' }],
  ])('does not activate without a provider %s', (_label, missingValue) => {
    const agent = contentEvaluator({
      ...missingValue,
      AI_PROVIDER_PROTOCOL: 'openai',
    });

    expect(agent).toMatchObject({
      enabled: false,
      status: 'disabled',
      verification: { status: 'not_run' },
      capability: { invocation: 'not_configured' },
    });
  });

  it('activates scoring when only the capability-specific endpoint is configured', () => {
    const agent = contentEvaluator({
      AI_ARTICLE_SCORING_1_URL: 'https://scoring.provider.test/v1',
      AI_PROVIDER_API_KEY: 'fake-provider-key',
      AI_PROVIDER_PROTOCOL: 'openai',
    });

    expect(agent).toMatchObject({
      enabled: true,
      status: 'active',
      verification: {
        status: 'verified',
        evidence: ['AI_ARTICLE_SCORING_1_URL'],
      },
    });
  });
});
