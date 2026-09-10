import { CapabilityService } from '../../server/infrastructure/capability.service';

describe('CapabilityService OpenAI-compatible provider', () => {
  const originalFetch = global.fetch;
  const env = { ...process.env };

  afterEach(() => {
    global.fetch = originalFetch;
    process.env = { ...env };
  });

  it('posts chat completions and returns parsed JSON', async () => {
    process.env.AI_PROVIDER_URL = 'https://example.test/v1';
    process.env.AI_PROVIDER_API_KEY = 'test-key';
    process.env.AI_PROVIDER_MODEL = 'deepseek-v4-flash';
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [
          {
            message: {
              content: '{"summary":"测试摘要","scores":{"model":{"entity":0}}}',
            },
          },
        ],
      }),
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    const result = await new CapabilityService()
      .load('ai_article_scoring_1')
      .call('textToJson', { article_text: 'OpenAI 发布了 GPT-5。' });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://example.test/v1/chat/completions');
    expect(init.headers.authorization).toBe('Bearer test-key');
    const body = JSON.parse(init.body as string);
    expect(body.model).toBe('deepseek-v4-flash');
    expect(body.response_format).toEqual({ type: 'json_object' });
    expect(result).toEqual({
      summary: '测试摘要',
      scores: { model: { entity: 0 } },
    });
  });
});
