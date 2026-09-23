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
    process.env.AI_PROVIDER_PROTOCOL = 'openai';
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
    expect(body.messages[0].content).toContain('model_name');
    expect(body.messages[0].content).toContain('business_problem');
    expect(body.messages[0].content).toContain('Every non-zero dimension');
    expect(result).toEqual({
      summary: '测试摘要',
      scores: { model: { entity: 0 } },
    });
  });

  it('keeps the legacy capability protocol when no protocol is configured', async () => {
    process.env.AI_PROVIDER_URL = 'https://legacy.example.test/capability';
    delete process.env.AI_PROVIDER_PROTOCOL;
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ result: 'legacy-ok' }),
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    const result = await new CapabilityService()
      .load('github_repo_desc_translate_1')
      .call('textToJson', { repo_desc_en: 'A repository' });

    expect(fetchMock).toHaveBeenCalledWith(
      'https://legacy.example.test/capability',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          capabilityId: 'github_repo_desc_translate_1',
          action: 'textToJson',
          input: { repo_desc_en: 'A repository' },
        }),
      }),
    );
    expect(result).toEqual({ result: 'legacy-ok' });
  });

  it('uses the capability-specific endpoint before the global fallback', async () => {
    process.env.AI_ARTICLE_SCORING_1_URL = 'https://scoring.example.test/v1';
    process.env.AI_PROVIDER_URL = 'https://fallback.example.test/v1';
    process.env.AI_PROVIDER_PROTOCOL = 'openai';
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: '{"summary":"ok","scores":{}}' } }],
      }),
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    await new CapabilityService()
      .load('ai_article_scoring_1')
      .call('textToJson', { article_text: 'source' });

    expect(fetchMock.mock.calls[0][0]).toBe(
      'https://scoring.example.test/v1/chat/completions',
    );
  });

  it('does not include an upstream error body in the thrown error', async () => {
    process.env.AI_PROVIDER_URL = 'https://example.test/v1';
    process.env.AI_PROVIDER_PROTOCOL = 'openai';
    const secret = 'provider-secret-in-error-body';
    const fetchMock = jest.fn().mockResolvedValue({
      ok: false,
      status: 502,
      text: async () => secret,
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    await expect(
      new CapabilityService()
        .load('ai_article_scoring_1')
        .call('textToJson', { article_text: 'source' }),
    ).rejects.toThrow('AI provider returned 502');
    await expect(
      new CapabilityService()
        .load('ai_article_scoring_1')
        .call('textToJson', { article_text: 'source' }),
    ).rejects.not.toThrow(secret);
  });

  it('propagates a caller abort signal to the provider fetch', async () => {
    process.env.AI_PROVIDER_URL = 'https://example.test/v1';
    process.env.AI_PROVIDER_PROTOCOL = 'openai';
    const fetchMock = jest.fn(
      (_url: string, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => {
            reject(new DOMException('aborted', 'AbortError'));
          });
        }),
    );
    global.fetch = fetchMock as unknown as typeof fetch;
    const controller = new AbortController();

    const pending = new CapabilityService()
      .load('ai_article_scoring_1')
      .callWithSignal!('textToJson', { article_text: 'source' }, undefined, controller.signal);
    controller.abort();

    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(fetchMock.mock.calls[0][1].signal).not.toBe(controller.signal);
    expect((fetchMock.mock.calls[0][1].signal as AbortSignal).aborted).toBe(true);
  });

  it('aborts a response body that is still pending after headers arrive', async () => {
    process.env.AI_PROVIDER_URL = 'https://example.test/v1';
    process.env.AI_PROVIDER_PROTOCOL = 'openai';
    process.env.AI_PROVIDER_TIMEOUT_MS = '10';
    let bodyAborted = false;
    const fetchMock = jest.fn((_url: string, init: RequestInit) =>
      Promise.resolve({
        ok: true,
        json: () =>
          new Promise<never>((_resolve, reject) => {
            init.signal?.addEventListener('abort', () => {
              bodyAborted = true;
              reject(new DOMException('aborted', 'AbortError'));
            });
          }),
      }),
    );
    global.fetch = fetchMock as unknown as typeof fetch;

    await expect(
      new CapabilityService()
        .load('ai_article_scoring_1')
        .call('textToJson', { article_text: 'source' }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(bodyAborted).toBe(true);
  });
});
