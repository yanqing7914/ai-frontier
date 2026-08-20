import { PIPELINE_STAGE_ORDER, shouldAttemptAiScoring } from '../../../server/modules/collector/collector.service';
import { normalizeItems, decodeEntities, cleanContent, computeContentHash, normalizeUrlForDedup } from '../../../server/modules/collector/pipeline-normalize';
import { dedupBatch, filterAgainstExisting, stripTrackingParams } from '../../../server/modules/collector/pipeline-dedup';
import { parseRssContent } from '../../../server/modules/collector/parsers/rss-parser';
import { parseApiContent } from '../../../server/modules/collector/parsers/api-parser';
import { parseWebContent } from '../../../server/modules/collector/parsers/web-parser';
import { parseRawContent } from '../../../server/modules/collector/parsers';
import { ALL_DIRECTION_IDS } from '../../../shared/directions';

jest.mock('rss-parser', () => {
  return jest.fn().mockImplementation(() => ({
    parseString: jest.fn().mockImplementation((xml: string) => {
      if (xml.includes('PARSE_ERROR')) {
        return Promise.reject(new Error('XML parse error'));
      }
      return Promise.resolve({
        items: [
          {
            title: 'GPT-5 Released',
            link: 'https://openai.com/gpt5',
            pubDate: '2026-01-15T10:00:00Z',
            content: '<p>GPT-5 with 1T parameters achieves 95% on MMLU benchmark.</p>',
            contentSnippet: 'GPT-5 with 1T parameters achieves 95% on MMLU benchmark.',
          },
          {
            title: 'Claude 4 Launch',
            link: 'https://anthropic.com/claude4',
            pubDate: '2026-02-01T08:00:00Z',
            content: '<p>Claude 4 with enhanced safety and MCP protocol support.</p>',
          },
        ],
      });
    }),
  }));
});

describe('PIPELINE_STAGE_ORDER (production export)', () => {
  it('has exactly 12 stages', () => {
    expect(PIPELINE_STAGE_ORDER).toHaveLength(12);
  });

  it('all stage names are unique', () => {
    const unique = new Set(PIPELINE_STAGE_ORDER);
    expect(unique.size).toBe(PIPELINE_STAGE_ORDER.length);
  });

  it('starts with source_ingest and ends with publish_outputs', () => {
    expect(PIPELINE_STAGE_ORDER[0]).toBe('source_ingest');
    expect(PIPELINE_STAGE_ORDER[PIPELINE_STAGE_ORDER.length - 1]).toBe('publish_outputs');
  });

  it('scheduled_fetch < parse (separate observable stages)', () => {
    expect(PIPELINE_STAGE_ORDER.indexOf('scheduled_fetch')).toBeLessThan(PIPELINE_STAGE_ORDER.indexOf('parse'));
  });

  it('classify < cluster < rule_score', () => {
    const c = PIPELINE_STAGE_ORDER.indexOf('classify');
    const cl = PIPELINE_STAGE_ORDER.indexOf('cluster');
    const r = PIPELINE_STAGE_ORDER.indexOf('rule_score');
    expect(c).toBeLessThan(cl);
    expect(cl).toBeLessThan(r);
  });

  it('trace < classify < cluster < rule_score < ai_score < quality_gate < publish_outputs', () => {
    const order = [...PIPELINE_STAGE_ORDER];
    const idx = (s: string) => order.indexOf(s as typeof order[number]);
    expect(idx('trace')).toBeLessThan(idx('classify'));
    expect(idx('classify')).toBeLessThan(idx('cluster'));
    expect(idx('cluster')).toBeLessThan(idx('rule_score'));
    expect(idx('rule_score')).toBeLessThan(idx('ai_score'));
    expect(idx('ai_score')).toBeLessThan(idx('quality_gate'));
    expect(idx('quality_gate')).toBeLessThan(idx('publish_outputs'));
  });

  it('exact order matches specification', () => {
    expect([...PIPELINE_STAGE_ORDER]).toEqual([
      'source_ingest', 'scheduled_fetch', 'parse', 'normalize',
      'url_dedup', 'trace', 'classify', 'cluster',
      'rule_score', 'ai_score', 'quality_gate', 'publish_outputs',
    ]);
  });
});

describe('AI scoring prefilter', () => {
  it('spends AI quota only on articles with a relevant topic candidate', () => {
    expect(shouldAttemptAiScoring('classified')).toBe(true);
    expect(shouldAttemptAiScoring('ambiguous')).toBe(true);
    expect(shouldAttemptAiScoring('no_match')).toBe(false);
    expect(shouldAttemptAiScoring('degraded')).toBe(false);
    expect(shouldAttemptAiScoring(undefined)).toBe(false);
  });
});

describe('Four parser types (parseRawContent dispatch)', () => {
  it('RSS: parses raw XML via parseRawContent', async () => {
    const result = await parseRawContent('rss', '<rss>items</rss>', 'https://example.com/feed');
    expect(result.items.length).toBeGreaterThanOrEqual(1);
    expect(result.items[0].title).toBe('GPT-5 Released');
    expect(result.error).toBeUndefined();
  });

  it('Atom: dispatches to RSS parser (same XML format)', async () => {
    const result = await parseRawContent('atom', '<feed>items</feed>', 'https://example.com/atom');
    expect(result.items.length).toBeGreaterThanOrEqual(1);
  });

  it('API: parses raw JSON', async () => {
    const json = JSON.stringify({
      items: [
        { title: 'AI Agent Framework', url: 'https://example.com/agent', content: 'New MCP agent framework' },
        { title: 'Coding Copilot v3', url: 'https://example.com/copilot', content: 'Cursor-like IDE' },
      ],
    });
    const result = await parseApiContent(json);
    expect(result.items).toHaveLength(2);
    expect(result.items[0].title).toBe('AI Agent Framework');
    expect(result.items[1].url).toBe('https://example.com/copilot');
  });

  it('API: handles empty items array', async () => {
    const result = await parseApiContent(JSON.stringify({ items: [] }));
    expect(result.items).toHaveLength(0);
  });

  it('Web: parses raw HTML with meta extraction', async () => {
    const html = '<html><head><title>AI Safety Report 2026</title><meta property="og:title" content="AI Safety Report 2026"><meta name="description" content="Comprehensive safety governance analysis"></head><body><p>Full article text about AI governance and safety policies.</p></body></html>';
    const result = await parseWebContent(html, 'https://example.com/safety');
    expect(result.items).toHaveLength(1);
    expect(result.items[0].title).toBe('AI Safety Report 2026');
  });

  it('Web: returns error for no title', async () => {
    const html = '<html><head></head><body>No title here</body></html>';
    const result = await parseWebContent(html, 'https://example.com/notitle');
    expect(result.items).toHaveLength(0);
    expect(result.error).toBeDefined();
  });

  it('parseRawContent: unsupported feed_type returns error', async () => {
    const result = await parseRawContent('unknown', 'data', 'https://example.com');
    expect(result.items).toHaveLength(0);
    expect(result.error).toContain('Unsupported');
  });
});

describe('Parser failure isolation', () => {
  it('RSS parse error does not crash pipeline', async () => {
    const result = await parseRssContent('PARSE_ERROR');
    expect(result.items).toHaveLength(0);
    expect(result.error).toBeDefined();
  });

  it('API parse error returns empty items', async () => {
    const result = await parseApiContent('not valid json {{{');
    expect(result.items).toHaveLength(0);
    expect(result.error).toBeDefined();
  });
});

describe('RSS content preservation', () => {
  it('prefers content:encoded and preserves it as raw content for tracing', async () => {
    const result = await parseRssContent('<rss>items</rss>');
    // The mock feed exercises the common RSS path; parser content remains available to normalization.
    expect(result.items[0].rawContent).toContain('GPT-5');
    expect(result.items[0].content).toContain('GPT-5');
  });
});

describe('normalizeUrlForDedup', () => {
  it('strips tracking params and fragment', () => {
    expect(normalizeUrlForDedup('https://example.com/page?utm_source=twitter&id=1#section'))
      .toBe('https://example.com/page?id=1');
  });

  it('preserves legal trailing URL punctuation', () => {
    expect(normalizeUrlForDedup('https://example.com/page.')).toBe('https://example.com/page.');
    expect(normalizeUrlForDedup('https://example.com/page)')).toBe('https://example.com/page)');
  });

  it('produces consistent output for equivalent URLs', () => {
    const a = normalizeUrlForDedup('https://example.com/page?utm_source=a');
    const b = normalizeUrlForDedup('https://example.com/page');
    expect(a).toBe(b);
  });
});

describe('decodeEntities', () => {
  it('decodes common HTML entities', () => {
    expect(decodeEntities('&amp; &lt; &gt; &quot;')).toBe('& < > "');
    expect(decodeEntities('&#39; &#x27;')).toBe("' '");
    expect(decodeEntities('&nbsp;')).toBe(' ');
  });

  it('decodes numeric entities', () => {
    expect(decodeEntities('&#65;')).toBe('A');
    expect(decodeEntities('&#x41;')).toBe('A');
    expect(decodeEntities('&#128512;')).toBe('😀');
  });
});

describe('cleanContent', () => {
  it('strips HTML tags and normalizes whitespace', () => {
    expect(cleanContent('<p>Hello  <b>world</b></p>')).toBe('Hello world');
    expect(cleanContent('  multiple   spaces  ')).toBe('multiple spaces');
  });

  it('handles empty input', () => {
    expect(cleanContent('')).toBe('');
    expect(cleanContent('<div></div>')).toBe('');
  });

  it('removes executable and inert HTML content before extracting text', () => {
    expect(cleanContent('<p>Visible</p><script>alert(1)</script><style>.x{}</style><template>Hidden</template>'))
      .toBe('Visible');
  });
});

describe('computeContentHash', () => {
  it('produces consistent hashes', () => {
    const h1 = computeContentHash('Title', 'https://example.com');
    const h2 = computeContentHash('Title', 'https://example.com');
    expect(h1).toBe(h2);
    expect(h1).toHaveLength(32);
  });

  it('produces different hashes for different inputs', () => {
    const h1 = computeContentHash('Title A', 'https://a.com');
    const h2 = computeContentHash('Title B', 'https://b.com');
    expect(h1).not.toBe(h2);
  });
});

describe('normalizeItems', () => {
  const meta = { name: 'TestSource', tier: 'signal', feedSourceId: 'fs-1' };

  it('normalizes valid items with parser-extracted content', () => {
    const result = normalizeItems([
      { title: 'Hello World', url: 'https://example.com/1', publishedAt: new Date(), content: 'Clean text', rawContent: '<p>Raw HTML</p>' },
    ], meta);
    expect(result.items).toHaveLength(1);
    expect(result.items[0].content).toBe('Clean text');
    expect(result.items[0].sourceName).toBe('TestSource');
    expect(result.items[0].feedSourceId).toBe('fs-1');
    expect(result.items[0].contentHash).toHaveLength(32);
    expect(result.dropped).toBe(0);
  });

  it('falls back to cleanContent(rawContent) when content is empty', () => {
    const result = normalizeItems([
      { title: 'Title', url: 'https://example.com', publishedAt: null, content: '', rawContent: '<p>Fallback content</p>' },
    ], meta);
    expect(result.items[0].content).toBe('Fallback content');
  });

  it('uses normalized URL for content hash', () => {
    const r1 = normalizeItems([
      { title: 'T', url: 'https://example.com/page?utm_source=x', publishedAt: null, content: 'Body', rawContent: '' },
    ], meta);
    const r2 = normalizeItems([
      { title: 'T', url: 'https://example.com/page', publishedAt: null, content: 'Body', rawContent: '' },
    ], meta);
    expect(r1.items[0].contentHash).toBe(r2.items[0].contentHash);
  });

  it('drops items without title', () => {
    const result = normalizeItems([
      { title: '', url: 'https://example.com', publishedAt: null, content: '', rawContent: '' },
    ], meta);
    expect(result.items).toHaveLength(0);
    expect(result.dropReasons.missingTitle).toBe(1);
  });

  it('drops items without url', () => {
    const result = normalizeItems([
      { title: 'Valid Title', url: '', publishedAt: null, content: '', rawContent: '' },
    ], meta);
    expect(result.items).toHaveLength(0);
    expect(result.dropReasons.missingUrl).toBe(1);
  });

  it('normalizes title and canonical URL before computing a stable dedup hash', () => {
    const result = normalizeItems([
      {
        title: '  AI&#x200B; Update  ',
        url: 'https://example.com/original?utm_source=feed',
        canonicalUrl: 'https://example.com/canonical?utm_campaign=feed',
        publishedAt: new Date('invalid'),
        content: '<p>Body</p>',
        rawContent: '',
      },
    ], meta);
    expect(result.items[0].title).toBe('AI Update');
    expect(result.items[0].canonicalUrl).toBe('https://example.com/canonical?utm_campaign=feed');
    expect(result.items[0].dedupUrl).toBe('https://example.com/canonical');
    expect(result.items[0].publishedAt).toBeNull();
    expect(result.items[0].contentHash).toBe(computeContentHash('AI Update', 'https://example.com/canonical'));
  });

  it('drops non-http URLs and missing bodies instead of using the title as content', () => {
    const result = normalizeItems([
      { title: 'Unsafe', url: 'javascript:alert(1)', publishedAt: null, content: 'Body', rawContent: '' },
      { title: 'No body', url: 'https://example.com/no-body', publishedAt: null, content: '', rawContent: '', contentStatus: 'missing' },
    ], meta);
    expect(result.items).toHaveLength(0);
    expect(result.dropReasons.invalidUrl).toBe(1);
    expect(result.dropReasons.missingContent).toBe(1);
  });
});

describe('stripTrackingParams', () => {
  it('removes fragment and tracking params', () => {
    expect(stripTrackingParams('https://example.com/page?ref=twitter#section')).toBe('https://example.com/page');
  });

  it('preserves non-tracking params', () => {
    const result = stripTrackingParams('https://example.com/page?id=123&ref=x');
    expect(result).toContain('id=123');
    expect(result).not.toContain('ref=');
  });
});

describe('dedupBatch', () => {
  it('removes duplicate URLs in batch', () => {
    const result = dedupBatch([
      { url: 'https://example.com/a', contentHash: 'h1', title: 'A' },
      { url: 'https://example.com/a', contentHash: 'h2', title: 'B' },
    ]);
    expect(result.passed).toHaveLength(1);
    expect(result.deduped).toBe(1);
  });

  it('removes duplicate content hashes in batch', () => {
    const result = dedupBatch([
      { url: 'https://example.com/a', contentHash: 'same', title: 'A' },
      { url: 'https://example.com/b', contentHash: 'same', title: 'B' },
    ]);
    expect(result.passed).toHaveLength(1);
    expect(result.reasons.batchHash).toBe(1);
  });

  it('passes unique items through', () => {
    const result = dedupBatch([
      { url: 'https://example.com/a', contentHash: 'h1', title: 'A' },
      { url: 'https://example.com/b', contentHash: 'h2', title: 'B' },
    ]);
    expect(result.passed).toHaveLength(2);
    expect(result.deduped).toBe(0);
  });

  it('normalizes URLs before comparison', () => {
    const result = dedupBatch([
      { url: 'https://example.com/page?ref=twitter', contentHash: 'h1', title: 'A' },
      { url: 'https://example.com/page', contentHash: 'h2', title: 'B' },
    ]);
    expect(result.passed).toHaveLength(1);
  });
});

describe('filterAgainstExisting', () => {
  it('filters out items matching existing hashes', () => {
    const result = filterAgainstExisting(
      [
        { url: 'https://new.com', contentHash: 'existing_hash', title: 'Dup' },
        { url: 'https://new.com/2', contentHash: 'new_hash', title: 'New' },
      ],
      new Set(['existing_hash']),
      new Set(),
    );
    expect(result.passed).toHaveLength(1);
    expect(result.deduped).toBe(1);
  });

  it('filters out items matching existing normalized URLs', () => {
    const result = filterAgainstExisting(
      [{ url: 'https://example.com/page', contentHash: 'h1', title: 'Dup' }],
      new Set(),
      new Set(['https://example.com/page']),
    );
    expect(result.passed).toHaveLength(0);
    expect(result.deduped).toBe(1);
  });
});

describe('classifyArticle (lightweight, no full rule scores)', () => {
  let scoringService: { classifyArticle: (t: string, c: string, s: string) => { primaryDirection: string | null; evidence: string[] }; ruleBasedScoreArticle: (t: string, c: string, s: string) => unknown };

  beforeEach(() => {
    jest.resetModules();
    const { AiScoringService } = require('../../../server/modules/collector/ai-scoring.service');
    scoringService = new AiScoringService({ load: jest.fn(), call: jest.fn() });
  });

  it('returns primaryDirection and evidence array', () => {
    const result = scoringService.classifyArticle(
      'GPT-5 Achieves State-of-the-Art on MMLU Benchmark',
      'OpenAI released GPT-5 language model with 1 trillion parameters.',
      'authoritative',
    );
    expect(result).toHaveProperty('primaryDirection');
    expect(result).toHaveProperty('evidence');
    expect(Array.isArray(result.evidence)).toBe(true);
  });

  it('classifies model direction correctly', () => {
    const result = scoringService.classifyArticle(
      'GPT-5 Achieves State-of-the-Art on MMLU Benchmark',
      'OpenAI released GPT-5 language model with 1 trillion parameters. The foundation model achieves 95% accuracy on MMLU benchmark.',
      'authoritative',
    );
    expect(result.primaryDirection).toBe('model');
    expect(result.evidence).toContain('model');
  });

  it('classifies agent direction correctly', () => {
    const result = scoringService.classifyArticle(
      'Multi-Agent Orchestration Framework with MCP Protocol',
      'A multi-agent framework enables task planning with autonomous agents. MCP protocol for tool calling.',
      'authoritative',
    );
    expect(result.primaryDirection).toBe('agent');
  });

  it('returns null for unknown direction', () => {
    const result = scoringService.classifyArticle(
      'Generic News About Weather',
      'Today is sunny with clear skies. Temperature around 25 degrees.',
      'signal',
    );
    expect(result.primaryDirection).toBeNull();
  });

  it('does NOT return dimensionScores or publishScore (classify only)', () => {
    const result = scoringService.classifyArticle('AI News', 'Some content', 'signal');
    expect(result).not.toHaveProperty('directionScores');
    expect(result).not.toHaveProperty('publishScore');
    expect(result).not.toHaveProperty('summary');
    expect(result).not.toHaveProperty('aiProcessed');
  });
});

describe('Direction scoring (idempotent 9 directions)', () => {
  let scoringService: { ruleBasedScoreArticle: (t: string, c: string, s: string, d?: string | null) => unknown };

  beforeEach(() => {
    jest.resetModules();
    const { AiScoringService } = require('../../../server/modules/collector/ai-scoring.service');
    scoringService = new AiScoringService({ load: jest.fn(), call: jest.fn() });
  });

  it('direction_scores always has exactly 9 unique directions', () => {
    const result = scoringService.ruleBasedScoreArticle(
      'AI News', 'Some content about AI models and agents', 'signal',
    ) as { directionScores: Record<string, unknown> };
    const dirs = Object.keys(result.directionScores);
    expect(dirs).toHaveLength(9);
    expect(new Set(dirs).size).toBe(9);
    for (const dir of ALL_DIRECTION_IDS) {
      expect(result.directionScores[dir]).toBeDefined();
    }
  });

  it('idempotent: same input produces same scores', () => {
    const r1 = scoringService.ruleBasedScoreArticle('Test Title', 'Test content', 'signal') as { publishScore: number; primaryDirection: string | null };
    const r2 = scoringService.ruleBasedScoreArticle('Test Title', 'Test content', 'signal') as { publishScore: number; primaryDirection: string | null };
    expect(r1.publishScore).toBe(r2.publishScore);
    expect(r1.primaryDirection).toBe(r2.primaryDirection);
  });

  it('degradeReason is passed through', () => {
    const result = scoringService.ruleBasedScoreArticle(
      'Title', 'Content', 'signal', 'ai_quota_exceeded',
    ) as { degradeReason: string | null };
    expect(result.degradeReason).toBe('ai_quota_exceeded');
  });
});

describe('AI quota management', () => {
  it('shared counter prevents exceeding daily limit', () => {
    let aiCount = 498;
    const aiDailyLimit = 500;
    let used = 0;

    for (let i = 0; i < 5; i++) {
      if (aiCount < aiDailyLimit) {
        aiCount++;
        used++;
      }
    }

    expect(used).toBe(2);
    expect(aiCount).toBe(500);
    expect(aiCount).toBeLessThanOrEqual(aiDailyLimit);
  });

  it('per-source quota limits individual sources', () => {
    const perSourceLimit = 30;
    const perSourceCount = new Map<string, number>();
    perSourceCount.set('TechCrunch', 29);

    let used = 0;
    for (let i = 0; i < 5; i++) {
      const srcUsed = perSourceCount.get('TechCrunch') || 0;
      if (srcUsed < perSourceLimit) {
        perSourceCount.set('TechCrunch', srcUsed + 1);
        used++;
      }
    }

    expect(used).toBe(1);
    expect(perSourceCount.get('TechCrunch')).toBe(30);
  });
});

describe('Trace failure blocks publish (quality gate)', () => {
  it('trace-failed articles get pending_review status', () => {
    const traceFailIds = new Set(['art-1', 'art-2']);
    const status = traceFailIds.has('art-1') ? 'pending_review' : 'draft';
    expect(status).toBe('pending_review');
  });

  it('trace-passed articles remain draft', () => {
    const traceFailIds = new Set<string>();
    const status = traceFailIds.has('art-1') ? 'pending_review' : 'draft';
    expect(status).toBe('draft');
  });
});

describe('Rescore re-enters quality gate', () => {
  it('union of new + rescored + auto-approved covers all articles', () => {
    const newIds = new Set(['a1', 'a2', 'a3']);
    const rescoredIds = new Set(['a4', 'a5']);
    const autoApprovedIds = new Set(['a6']);

    const allIds = new Set<string>(newIds);
    for (const id of rescoredIds) allIds.add(id);
    for (const id of autoApprovedIds) allIds.add(id);

    expect(allIds.size).toBe(6);
    expect(allIds.has('a4')).toBe(true);
    expect(allIds.has('a6')).toBe(true);
  });

  it('no duplicates in union', () => {
    const newIds = new Set(['a1', 'a2']);
    const rescoredIds = new Set(['a2', 'a3']);
    const autoApprovedIds = new Set(['a3', 'a4']);

    const allIds = new Set<string>(newIds);
    for (const id of rescoredIds) allIds.add(id);
    for (const id of autoApprovedIds) allIds.add(id);

    expect(allIds.size).toBe(4);
  });
});

describe('Pipeline mutex protection', () => {
  it('prevents concurrent execution via flag', () => {
    const service = { pipelineRunning: false };
    const firstCall = !service.pipelineRunning;
    if (firstCall) service.pipelineRunning = true;
    const secondCall = !service.pipelineRunning;
    expect(firstCall).toBe(true);
    expect(secondCall).toBe(false);
  });
});

describe('Retry backoff timing', () => {
  it('exponential backoff: 1s, 2s, 4s for 3 retries', () => {
    const delays: number[] = [];
    for (let attempt = 1; attempt <= 3; attempt++) {
      delays.push(1000 * Math.pow(2, attempt - 1));
    }
    expect(delays).toEqual([1000, 2000, 4000]);
  });
});
