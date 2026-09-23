import {
  getAiProviderStatus,
  normalizeAiProviderProtocol,
} from '../../server/infrastructure/ai-provider-status';

describe('AI provider status', () => {
  it.each([
    [undefined, 'missing'],
    ['legacy', 'legacy'],
    ['openai', 'openai'],
    ['openai-compatible', 'openai'],
    ['openai_compatible', 'openai'],
    ['other', 'unsupported'],
  ])('normalizes protocol %s', (value, expected) => {
    expect(normalizeAiProviderProtocol(value)).toBe(expected);
  });

  it('requires an endpoint, key, and OpenAI-compatible protocol for scoring', () => {
    expect(
      getAiProviderStatus({
        AI_PROVIDER_URL: 'https://provider.test/v1',
        AI_PROVIDER_API_KEY: 'key',
        AI_PROVIDER_PROTOCOL: 'openai',
      }).scoringAgent,
    ).toEqual({
      enabled: true,
      invocation: 'available',
      blockReason: null,
    });

    expect(
      getAiProviderStatus({
        AI_PROVIDER_URL: 'https://provider.test/v1',
        AI_PROVIDER_PROTOCOL: 'openai',
      }).scoringAgent,
    ).toMatchObject({
      enabled: false,
      invocation: 'not_configured',
      blockReason: 'missing_api_key',
    });

    expect(
      getAiProviderStatus({
        AI_PROVIDER_URL: 'https://provider.test/v1',
        AI_PROVIDER_API_KEY: 'key',
        AI_PROVIDER_PROTOCOL: 'unsupported',
      }),
    ).toMatchObject({
      providerConfigured: false,
      scoringAgent: {
        enabled: false,
        invocation: 'not_configured',
        blockReason: 'unsupported_protocol',
      },
    });

    expect(
      getAiProviderStatus({
        AI_PROVIDER_URL: 'https://legacy-provider.test/capability',
      }),
    ).toMatchObject({
      providerConfigured: true,
      scoringAgent: {
        enabled: false,
        blockReason: 'legacy_protocol',
      },
    });
  });

  it('uses a capability-specific endpoint when the global endpoint is absent', () => {
    const status = getAiProviderStatus({
      AI_ARTICLE_SCORING_1_URL: 'https://scoring.provider.test/v1',
      AI_PROVIDER_API_KEY: 'key',
      AI_PROVIDER_PROTOCOL: 'openai',
    });

    expect(status).toMatchObject({
      endpointConfigured: true,
      endpointSource: 'capability',
      endpointVariable: 'AI_ARTICLE_SCORING_1_URL',
      scoringAgent: { enabled: true },
    });
  });

  it('prefers the capability-specific endpoint over the global endpoint', () => {
    const status = getAiProviderStatus({
      AI_ARTICLE_SCORING_1_URL: 'https://scoring.provider.test/v1',
      AI_PROVIDER_URL: 'https://fallback.provider.test/v1',
      AI_PROVIDER_API_KEY: 'key',
      AI_PROVIDER_PROTOCOL: 'openai',
    });

    expect(status.endpointVariable).toBe('AI_ARTICLE_SCORING_1_URL');
    expect(status.endpointSource).toBe('capability');
  });
});
