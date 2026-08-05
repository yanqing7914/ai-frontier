import { parseFeed } from '../../../server/modules/collector/parsers';
import { parseRssFeed } from '../../../server/modules/collector/parsers/rss-parser';
import { parseApiFeed } from '../../../server/modules/collector/parsers/api-parser';
import { parseWebFeed } from '../../../server/modules/collector/parsers/web-parser';

jest.mock('rss-parser', () => {
  return jest.fn().mockImplementation(() => ({
    parseURL: jest.fn().mockImplementation((url: string) => {
      if (url.includes('error')) {
        return Promise.reject(new Error('Network error'));
      }
      if (url.includes('empty')) {
        return Promise.resolve({ items: [] });
      }
      return Promise.resolve({
        items: [
          {
            title: 'GPT-5 Released by OpenAI',
            link: 'https://openai.com/gpt5',
            pubDate: '2026-01-15T10:00:00Z',
            content: '<p>OpenAI announced GPT-5 with significant improvements in reasoning and multimodal capabilities.</p>',
            contentSnippet: 'OpenAI announced GPT-5 with significant improvements.',
          },
          {
            title: 'Claude 4 Launch',
            link: 'https://anthropic.com/claude4',
            pubDate: '2026-02-01T08:00:00Z',
            content: '<p>Anthropic released Claude 4 with enhanced safety features.</p>',
          },
          {
            title: '',
            link: 'https://example.com/no-title',
            content: 'Item without title should be skipped',
          },
        ],
      });
    }),
  }));
});

const originalFetch = global.fetch;
beforeAll(() => {
  global.fetch = jest.fn().mockImplementation((url: string, opts?: RequestInit) => {
    if (typeof url === 'string') {
      if (url.includes('api-items')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve({
            items: [
              { title: 'New GPU Architecture', url: 'https://nvidia.com/gpu', content: 'NVIDIA announces H200', publishedAt: '2026-03-01T00:00:00Z' },
              { title: 'Cloud Expansion', url: 'https://aws.com/news', description: 'AWS opens new data centers', date: '2026-03-02' },
              { title: '', url: 'https://example.com/skip', content: 'No title' },
            ],
          }),
        });
      }
      if (url.includes('api-results')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve({
            results: [
              { headline: 'Agent Framework v2', link: 'https://langchain.com/v2', summary: 'Multi-agent orchestration', created_at: '2026-04-01T12:00:00Z' },
            ],
          }),
        });
      }
      if (url.includes('api-error')) {
        return Promise.resolve({ ok: false, status: 500 });
      }
      if (url.includes('web-article')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          text: () => Promise.resolve(`
            <html>
              <head>
                <title>AI Safety Guidelines Published</title>
                <link rel="canonical" href="https://example.com/ai-safety" />
                <meta property="og:url" content="https://example.com/ai-safety" />
                <meta property="og:description" content="New AI safety guidelines adopted globally" />
                <script type="application/ld+json">{"datePublished": "2026-05-01T09:00:00Z", "@type": "Article"}</script>
              </head>
              <body>
                <article>
                  <p>The global AI safety framework was adopted by 50 countries today.</p>
                  <p>This represents a significant milestone in AI governance and regulation.</p>
                </article>
              </body>
            </html>
          `),
        });
      }
      if (url.includes('web-no-title')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          text: () => Promise.resolve('<html><body><p>Just content, no title</p></body></html>'),
        });
      }
    }
    return Promise.reject(new Error(`Unexpected fetch: ${url}`));
  }) as typeof fetch;
});

afterAll(() => {
  global.fetch = originalFetch;
});

describe('RSS Parser', () => {
  it('parses RSS feed and returns items', async () => {
    const result = await parseRssFeed('https://example.com/feed.xml');
    expect(result.items).toHaveLength(2);
    expect(result.items[0].title).toBe('GPT-5 Released by OpenAI');
    expect(result.items[0].url).toBe('https://openai.com/gpt5');
    expect(result.items[0].content).toContain('OpenAI announced GPT-5');
    expect(result.items[0].publishedAt).toBeInstanceOf(Date);
  });

  it('skips items without title', async () => {
    const result = await parseRssFeed('https://example.com/feed.xml');
    const noTitle = result.items.find((i) => i.url === 'https://example.com/no-title');
    expect(noTitle).toBeUndefined();
  });

  it('returns error for failed fetch', async () => {
    const result = await parseRssFeed('https://error.example.com/feed.xml');
    expect(result.items).toHaveLength(0);
    expect(result.error).toBeDefined();
  });

  it('returns empty for feed with no items', async () => {
    const result = await parseRssFeed('https://empty.example.com/feed.xml');
    expect(result.items).toHaveLength(0);
  });
});

describe('API Parser', () => {
  it('parses JSON API with items array', async () => {
    const result = await parseApiFeed('https://api.example.com/api-items');
    expect(result.items).toHaveLength(2);
    expect(result.items[0].title).toBe('New GPU Architecture');
    expect(result.items[0].url).toBe('https://nvidia.com/gpu');
    expect(result.items[0].content).toBe('NVIDIA announces H200');
  });

  it('parses JSON API with results array and alternate field names', async () => {
    const result = await parseApiFeed('https://api.example.com/api-results');
    expect(result.items).toHaveLength(1);
    expect(result.items[0].title).toBe('Agent Framework v2');
    expect(result.items[0].url).toBe('https://langchain.com/v2');
  });

  it('returns error for HTTP non-2xx', async () => {
    const result = await parseApiFeed('https://api.example.com/api-error');
    expect(result.items).toHaveLength(0);
    expect(result.error).toContain('HTTP 500');
  });
});

describe('Web Parser', () => {
  it('extracts title, canonical URL, and content from HTML', async () => {
    const result = await parseWebFeed('https://example.com/web-article');
    expect(result.items).toHaveLength(1);
    expect(result.items[0].title).toBe('AI Safety Guidelines Published');
    expect(result.items[0].url).toBe('https://example.com/ai-safety');
    expect(result.items[0].canonicalUrl).toBe('https://example.com/ai-safety');
    expect(result.items[0].publishedAt).toBeInstanceOf(Date);
  });

  it('returns error when no title found', async () => {
    const result = await parseWebFeed('https://example.com/web-no-title');
    expect(result.items).toHaveLength(0);
    expect(result.error).toContain('No title');
  });
});

describe('parseFeed dispatcher', () => {
  it('dispatches rss to RSS parser', async () => {
    const result = await parseFeed('rss', 'https://example.com/feed.xml');
    expect(result.items.length).toBeGreaterThan(0);
  });

  it('dispatches atom to RSS parser', async () => {
    const result = await parseFeed('atom', 'https://example.com/feed.xml');
    expect(result.items.length).toBeGreaterThan(0);
  });

  it('dispatches api to API parser', async () => {
    const result = await parseFeed('api', 'https://api.example.com/api-items');
    expect(result.items.length).toBeGreaterThan(0);
  });

  it('dispatches web to Web parser', async () => {
    const result = await parseFeed('web', 'https://example.com/web-article');
    expect(result.items.length).toBeGreaterThan(0);
  });

  it('returns error for unsupported feed_type', async () => {
    const result = await parseFeed('unknown', 'https://example.com');
    expect(result.items).toHaveLength(0);
    expect(result.error).toContain('Unsupported');
  });
});
