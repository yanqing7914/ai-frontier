import {
  FetchBodyTooLargeError,
  fetchRawContent,
  parseRetryAfter,
} from '../../../server/modules/collector/parsers/fetch-raw';

describe('scheduled fetch raw response limits', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    jest.useRealTimers();
  });

  it('rejects Content-Length above the configured body limit', async () => {
    global.fetch = jest.fn().mockResolvedValue(new Response('unused', {
      status: 200,
      headers: { 'content-length': '1025' },
    })) as typeof fetch;

    await expect(fetchRawContent('https://example.com/feed', { maxBytes: 1024 }))
      .rejects.toBeInstanceOf(FetchBodyTooLargeError);
  });

  it('rejects a streamed body once its actual bytes exceed the limit', async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(700));
        controller.enqueue(new Uint8Array(700));
        controller.close();
      },
    });
    global.fetch = jest.fn().mockResolvedValue(new Response(body, { status: 200 })) as typeof fetch;

    await expect(fetchRawContent('https://example.com/feed', { maxBytes: 1024 }))
      .rejects.toBeInstanceOf(FetchBodyTooLargeError);
  });

  it('keeps the deadline active while reading the response body', async () => {
    global.fetch = jest.fn().mockImplementation((_url, init?: RequestInit) => {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          init?.signal?.addEventListener('abort', () => {
            controller.error(new DOMException('aborted', 'AbortError'));
          });
        },
      });
      return Promise.resolve(new Response(body, { status: 200 }));
    }) as typeof fetch;

    await expect(fetchRawContent('https://example.com/slow', { timeoutMs: 20 }))
      .rejects.toThrow('Fetch timed out after 20ms');
  });

  it('parses Retry-After seconds and HTTP dates', () => {
    expect(parseRetryAfter('3', 0)).toBe(3000);
    expect(parseRetryAfter('Thu, 01 Jan 1970 00:00:10 GMT', 1000)).toBe(9000);
    expect(parseRetryAfter('invalid', 0)).toBeNull();
  });
});
