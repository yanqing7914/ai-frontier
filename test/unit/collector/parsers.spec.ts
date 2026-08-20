import { parseFeed, parseRawContent } from '../../../server/modules/collector/parsers';
import { parseRssFeed } from '../../../server/modules/collector/parsers/rss-parser';
import { parseApiContent, parseApiFeed } from '../../../server/modules/collector/parsers/api-parser';
import { parseWebContent, parseWebFeed } from '../../../server/modules/collector/parsers/web-parser';

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
        url,
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
          url,
          headers: { get: () => 'application/json' },
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
          url,
          headers: { get: () => 'application/json' },
          json: () => Promise.resolve({
            results: [
              { headline: 'Agent Framework v2', link: 'https://langchain.com/v2', summary: 'Multi-agent orchestration', created_at: '2026-04-01T12:00:00Z' },
            ],
          }),
        });
      }
      if (url.includes('api-error')) {
        return Promise.resolve({ ok: false, status: 500, url, headers: { get: () => 'application/json' } });
      }
      if (url.includes('web-article')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          url,
          headers: { get: () => 'text/html' },
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
          url,
          headers: { get: () => 'text/html' },
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

  it('normalizes feed_type case and whitespace', async () => {
    const result = await parseFeed(' RSS ', 'https://example.com/feed.xml');
    expect(result.items).toHaveLength(2);
  });

  it('rejects declared parser/content mismatches with provenance', async () => {
    const result = await parseRawContent('api', '<html><body>not json</body></html>', 'https://example.com/api', {
      finalUrl: 'https://example.com/login', contentType: 'text/html', httpStatus: 200,
    });
    expect(result.items).toHaveLength(0);
    expect(result.error).toContain('does not match');
    expect(result.provenance).toMatchObject({
      sourceUrl: 'https://example.com/api', finalUrl: 'https://example.com/login',
      contentType: 'text/html', parserType: 'api', httpStatus: 200,
    });
  });
});

describe('Parser robustness', () => {
  it('resolves relative and protocol-relative API links while preserving originals', async () => {
    const result = await parseApiContent(JSON.stringify({ data: { items: [
      { title: 'Relative', url: '/news/1', content: 'Full article body', published: 1_700_000_000 },
      { title: 'Protocol relative', url: '//cdn.example.com/news/2', summary: 'Summary body' },
    ] } }), 'https://api.example.com/v1/feed');
    expect(result.items.map((item) => item.url)).toEqual([
      'https://api.example.com/news/1', 'https://cdn.example.com/news/2',
    ]);
    expect(result.items[0].originalUrl).toBe('/news/1');
    expect(result.items[0].publishedAt?.toISOString()).toBe('2023-11-14T22:13:20.000Z');
  });

  it('supports GraphQL edges/node and WordPress rendered fields', async () => {
    const result = await parseApiContent(JSON.stringify({ data: { posts: { edges: [
      { node: { title: { rendered: 'WP Headline' }, link: '/post', content: { rendered: '<p>WP full body</p>' }, date: '2026-07-01T10:00:00+08:00' } },
    ] } } }), 'https://cms.example.com/graphql');
    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({
      title: 'WP Headline', url: 'https://cms.example.com/post', content: 'WP full body', contentStatus: 'full',
    });
    expect(result.items[0].publishedAt?.toISOString()).toBe('2026-07-01T02:00:00.000Z');
  });

  it('returns an explicit error for unknown API structures', async () => {
    const result = await parseApiContent(JSON.stringify({ status: 'ok', total: 2 }));
    expect(result.items).toHaveLength(0);
    expect(result.error).toContain('Unrecognized API response structure');
  });

  it('keeps empty bodies missing instead of substituting the title', async () => {
    const result = await parseApiContent(JSON.stringify({ items: [
      { title: 'Headline only', url: 'https://example.com/item' },
    ] }));
    expect(result.items[0].content).toBe('');
    expect(result.items[0].contentStatus).toBe('missing');
    expect(result.items[0].warnings).toContain('body missing from API item');
  });

  it('reports partial success and item-level warnings', async () => {
    const result = await parseApiContent(JSON.stringify({ items: [
      { title: 'Valid', url: 'https://example.com/valid', content: 'Body' },
      { title: 'Unsafe', url: 'javascript:alert(1)', content: 'Body' },
      { url: '/missing-title', content: 'Body' },
    ] }), 'https://example.com/feed');
    expect(result.items).toHaveLength(1);
    expect(result.stats).toEqual({ input: 3, parsed: 1, skipped: 2 });
    expect(result.warnings).toHaveLength(2);
    expect(result.error).toBeUndefined();
  });

  it('extracts JSON-LD graph dates and prefers article body over SEO description', async () => {
    const html = `<html><head><title>Graph article</title>
      <link rel="canonical" href="/canonical">
      <meta name="description" content="SEO teaser">
      <script type="application/ld+json">{"@graph":[{"@type":"Article","datePublished":"2026-08-01T18:30:00+08:00"}]}</script>
      </head><body><nav>Navigation</nav><article>This is the reliable full article body with enough detail for extraction.</article></body></html>`;
    const result = await parseWebContent(html, 'https://example.com/original');
    expect(result.items[0].url).toBe('https://example.com/canonical');
    expect(result.items[0].content).toContain('reliable full article body');
    expect(result.items[0].content).not.toBe('SEO teaser');
    expect(result.items[0].publishedAt?.toISOString()).toBe('2026-08-01T10:30:00.000Z');
  });

  it.each([
    ['captcha', '<html><head><title>Security Check</title></head><body>Verify you are human CAPTCHA</body></html>'],
    ['soft404', '<html><head><title>Page not found 404</title></head><body>The page was not found.</body></html>'],
  ])('rejects %s pages', async (_name, html) => {
    const result = await parseWebContent(html, 'https://example.com/article');
    expect(result.items).toHaveLength(0);
    expect(result.error).toMatch(/captcha|soft-404/);
  });
});
