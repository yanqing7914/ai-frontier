import {
  CONTRACT_PIPELINE_STAGES,
  POST_PROCESSING_ROLES,
  ROLE_CONTRACTS,
  buildSourceSnapshot,
  computeRoleIdempotencyKey,
  evaluateContent,
  explainFeatured,
  filterContent,
  runContentEvaluation,
  runContentFilter,
  organizeBody,
  processChinese,
  recognizeEvent,
  clusterSemantics,
  reviewEvent,
  runRoleContract,
  type ContractArticleInput,
} from '../../../server/modules/collector/architecture/contracts';

const article: ContractArticleInput = {
  articleId: 'article-1',
  title: 'OpenAI launches new GPT-5 with 95% MMLU benchmark score',
  content: 'OpenAI launches new GPT-5 with 95% MMLU benchmark score. The model is deployed through an API for developers and teams, with production users reporting lower latency.',
  url: 'https://openai.com/index/gpt-5',
  sourceName: 'OpenAI',
  sourceTier: 'authoritative',
};

describe('post-processing architecture contracts', () => {
  it('preserves the existing 12-stage order and defines exactly eight roles', () => {
    expect(CONTRACT_PIPELINE_STAGES).toHaveLength(12);
    expect([...CONTRACT_PIPELINE_STAGES]).toEqual([
      'source_ingest', 'scheduled_fetch', 'parse', 'normalize', 'url_dedup', 'trace',
      'classify', 'cluster', 'rule_score', 'ai_score', 'quality_gate', 'publish_outputs',
    ]);
    expect(POST_PROCESSING_ROLES).toHaveLength(8);
    for (const role of POST_PROCESSING_ROLES) expect(ROLE_CONTRACTS[role]).toBeDefined();
  });

  it('creates a stable source snapshot and deterministic idempotency keys', () => {
    const snapshot = buildSourceSnapshot({ ...article, content: '  same   content  ' });
    expect(snapshot.content).toBe('same   content');
    expect(computeRoleIdempotencyKey('content_evaluator', article))
      .toBe(computeRoleIdempotencyKey('content_evaluator', { ...article, content: article.content }));
    expect(computeRoleIdempotencyKey('semantic_clusterer', article, 'cluster-a'))
      .not.toBe(computeRoleIdempotencyKey('semantic_clusterer', article, 'cluster-b'));
  });

  it('fails closed for missing title, empty body, and short content', () => {
    const missing = filterContent(buildSourceSnapshot({ ...article, title: '' }));
    expect(missing.output).toMatchObject({ decision: 'reject', reasonCode: 'missing_title' });
    expect(missing.output.reason).toBeTruthy();
    expect(missing.output.sourceUrl).toBe(article.url);
    const empty = filterContent(buildSourceSnapshot({ ...article, content: '' }));
    expect(empty.output).toMatchObject({ decision: 'reject', reasonCode: 'empty_body' });
    const short = filterContent(buildSourceSnapshot({ ...article, content: 'too short' }));
    expect(short.output).toMatchObject({ decision: 'review', reasonCode: 'too_short' });
  });

  it('classifies AI candidates, spam, non-AI text, and stale content with source evidence', () => {
    const candidate = runContentFilter({
      ...article,
      title: 'OpenAI releases GPT-5 model',
      content: 'OpenAI releases GPT-5 model for developers. The model is available through an API and improves benchmark results for production use.',
    }, { asOf: '2026-08-27T00:00:00Z' });
    expect(candidate.outcome).toBe('accepted');
    expect(candidate.output.decision).toBe('candidate');
    expect(candidate.output.quote).toBeTruthy();
    expect(candidate.evidence[0]).toMatchObject({ sourceField: 'title' });
    expect(candidate.idempotencyKey).toMatch(/^pp_content_filter_v1_/);

    const spam = runContentFilter({
      ...article,
      title: 'Casino promotion',
      content: 'Casino promotion: guaranteed profit, contact us on WeChat.',
    }, { asOf: '2026-08-27T00:00:00Z' });
    expect(spam.output).toMatchObject({ decision: 'reject', reasonCode: 'spam' });
    expect(spam.evidence[0].quote).toContain('Casino');

    const nonAi = runContentFilter({
      ...article,
      title: 'Quarterly gardening notes',
      content: 'The garden received rain and the tomatoes are growing well this week.',
    }, { asOf: '2026-08-27T00:00:00Z' });
    expect(nonAi.output).toMatchObject({ decision: 'reject', reasonCode: 'non_ai' });

    const stale = runContentFilter({
      ...article,
      publishedAt: '2024-01-01T00:00:00Z',
      content: 'OpenAI released a language model with an API for developers and teams. This article documents the model launch and benchmark results in detail.',
    }, { asOf: '2026-08-27T00:00:00Z', staleAfterDays: 365 });
    expect(stale.outcome).toBe('review');
    expect(stale.output).toMatchObject({ decision: 'review', reasonCode: 'stale_content' });
    expect(stale.output.ageDays).toBeGreaterThan(365);
  });

  it('rejects invalid filter execution dates instead of accepting input', () => {
    const result = runContentFilter(article, { asOf: 'not-a-date' });
    expect(result.outcome).toBe('rejected');
    expect(result.output.decision).toBe('reject');
    expect(result.diagnostics[0]).toMatchObject({ code: 'processor_error', recoverable: true, role: 'content_filter' });
  });

  it('runs pure role helpers with evidence and event/cluster review', () => {
    const snapshot = buildSourceSnapshot(article);
    const filtered = filterContent(snapshot, { asOf: '2026-08-27T00:00:00Z' });
    const evaluation = evaluateContent(snapshot, filtered.output);
    expect(evaluation.output.score).toBeGreaterThanOrEqual(70);
    expect(evaluation.output.overall).toBe(evaluation.output.score);
    expect(evaluation.output.publishEligible).toBe(true);
    expect(evaluation.output.reviewReasons).toEqual([]);
    expect(Object.keys(evaluation.output.dimensions)).toEqual([
      'relevance', 'novelty', 'credibility', 'impact', 'verifiability',
    ]);
    expect(evaluation.output.evidence).toHaveLength(5);
    for (const item of evaluation.output.evidence) {
      const source = item.sourceField === 'title' ? snapshot.title : snapshot.content;
      expect(source.slice(item.span.start, item.span.end)).toBe(item.quote);
      expect(item.source).toBe(snapshot.url);
      expect(item.date).toBe(snapshot.publishedAt);
    }
    expect(evaluation.evidence[0].quote).toBeTruthy();
    const envelope = runContentEvaluation(article, filtered.output);
    expect(envelope.outcome).toBe('accepted');
    expect(envelope.diagnostics.some((item) => item.code === 'invalid_evidence')).toBe(false);

    const event = recognizeEvent(snapshot);
    const cluster = clusterSemantics(snapshot, event.output);
    const review = reviewEvent(event.output, cluster);
    expect(event.output.eventType).toBe('release');
    expect(cluster.clusterKey).toMatch(/^evt_/);
    expect(review.decision).toBe('approve');

    const chinese = processChinese(snapshot);
    expect(chinese.language).toBe('non_zh');
    const body = organizeBody(snapshot);
    expect(body.paragraphCount).toBeGreaterThan(0);
  });

  it('downgrades negation, rumor, future, and marketing language', () => {
    const uncertain = {
      ...article,
      articleId: 'article-uncertain',
      title: 'Rumor: OpenAI may launch a revolutionary GPT model',
      content: 'Unconfirmed sources say OpenAI may launch a revolutionary GPT model next month. It will be the most powerful model, but it does not have published benchmark results.',
    };
    const snapshot = buildSourceSnapshot(uncertain);
    const filtered = filterContent(snapshot, { asOf: '2026-08-27T00:00:00Z' });
    const evaluation = evaluateContent(snapshot, filtered.output);
    expect(evaluation.output.publishEligible).toBe(false);
    expect(evaluation.output.decision).toBe('review');
    expect(evaluation.output.reviewReasons).toEqual(expect.arrayContaining([
      'negated_claim', 'rumor_or_hearsay', 'future_or_planned', 'marketing_language',
    ]));
  });

  it('fails to review when evidence is insufficient', () => {
    const sparse = {
      ...article,
      articleId: 'article-sparse',
      title: 'OpenAI GPT model update',
      content: 'OpenAI shared an AI model update.',
    };
    const filtered = runContentFilter(sparse, { asOf: '2026-08-27T00:00:00Z' });
    const evaluation = runContentEvaluation(sparse, filtered.output);
    expect(evaluation.outcome).toBe('review');
    expect(evaluation.output.publishEligible).toBe(false);
    expect(evaluation.output.reviewReasons).toContain('insufficient_evidence');
    expect(evaluation.diagnostics).toContainEqual(expect.objectContaining({ code: 'insufficient_evidence' }));
  });

  it('preserves fallback output and records a review diagnostic on processor errors', () => {
    const result = runRoleContract(
      'event_reviewer',
      article,
      () => { throw new Error('provider unavailable'); },
      { decision: 'review', reasonCode: 'weak_signal', clusterKey: null },
    );
    expect(result.outcome).toBe('review');
    expect(result.output.reasonCode).toBe('weak_signal');
    expect(result.diagnostics[0]).toMatchObject({ code: 'processor_error', recoverable: true, role: 'event_reviewer' });
    expect(result.idempotencyKey).toMatch(/^pp_event_reviewer_v1_/);
  });

  it('rejects evidence that is not grounded in the immutable snapshot', () => {
    const result = runRoleContract(
      'featured_explainer',
      article,
      (snapshot) => ({
        output: explainFeatured(snapshot, { score: 90, overall: 90, dimensions: { relevance: 20, novelty: 20, credibility: 15, impact: 20, verifiability: 15 }, decision: 'pass', publishEligible: true, reviewReasons: [], evidence: [] }, { decision: 'approve', reasonCode: 'consistent', clusterKey: 'evt_x' }).output,
        evidence: [{
          evidenceId: 'fake', sourceField: 'content', quote: 'not in source', subject: 'x', predicate: 'x', object: 'x',
          certainty: 'fact', confidence: 1, fields: {},
        }],
      }),
      { featured: false, explanation: '', score: 0, direction: null },
    );
    expect(result.outcome).toBe('review');
    expect(result.diagnostics.some((item) => item.code === 'ungrounded_quote')).toBe(true);
  });
});
