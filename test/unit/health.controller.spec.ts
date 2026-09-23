import { HealthController } from '../../server/modules/health/health.controller';

describe('HealthController', () => {
  const originalEnvironment = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnvironment };
  });

  it('returns a JSON-ready status payload without database access', () => {
    delete process.env.DATABASE_URL;
    delete process.env.SUDA_DATABASE_URL;
    delete process.env.AI_PROVIDER_URL;
    delete process.env.AI_PROVIDER_API_KEY;
    delete process.env.AI_PROVIDER_PROTOCOL;

    const result = new HealthController().getHealth();

    expect(result.status).toBe('ok');
    expect(result.service).toBe('ai-frontier');
    expect(new Date(result.timestamp).toISOString()).toBe(result.timestamp);
    expect(result.readiness.database).toBeDefined();
    expect(result.readiness.aiScoring).toBe('disabled');
    expect(result.ai.scoringAgent.blockReason).toBe('missing_endpoint');
    expect(result.ai.architecture).toEqual({
      directions: 9,
      postProcessingRoles: 8,
      externallyConfiguredRoles: 0,
    });
  });

  it('reports the externally configured scoring agent without exposing credentials', () => {
    process.env.DATABASE_URL = 'postgres://configured';
    process.env.AI_PROVIDER_URL = 'https://provider.test/v1';
    process.env.AI_PROVIDER_API_KEY = 'secret-value';
    process.env.AI_PROVIDER_PROTOCOL = 'openai-compatible';
    process.env.AI_PROVIDER_MODEL = 'deepseek-v4-flash';

    const result = new HealthController().getHealth();

    expect(result.readiness.status).toBe('ready');
    expect(result.readiness.aiScoring).toBe('ready');
    expect(result.ai.provider).toEqual({
      protocol: 'openai',
      configured: true,
      endpoint: 'configured',
      apiKey: 'configured',
      model: 'configured',
    });
    expect(result.ai.scoringAgent).toEqual({
      role: 'content_evaluator',
      enabled: true,
      invocation: 'available',
      blockReason: null,
    });
    expect(JSON.stringify(result)).not.toContain('secret-value');
  });

  it('distinguishes a legacy provider from the OpenAI-compatible scoring path', () => {
    process.env.AI_PROVIDER_URL = 'https://legacy-provider.test/capability';
    process.env.AI_PROVIDER_API_KEY = 'legacy-secret';
    process.env.AI_PROVIDER_PROTOCOL = 'legacy';

    const result = new HealthController().getHealth();

    expect(result.ai.provider.protocol).toBe('legacy');
    expect(result.ai.provider.configured).toBe(true);
    expect(result.ai.scoringAgent.enabled).toBe(false);
    expect(result.ai.scoringAgent.blockReason).toBe('legacy_protocol');
  });

  it('reports a capability-specific scoring endpoint as ready', () => {
    process.env.AI_ARTICLE_SCORING_1_URL = 'https://scoring.provider.test/v1';
    process.env.AI_PROVIDER_API_KEY = 'secret-value';
    process.env.AI_PROVIDER_PROTOCOL = 'openai';

    const result = new HealthController().getHealth();

    expect(result.readiness.aiScoring).toBe('ready');
    expect(result.ai.provider.endpoint).toBe('configured');
    expect(result.ai.scoringAgent.enabled).toBe(true);
    expect(JSON.stringify(result)).not.toContain('scoring.provider.test');
  });
});
