import { hasCoreEvidence, canPublishArticle, aggregateDirectionScores } from '../../../server/modules/collector/publish-gate';

describe('hasCoreEvidence', () => {
  it('returns true when enough application core dimensions have direct evidence', () => {
    const scores = { industry: 5, business_problem: 5, roi: 2.5 };
    expect(hasCoreEvidence(scores, 'applications')).toBe(true);
  });

  it('returns true when legacy LLM dimensions sum >= 10', () => {
    const scores = { novelty: 5, depth: 5, impact: 0, authority: 0, timeliness: 0 };
    expect(hasCoreEvidence(scores, 'model')).toBe(true);
  });

  it('returns true when 4 legacy dims at 2.5 sum to 10', () => {
    const scores = { novelty: 2.5, depth: 2.5, impact: 2.5, authority: 2.5, timeliness: 0 };
    expect(hasCoreEvidence(scores, 'model')).toBe(true);
  });

  it('returns false when no dimension >= 5 and legacy sum < 10', () => {
    const scores = { novelty: 2.5, depth: 2.5, impact: 2.5, authority: 0, timeliness: 0 };
    expect(hasCoreEvidence(scores, 'model')).toBe(false);
  });

  it('returns false when primary direction has all zeros', () => {
    const scores = { industry: 0, business_problem: 0, launch_status: 0 };
    expect(hasCoreEvidence(scores, 'applications')).toBe(false);
  });

  it('returns false for null/undefined scores', () => {
    expect(hasCoreEvidence(null, 'model')).toBe(false);
    expect(hasCoreEvidence(undefined, 'model')).toBe(false);
  });

  it('returns false for unknown direction', () => {
    const scores = { industry: 5, business_problem: 5 };
    expect(hasCoreEvidence(scores, 'unknown_direction')).toBe(false);
  });

  it('returns false for empty direction', () => {
    expect(hasCoreEvidence({ industry: 5 }, '')).toBe(false);
  });

  it('does not count evidence from non-primary direction dimensions', () => {
    const scores = { hardware: 5, training: 5 };
    expect(hasCoreEvidence(scores, 'applications')).toBe(false);
  });

  it('requires an application core dimension, not a secondary application detail', () => {
    expect(hasCoreEvidence({ roi: 5, scale: 5 }, 'applications')).toBe(false);
    expect(hasCoreEvidence({ industry: 5, business_problem: 5, roi: 5 }, 'applications')).toBe(true);
  });

  it('requires a model identity or capability fact, not an ecosystem detail', () => {
    expect(hasCoreEvidence({ ecosystem: 5, adoption: 5 }, 'model')).toBe(false);
    expect(hasCoreEvidence({ entity: 5, capability: 5, performance: 5 }, 'model')).toBe(true);
  });

  it('requires both model core dimensions instead of a single capability hit', () => {
    expect(hasCoreEvidence({ capability: 5, cost: 2.5 }, 'model')).toBe(false);
    expect(hasCoreEvidence({ entity: 5, capability: 5, cost: 2.5 }, 'model')).toBe(true);
  });

  it('requires two application core dimensions, not one strong hit', () => {
    expect(hasCoreEvidence({ industry: 5, scale: 5 }, 'applications')).toBe(false);
    expect(hasCoreEvidence({ industry: 5, business_problem: 5, roi: 5 }, 'applications')).toBe(true);
  });

  it('requires enough evidence dimensions to avoid keyword-only scoring', () => {
    expect(hasCoreEvidence({ entity: 5, capability: 5 }, 'model')).toBe(false);
    expect(hasCoreEvidence({ entity: 5, capability: 5, performance: 2.5 }, 'model')).toBe(true);
  });
});

describe('canPublishArticle', () => {
  const base = {
    primaryDirection: 'model' as string | null,
    primaryScore: 80,
    status: 'draft',
    dimensionScores: { entity: 5, capability: 5, performance: 5 } as Record<string, number> | null,
    publishThreshold: 75,
  };

  it('allows publish when all conditions met', () => {
    expect(canPublishArticle(base)).toBe(true);
  });

  it('allows publish when already published (re-validation)', () => {
    expect(canPublishArticle({ ...base, status: 'published' })).toBe(true);
  });

  it('rejects when primary direction is null', () => {
    expect(canPublishArticle({ ...base, primaryDirection: null })).toBe(false);
  });

  it('rejects when primary direction is unknown string', () => {
    expect(canPublishArticle({ ...base, primaryDirection: 'automotive' })).toBe(false);
  });

  it('rejects pending_review regardless of score', () => {
    expect(canPublishArticle({ ...base, status: 'pending_review' })).toBe(false);
  });

  it('rejects blocked regardless of score', () => {
    expect(canPublishArticle({ ...base, status: 'blocked' })).toBe(false);
  });

  it('rejects unverified aggregation even when every score requirement passes', () => {
    expect(canPublishArticle({ ...base, traceStatus: 'needs_review' })).toBe(false);
  });

  it('allows editorial reporting without a separate original URL', () => {
    expect(canPublishArticle({ ...base, traceStatus: 'editorial' })).toBe(true);
  });

  it('allows a successfully rescored article to become a publish candidate', () => {
    expect(canPublishArticle({
      ...base,
      status: 'draft',
      traceStatus: 'verified_reference',
    })).toBe(true);
  });

  it('rejects when primary_score below threshold', () => {
    expect(canPublishArticle({ ...base, primaryScore: 74 })).toBe(false);
  });

  it('rejects when primary direction has no core evidence', () => {
    expect(canPublishArticle({
      ...base,
      primaryDirection: 'applications',
      dimensionScores: { industry: 2.5, business_problem: 0 },
    })).toBe(false);
  });

  it('allows rule-based (ai_processed=false) when core evidence exists', () => {
    expect(canPublishArticle({
      primaryDirection: 'business_ecosystem',
      primaryScore: 85,
      status: 'draft',
      dimensionScores: { business_fact: 5, strategy: 5, signal: 5 },
      publishThreshold: 75,
    })).toBe(true);
  });

  it('blocks high score without core evidence in primary direction', () => {
    expect(canPublishArticle({
      primaryDirection: 'applications',
      primaryScore: 95,
      status: 'draft',
      dimensionScores: { industry: 2.5, business_problem: 2.5 },
      publishThreshold: 75,
    })).toBe(false);
  });

  it('blocks when primary has no evidence but other direction does', () => {
    expect(canPublishArticle({
      primaryDirection: 'applications',
      primaryScore: 80,
      status: 'draft',
      dimensionScores: { industry: 0, business_problem: 0 },
      publishThreshold: 75,
    })).toBe(false);
  });

  it('finds evidence using legacy primary direction ids', () => {
    expect(canPublishArticle({
      primaryDirection: 'eval',
      primaryScore: 80,
      status: 'draft',
      dimensionScores: { data_asset: 5, methodology: 5, performance: 5 },
      publishThreshold: 75,
    })).toBe(true);
  });

  it('rejects keyword-only evidence in the primary direction', () => {
    expect(canPublishArticle({
      primaryDirection: 'model',
      primaryScore: 85,
      status: 'draft',
      dimensionScores: { entity: 5, capability: 5 },
      publishThreshold: 75,
    })).toBe(false);
    expect(canPublishArticle({
      primaryDirection: 'model',
      primaryScore: 85,
      status: 'draft',
      dimensionScores: { entity: 5, capability: 5, performance: 5 },
      publishThreshold: 75,
    })).toBe(true);
  });
});

describe('aggregateDirectionScores', () => {
  it('returns exactly 9 unique directions', () => {
    const result = aggregateDirectionScores([]);
    expect(result).toHaveLength(9);
    const dirs = result.map((r) => r.direction);
    expect(new Set(dirs).size).toBe(9);
  });

  it('merges legacy eval + data into single data_eval', () => {
    const scores = [
      { direction: 'eval', totalScore: 80, dimensionScores: { novelty: 5, depth: 5, impact: 5 } },
      { direction: 'data', totalScore: 86, dimensionScores: { novelty: 4, depth: 4, impact: 5 } },
    ];
    const result = aggregateDirectionScores(scores);
    const dataEval = result.find((r) => r.direction === 'data_eval')!;
    expect(dataEval).toBeDefined();
    expect(dataEval.totalScore).toBe(86);
    expect(dataEval.dimensionScores.novelty).toBe(5);
    expect(dataEval.dimensionScores.depth).toBe(5);
    expect(dataEval.dimensionScores.impact).toBe(5);
  });

  it('fills missing directions with 0', () => {
    const scores = [
      { direction: 'model', totalScore: 50, dimensionScores: { entity: 5 } },
    ];
    const result = aggregateDirectionScores(scores);
    const apps = result.find((r) => r.direction === 'applications')!;
    expect(apps.totalScore).toBe(0);
    expect(apps.dimensionScores).toEqual({});
  });

  it('rejects unknown directions silently', () => {
    const scores = [
      { direction: 'unknown_dir', totalScore: 100, dimensionScores: { x: 5 } },
      { direction: 'model', totalScore: 50, dimensionScores: { entity: 5 } },
    ];
    const result = aggregateDirectionScores(scores);
    expect(result).toHaveLength(9);
    const unknown = result.find((r) => (r.direction as string) === 'unknown_dir');
    expect(unknown).toBeUndefined();
  });

  it('normalizes legacy direction names', () => {
    const scores = [
      { direction: 'multi', totalScore: 60, dimensionScores: { quality: 5 } },
      { direction: 'infra', totalScore: 40, dimensionScores: { hardware: 5 } },
      { direction: 'security', totalScore: 30, dimensionScores: { regulation: 5 } },
    ];
    const result = aggregateDirectionScores(scores);
    expect(result.find((r) => r.direction === 'multimodal')!.totalScore).toBe(60);
    expect(result.find((r) => r.direction === 'infrastructure')!.totalScore).toBe(40);
    expect(result.find((r) => r.direction === 'safety_governance')!.totalScore).toBe(30);
  });
});
