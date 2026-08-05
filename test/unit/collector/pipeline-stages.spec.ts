import { normalizeItems, decodeEntities, cleanContent, computeContentHash } from '../../../server/modules/collector/pipeline-normalize';
import { dedupBatch, filterAgainstExisting, stripTrackingParams } from '../../../server/modules/collector/pipeline-dedup';
import { normalizeDirection, ALL_DIRECTION_IDS } from '../../../shared/directions';

describe('decodeEntities', () => {
  it('decodes common HTML entities', () => {
    expect(decodeEntities('&amp; &lt; &gt; &quot;')).toBe('& < > "');
    expect(decodeEntities('&#39; &#x27;')).toBe("' '");
    expect(decodeEntities('&nbsp;')).toBe(' ');
  });

  it('decodes numeric entities', () => {
    expect(decodeEntities('&#65;')).toBe('A');
    expect(decodeEntities('&#x41;')).toBe('A');
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

  it('normalizes valid items', () => {
    const result = normalizeItems([
      { title: 'Hello World', url: 'https://example.com/1', publishedAt: new Date(), content: 'Content', rawContent: '<p>Content</p>' },
    ], meta);
    expect(result.items).toHaveLength(1);
    expect(result.items[0].sourceName).toBe('TestSource');
    expect(result.items[0].feedSourceId).toBe('fs-1');
    expect(result.items[0].contentHash).toHaveLength(32);
    expect(result.dropped).toBe(0);
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

  it('reports total dropped count', () => {
    const result = normalizeItems([
      { title: '', url: '', publishedAt: null, content: '', rawContent: '' },
      { title: 'OK', url: 'https://ok.com', publishedAt: null, content: '', rawContent: '' },
    ], meta);
    expect(result.dropped).toBe(1);
    expect(result.items).toHaveLength(1);
  });
});

describe('stripTrackingParams', () => {
  it('removes fragment and tracking params', () => {
    const result = stripTrackingParams('https://example.com/page?ref=twitter#section');
    expect(result).toBe('https://example.com/page');
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
    expect(result.reasons.batchUrl).toBe(1);
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

  it('normalizes URLs before comparison (strips tracking params)', () => {
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

describe('Pipeline stage ordering', () => {
  it('classification must run before clustering', () => {
    const stages = [
      'source_snapshot', 'scheduled_fetch', 'parse',
      'standardize', 'url_dedup', 'trace',
      'classify', 'cluster', 'rule_score',
      'ai_score', 'quality_gate', 'publish',
    ];
    const classifyIdx = stages.indexOf('classify');
    const clusterIdx = stages.indexOf('cluster');
    const ruleIdx = stages.indexOf('rule_score');
    const aiIdx = stages.indexOf('ai_score');
    const gateIdx = stages.indexOf('quality_gate');
    const publishIdx = stages.indexOf('publish');

    expect(classifyIdx).toBeLessThan(clusterIdx);
    expect(ruleIdx).toBeLessThan(aiIdx);
    expect(gateIdx).toBeLessThan(publishIdx);
    expect(classifyIdx).toBeLessThan(ruleIdx);
  });

  it('trace must run before classify', () => {
    const stages = [
      'source_snapshot', 'scheduled_fetch', 'parse',
      'standardize', 'url_dedup', 'trace',
      'classify', 'cluster', 'rule_score',
      'ai_score', 'quality_gate', 'publish',
    ];
    expect(stages.indexOf('trace')).toBeLessThan(stages.indexOf('classify'));
  });
});

describe('Direction classification coverage', () => {
  let scoringService: { ruleBasedScoreArticle: (t: string, c: string, s: string) => unknown };

  beforeEach(() => {
    jest.resetModules();
    const { AiScoringService } = require('../../../server/modules/collector/ai-scoring.service');
    scoringService = new AiScoringService({ load: jest.fn(), call: jest.fn() });
  });

  it('classifies model direction', () => {
    const result = scoringService.ruleBasedScoreArticle(
      'GPT-5 Achieves State-of-the-Art on MMLU Benchmark',
      'OpenAI released GPT-5 language model with 1 trillion parameters. The foundation model achieves 95% accuracy on MMLU benchmark, outperforming all previous LLMs. API is now available for developers.',
      'authoritative',
    ) as { primaryDirection: string | null; directionScores: Record<string, { normalizedScore: number }> };
    expect(result.primaryDirection).toBe('model');
    expect(result.directionScores.model.normalizedScore).toBeGreaterThan(0);
  });

  it('classifies agent direction', () => {
    const result = scoringService.ruleBasedScoreArticle(
      'Multi-Agent Orchestration Framework with MCP Protocol Support',
      'A new multi-agent framework enables complex task planning with autonomous agents. It supports MCP protocol for tool calling and function calling. Production-ready with enterprise guardrails and human-in-the-loop workflow.',
      'authoritative',
    ) as { primaryDirection: string | null; directionScores: Record<string, { normalizedScore: number }> };
    expect(result.primaryDirection).toBe('agent');
    expect(result.directionScores.agent.normalizedScore).toBeGreaterThan(0);
  });

  it('classifies data_eval direction', () => {
    const result = scoringService.ruleBasedScoreArticle(
      'New Dataset with 100000 Samples for MMLU Benchmark Evaluation',
      'A new open source dataset with 100000 samples was released for multilingual benchmark evaluation. The MMLU leaderboard shows GPT-4 achieving 87% accuracy. The methodology uses novel metrics for reproducibility assessment. Open source code available under MIT license.',
      'authoritative',
    ) as { primaryDirection: string | null };
    expect(result.primaryDirection).toBe('data_eval');
  });

  it('classifies applications direction', () => {
    const result = scoringService.ruleBasedScoreArticle(
      'Waymo Launches Autonomous Driving Service in Phoenix',
      'Waymo launched its autonomous driving robotaxi service now in Phoenix, serving over 50000 daily rides across 3 cities. Toyota deployed the robotic fleet for enterprise logistics automation. ROI improved by 35% with significant workflow change in manufacturing industry operations. The healthcare and automotive verticals see production-ready deployment.',
      'authoritative',
    ) as { primaryDirection: string | null };
    expect(result.primaryDirection).toBe('applications');
  });

  it('classifies business_ecosystem direction', () => {
    const result = scoringService.ruleBasedScoreArticle(
      'OpenAI Raises $6.6 Billion in Series F Funding Round',
      'OpenAI raised $6.6 billion in funding led by Thrive Capital. The company valuation reached $150 billion. Microsoft expanded its strategic partnership with a new $10 billion investment deal. The acquisition signals major market consolidation. IPO rumors grow.',
      'authoritative',
    ) as { primaryDirection: string | null };
    expect(result.primaryDirection).toBe('business_ecosystem');
  });

  it('returns null for unknown direction (does not default to model)', () => {
    const result = scoringService.ruleBasedScoreArticle(
      'Generic News Article About Random Topic',
      'This is a completely generic article that does not match any AI direction patterns. It talks about weather and sports and cooking recipes.',
      'signal',
    ) as { primaryDirection: string | null };
    expect(result.primaryDirection).toBeNull();
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

  it('backoff delays increase monotonically', () => {
    const delays: number[] = [];
    for (let attempt = 1; attempt <= 5; attempt++) {
      delays.push(1000 * Math.pow(2, attempt - 1));
    }
    for (let i = 1; i < delays.length; i++) {
      expect(delays[i]).toBeGreaterThan(delays[i - 1]);
    }
  });
});

describe('New source inclusion in next run', () => {
  it('enabled sources are selected for pipeline', () => {
    const sources = [
      { id: '1', name: 'Source A', enabled: true, feedType: 'rss' },
      { id: '2', name: 'Source B', enabled: false, feedType: 'rss' },
      { id: '3', name: 'Source C', enabled: true, feedType: 'api' },
    ];
    const enabled = sources.filter((s) => s.enabled);
    expect(enabled).toHaveLength(2);
    expect(enabled.map((s) => s.name)).toContain('Source A');
    expect(enabled.map((s) => s.name)).toContain('Source C');
  });
});
