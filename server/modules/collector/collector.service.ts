import { Injectable, Inject, Logger } from '@nestjs/common';
import {
  DRIZZLE_DATABASE,
  type PostgresJsDatabase,
} from '@lark-apaas/fullstack-nestjs-core';
import { eq, ne, inArray, and, isNotNull, sql } from 'drizzle-orm';
import {
  article, feedSource, directionScore, qualityGate,
  reviewItem, appConfig, dailyDigest,
} from '@server/database/schema';
import { FeedSourceService } from '../feed-source/feed-source.service';
import { DigestService } from '../digest/digest.service';
import { AiScoringService } from './ai-scoring.service';
import {
  normalizeUrl, normalizeTitle, shouldTrace, traceFromRssContent,
} from './trace-engine';
import { fetchRawContent, parseRawContent } from './parsers';
import { normalizeItems, normalizeUrlForDedup } from './pipeline-normalize';
import { dedupBatch, filterAgainstExisting } from './pipeline-dedup';
import * as crypto from 'crypto';
import { ALL_DIRECTION_IDS as DIRECTIONS } from '@shared/directions';
import { canPublishArticle } from './publish-gate';

export const PIPELINE_STAGE_ORDER = [
  'source_snapshot', 'fetch', 'parse', 'normalize', 'url_dedup', 'trace',
  'classify', 'cluster', 'rule_score', 'ai_score', 'quality_gate', 'publish',
] as const;

export type PipelineStage = typeof PIPELINE_STAGE_ORDER[number];

const STALE_DAYS = 7;
const CLUSTER_THRESHOLD = 0.5;

interface PipelineArticle { id: string; title: string; url: string; content: string; rawContent: string; feedSourceId: string; sourceUrl: string; sourceTier: string; }
interface RawFetchResponse { feedSourceId: string; feedType: string; url: string; sourceName: string; sourceTier: string; rawContent: string; byteLength: number; httpStatus: number; }

function jaccardSimilarity(text1: string, text2: string): number {
  const set1 = new Set(text1.toLowerCase().split(/\s+/).filter((w: string) => w.length > 2));
  const set2 = new Set(text2.toLowerCase().split(/\s+/).filter((w: string) => w.length > 2));
  const intersection = new Set([...set1].filter((x) => set2.has(x)));
  const union = new Set([...set1, ...set2]);
  return union.size === 0 ? 0 : intersection.size / union.size;
}

function getWordSet(text: string): Set<string> {
  return new Set(text.toLowerCase().split(/\s+/).filter((w: string) => w.length > 2));
}

@Injectable()
export class CollectorService {
  private readonly logger = new Logger(CollectorService.name);
  private pipelineRunning = false;

  constructor(
    @Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase,
    private readonly feedSourceService: FeedSourceService,
    private readonly digestService: DigestService,
    private readonly aiScoringService: AiScoringService,
  ) {}

  async runPipeline(): Promise<void> {
    if (this.pipelineRunning) { this.logger.log('Pipeline already running, skipping'); return; }
    this.pipelineRunning = true;
    const startTime = Date.now();
    try { await this.executeFullPipeline(); } catch (error: unknown) {
      this.logger.error(`Pipeline failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      this.pipelineRunning = false;
      this.logger.log(`Pipeline finished in ${(((Date.now() - startTime) / 1000)).toFixed(1)}s`);
    }
  }

  /** Log all remaining stages from `from` (1-indexed) as skipped/empty. */
  private logEmptyStages(from: number): void {
    const msgs: Record<number, string> = {
      2: '[2/12] fetch: skipped, ok=0, fail=0, bytes=0',
      3: '[3/12] parse: skipped, ok=0, fail=0, items=0',
      4: '[4/12] normalize: skipped, passed=0, dropped=0',
      5: '[5/12] url_dedup: skipped, passed=0, deduped=0',
      6: '[6/12] trace: skipped, needed=0, ok=0, fail=0',
      7: '[7/12] classify: skipped, ok=0, degraded=0',
      8: '[8/12] cluster: skipped, 0 articles',
      9: '[9/12] rule_score: skipped, ok=0, fail=0',
      10: '[10/12] ai_score: skipped, ai=0, degraded=0',
      11: '[11/12] quality_gate: skipped, passed=0',
      12: '[12/12] publish: skipped, published=0',
    };
    for (let i = from; i <= 12; i++) {
      if (msgs[i]) this.logger.log(msgs[i]);
    }
  }

  private async executeFullPipeline(): Promise<void> {
    this.logger.log(`Pipeline started [${PIPELINE_STAGE_ORDER.length} stages]`);
    const today = new Date().toISOString().split('T')[0];
    const concurrency = await this.getConfig('fetch_concurrency', 3);
    const retryCount = await this.getConfig('fetch_retry_count', 3);
    const aiDailyLimit = await this.getConfig('ai_daily_limit', 500);

    // ── Stage 1/12: source_snapshot ──
    const sources = await this.db.select().from(feedSource).where(eq(feedSource.enabled, true));
    if (sources.length === 0) {
      this.logger.log('[1/12] source_snapshot: 0 enabled sources');
      this.logEmptyStages(2);
      await this.ensureDigest(today);
      return;
    }
    this.logger.log(`[1/12] source_snapshot: ${sources.length} enabled sources`);

    // ── Stage 2/12: fetch ──
    const rawResponses: RawFetchResponse[] = [];
    let fetchOk = 0, fetchFail = 0, fetchBytesTotal = 0;
    await this.processBatch(sources, concurrency, async (source) => {
      let raw: Awaited<ReturnType<typeof fetchRawContent>> | null = null;
      for (let attempt = 1; attempt <= retryCount; attempt++) {
        try {
          raw = await fetchRawContent(source.url);
          break;
        } catch (error: unknown) {
          const errMsg = error instanceof Error ? error.message : String(error);
          this.logger.warn(`Fetch attempt ${attempt}/${retryCount} for "${source.name}": ${errMsg}`);
          if (attempt === retryCount) {
            await this.feedSourceService.updateFetchStats(source.id, false, errMsg);
            fetchFail++;
            return;
          }
          await this.sleep(1000 * Math.pow(2, attempt - 1));
        }
      }
      if (raw) {
        await this.feedSourceService.updateFetchStats(source.id, true);
        fetchOk++;
        fetchBytesTotal += raw.byteLength;
        rawResponses.push({
          feedSourceId: source.id, feedType: source.feedType, url: source.url,
          sourceName: source.name, sourceTier: source.tier,
          rawContent: raw.content, byteLength: raw.byteLength, httpStatus: raw.httpStatus,
        });
      } else { fetchFail++; }
    });
    this.logger.log(`[2/12] fetch: ok=${fetchOk}, fail=${fetchFail}, bytes=${fetchBytesTotal}`);

    if (rawResponses.length === 0) {
      this.logEmptyStages(3);
      await this.ensureDigest(today);
      return;
    }

    // ── Stage 3/12: parse ──
    type ParsedBatch = { items: Array<{ title: string; url: string; canonicalUrl?: string; publishedAt: Date | null; content: string; rawContent: string }>; feedSourceId: string; sourceName: string; sourceTier: string; };
    const allParsedItems: ParsedBatch[] = [];
    let parseOk = 0, parseFail = 0;
    for (const resp of rawResponses) {
      const result = await parseRawContent(resp.feedType, resp.rawContent, resp.url);
      if (result.error || result.items.length === 0) {
        parseFail++;
        await this.feedSourceService.updateFetchStats(resp.feedSourceId, false, result.error || 'No items in feed');
      } else {
        parseOk++;
        allParsedItems.push({ items: result.items, feedSourceId: resp.feedSourceId, sourceName: resp.sourceName, sourceTier: resp.sourceTier });
      }
    }
    this.logger.log(`[3/12] parse: ok=${parseOk}, fail=${parseFail}, items=${allParsedItems.reduce((s: number, b) => s + b.items.length, 0)}`);

    // ── Stage 4/12: normalize ──
    type NormItem = ReturnType<typeof normalizeItems>['items'][number];
    let allNormalized: NormItem[] = [];
    let normalizeDropped = 0;
    for (const batch of allParsedItems) {
      const result = normalizeItems(batch.items, { name: batch.sourceName, tier: batch.sourceTier, feedSourceId: batch.feedSourceId });
      allNormalized = allNormalized.concat(result.items);
      normalizeDropped += result.dropped;
    }
    this.logger.log(`[4/12] normalize: passed=${allNormalized.length}, dropped=${normalizeDropped}`);

    // ── Stage 5/12: url_dedup ──
    const recentArticles = await this.db
      .select({ url: article.url, contentHash: article.contentHash })
      .from(article).where(sql`${article.collectedAt} > NOW() - INTERVAL '30 days'`);
    const existingHashes = new Set(recentArticles.map((r) => r.contentHash));
    const existingUrls = new Set(recentArticles.map((r) => normalizeUrlForDedup(r.url)));
    const dedupInput = allNormalized.map((n) => ({ url: n.url, contentHash: n.contentHash, title: n.title }));
    const dbFiltered = filterAgainstExisting(dedupInput, existingHashes, existingUrls);
    const batchDedup = dedupBatch(dbFiltered.passed);
    const totalDeduped = dbFiltered.deduped + batchDedup.deduped;
    const newItemsMap = new Map(batchDedup.passed.map((p) => [p.contentHash, allNormalized.find((n) => n.contentHash === p.contentHash)!]));
    const newItems = batchDedup.passed.map((p) => newItemsMap.get(p.contentHash)!).filter(Boolean);
    this.logger.log(`[5/12] url_dedup: passed=${newItems.length}, deduped=${totalDeduped}`);

    if (newItems.length === 0) {
      this.logEmptyStages(6);
      await this.ensureDigest(today);
      return;
    }

    // Build sourceUrlMap for correct sourceUrl assignment (fix #1)
    const sourceUrlMap = new Map(sources.map((s) => [s.id, s.url]));

    // Atomic article insert with onConflictDoNothing (fix #7)
    const allNewArticles: PipelineArticle[] = [];
    for (const item of newItems) {
      const inserted = await this.db.insert(article).values({
        // Keep the feed's original article link; canonical URLs are metadata, not a replacement.
        title: item.title, url: item.originalUrl, contentHash: item.contentHash,
        sourceName: item.sourceName, feedSourceId: item.feedSourceId,
        publishedAt: item.publishedAt, status: 'draft',
      }).onConflictDoNothing({ target: article.contentHash }).returning({ id: article.id });
      if (inserted.length === 0) continue;
      allNewArticles.push({
        id: inserted[0].id, title: item.title, url: item.url,
        content: item.content, rawContent: item.rawContent,
        feedSourceId: item.feedSourceId,
        sourceUrl: sourceUrlMap.get(item.feedSourceId) || '',
        sourceTier: item.sourceTier,
      });
    }
    this.logger.log(`Inserted ${allNewArticles.length} new articles`);

    // ── Stage 6/12: trace ──
    let traceNeeded = 0, traceOk = 0, traceFail = 0;
    const traceFailIds = new Set<string>();
    for (const art of allNewArticles) {
      const needsTrace = shouldTrace(art.sourceTier, art.url);
      if (!needsTrace) continue;
      traceNeeded++;
      if (await this.traceOrigin(art)) { traceOk++; } else { traceFail++; traceFailIds.add(art.id); }
    }
    this.logger.log(`[6/12] trace: needed=${traceNeeded}, ok=${traceOk}, fail=${traceFail}`);

    // ── Stage 7/12: classify (topic classification only, no ruleBasedScore) ──
    let classOk = 0, classDegraded = 0;
    const classifyMap = new Map<string, string | null>();
    for (const art of allNewArticles) {
      try {
        const source = sources.find((s) => s.id === art.feedSourceId);
        const tier = source?.tier ?? 'signal';
        const classResult = this.aiScoringService.classifyArticle(art.title, art.content, tier);
        classifyMap.set(art.id, classResult.primaryDirection);
        const setStatus = traceFailIds.has(art.id) ? 'pending_review' : undefined;
        await this.db.update(article).set({
          primaryDirection: classResult.primaryDirection,
          aiProcessed: false,
          ...(setStatus ? { status: setStatus } : {}),
        }).where(eq(article.id, art.id));
        if (traceFailIds.has(art.id)) await this.createReviewItem(art.id);
        classOk++;
      } catch (error: unknown) {
        const errMsg = error instanceof Error ? error.message : String(error);
        this.logger.warn(`Classification failed for "${art.title}": ${errMsg}`);
        classDegraded++;
        if (traceFailIds.has(art.id)) {
          await this.db.update(article).set({ status: 'pending_review' }).where(eq(article.id, art.id));
          await this.createReviewItem(art.id);
        }
      }
    }
    this.logger.log(`[7/12] classify: ok=${classOk}, degraded=${classDegraded}`);

    // ── Stage 8/12: cluster ──
    await this.clusterArticles(allNewArticles);
    this.logger.log(`[8/12] cluster: ${allNewArticles.length} articles`);

    // ── Stage 9/12: rule_score (call ruleBasedScoreArticle, persist 9 direction_scores) ──
    let ruleOk = 0, ruleFail = 0;
    for (const art of allNewArticles) {
      try {
        const source = sources.find((s) => s.id === art.feedSourceId);
        const tier = source?.tier ?? 'signal';
        const ruleResult = this.aiScoringService.ruleBasedScoreArticle(art.title, art.content, tier);
        await this.db.delete(directionScore).where(eq(directionScore.articleId, art.id));
        for (const dir of DIRECTIONS) {
          const ev = ruleResult.directionScores[dir];
          await this.db.insert(directionScore).values({
            articleId: art.id, direction: dir,
            dimensionScores: ev?.dimensionScores ?? {},
            totalScore: ev?.normalizedScore ?? 0,
          });
        }
        await this.db.update(article).set({
          primaryDirection: ruleResult.primaryDirection ?? classifyMap.get(art.id) ?? null,
          primaryScore: ruleResult.publishScore,
          summary: ruleResult.summary,
          aiDegradeReason: ruleResult.degradeReason,
        }).where(eq(article.id, art.id));
        ruleOk++;
      } catch (error: unknown) {
        const errMsg = error instanceof Error ? error.message : String(error);
        this.logger.warn(`Rule score failed for "${art.title}": ${errMsg}`);
        ruleFail++;
      }
    }
    this.logger.log(`[9/12] rule_score: ok=${ruleOk}, fail=${ruleFail}`);

    // ── Stage 10/12: ai_score (AI enhancement, fallback to rule) ──
    const aiPerSourceLimit = await this.getConfig('ai_per_source_limit', 30);
    let aiCount = await this.getAiCallCount(today);
    const tierMap = new Map<string, string>();
    const sourceNameMap = new Map<string, string>();
    for (const s of sources) { tierMap.set(s.id, s.tier); sourceNameMap.set(s.id, s.name); }

    const perSourceCount = new Map<string, number>();
    const todayAiArticles = await this.db
      .select({ sourceName: article.sourceName }).from(article)
      .where(and(eq(article.aiProcessed, true), sql`${article.collectedAt}::date = ${today}::date`));
    for (const row of todayAiArticles) {
      perSourceCount.set(row.sourceName, (perSourceCount.get(row.sourceName) || 0) + 1);
    }

    const TIER_PRIORITY: Record<string, number> = { authoritative: 0, validation: 1, signal: 2 };
    const sortedForScoring = [...allNewArticles].sort((a, b) => {
      const pA = TIER_PRIORITY[tierMap.get(a.feedSourceId) ?? 'signal'] ?? 2;
      const pB = TIER_PRIORITY[tierMap.get(b.feedSourceId) ?? 'signal'] ?? 2;
      if (pA !== pB) return pA - pB;
      const cntA = perSourceCount.get(sourceNameMap.get(a.feedSourceId) ?? '') || 0;
      const cntB = perSourceCount.get(sourceNameMap.get(b.feedSourceId) ?? '') || 0;
      return cntA - cntB;
    });

    let aiUsed = 0, aiDegraded = 0;
    for (const art of sortedForScoring) {
      const source = sources.find((s) => s.id === art.feedSourceId);
      const tier = source?.tier ?? 'signal';
      const srcName = source?.name ?? 'unknown';
      const srcUsed = perSourceCount.get(srcName) || 0;
      let result;
      let usedAi = false;

      if (aiCount < aiDailyLimit && srcUsed < aiPerSourceLimit
        && await this.reserveAiCall(today, aiDailyLimit)) {
        // Reserve before invoking the provider so concurrent runners cannot overspend quota.
        aiCount++;
        perSourceCount.set(srcName, srcUsed + 1);
        try {
          result = await this.aiScoringService.scoreArticle(art.title, art.content, tier);
          if (result.aiProcessed) usedAi = true;
        } catch (outerError: unknown) {
          const errType = outerError instanceof Error ? outerError.constructor.name : typeof outerError;
          const errMsg = outerError instanceof Error ? outerError.message : String(outerError);
          result = { ...this.aiScoringService.ruleBasedScoreArticle(art.title, art.content, tier, `[${errType}] ${errMsg}`) };
        }
      } else {
        const reason = aiCount >= aiDailyLimit ? 'ai_daily_limit_reached' : `per_source_limit_reached(${srcName}:${srcUsed}/${aiPerSourceLimit})`;
        result = { ...this.aiScoringService.ruleBasedScoreArticle(art.title, art.content, tier, reason) };
        aiDegraded++;
      }

      await this.db.delete(directionScore).where(eq(directionScore.articleId, art.id));
      for (const dir of DIRECTIONS) {
        const ev = result.directionScores[dir];
        await this.db.insert(directionScore).values({
          articleId: art.id, direction: dir,
          dimensionScores: ev?.dimensionScores ?? {},
          totalScore: ev?.normalizedScore ?? 0,
        });
      }

      // A failed origin trace must remain reviewable even when scoring degrades.
      const articleStatus = traceFailIds.has(art.id)
        ? 'pending_review'
        : (!result.primaryDirection || !result.aiProcessed) ? 'draft' : undefined;
      await this.db.update(article).set({
        primaryDirection: result.primaryDirection,
        primaryScore: result.publishScore,
        summary: result.summary,
        aiProcessed: result.aiProcessed,
        aiDegradeReason: result.degradeReason,
        ...(articleStatus ? { status: articleStatus } : {}),
      }).where(eq(article.id, art.id));

      if (usedAi) {
        aiUsed++;
      }
    }
    this.logger.log(`[10/12] ai_score: ai=${aiUsed}/${aiDailyLimit}, degraded=${aiDegraded}`);

    // Rescore pending with shared counters (fix #5, #6)
    const rescoreResult = await this.rescorePending({ aiCount, perSourceCount, today });
    this.logger.log(`Rescore pre-gate: ${rescoreResult.succeeded} ok, ${rescoreResult.failed} fail`);

    // ── Stage 11/12: quality_gate ──
    const publishThreshold = await this.getConfig('publish_threshold', 75);
    const minSuccessRate = await this.getConfig('source_min_success_rate', 30);
    const maxConsecFail = await this.getConfig('source_max_consecutive_failures', 5);
    const autoApproveHours = await this.getConfig('auto_approve_hours', 24);
    const autoApproveThreshold = await this.getConfig('auto_approve_threshold', 60);

    const autoApproved = await this.db.execute(sql`
      UPDATE article SET status = 'draft'
      WHERE status = 'pending_review'
        AND collected_at < NOW() - (${autoApproveHours} || ' hours')::interval
        AND primary_direction IS NOT NULL
        AND (primary_score IS NOT NULL AND primary_score >= ${autoApproveThreshold})
        AND NOT EXISTS (
          SELECT 1 FROM review_item ri
          WHERE ri.article_id = article.id AND ri.status = 'pending'
        )
      RETURNING id
    `);
    const autoApprovedRows = autoApproved as unknown as { id: string }[];
    const autoApprovedIds = new Set(autoApprovedRows.map((r) => r.id));
    if (autoApprovedRows.length > 0) {
      this.logger.log(`Auto-approved ${autoApprovedRows.length} stuck pending_review`);
    }

    // Union: new articles + rescored + auto-approved (fix #6)
    const allArticleIdsSet = new Set<string>(allNewArticles.map((a) => a.id));
    for (const id of rescoreResult.rescoredIds) allArticleIdsSet.add(id);
    for (const id of autoApprovedIds) allArticleIdsSet.add(id);
    const allArticleIds = [...allArticleIdsSet];

    let gateStale = 0, gateUnreliable = 0, gateDead = 0;
    const blockedAtGateIds = new Set<string>();
    const articlesForGate = await this.db
      .select({ id: article.id, title: article.title, url: article.url, status: article.status, publishedAt: article.publishedAt, feedSourceId: article.feedSourceId })
      .from(article).where(inArray(article.id, allArticleIds));
    const gateArticleMap = new Map(allNewArticles.map((a) => [a.id, a]));

    for (const artRow of articlesForGate) {
      const inNew = gateArticleMap.has(artRow.id);
      const inRescore = rescoreResult.rescoredIds.has(artRow.id);
      const inAutoApprove = autoApprovedIds.has(artRow.id);
      if (!inNew && !inRescore && !inAutoApprove) continue;

      const checkUrl = await this.getFinalUrl(artRow.id);
      let blocked = false, blockReason = '', blockDetail = '';

      if (artRow.publishedAt) {
        const pubTime = artRow.publishedAt instanceof Date ? artRow.publishedAt.getTime() : new Date(artRow.publishedAt).getTime();
        if (pubTime < Date.now() - STALE_DAYS * 24 * 60 * 60 * 1000) {
          blocked = true; blockReason = 'content_stale';
          blockDetail = `Published > ${STALE_DAYS} days ago`; gateStale++;
        }
      }
      if (!blocked) {
        const [src] = await this.db
          .select({ totalFetches: feedSource.totalFetches, successFetches: feedSource.successFetches, consecutiveFailures: feedSource.consecutiveFailures })
          .from(feedSource).where(eq(feedSource.id, artRow.feedSourceId));
        if (src && src.totalFetches >= 3) {
          const rate = Math.round((src.successFetches / src.totalFetches) * 100);
          if (rate < minSuccessRate || src.consecutiveFailures >= maxConsecFail) {
            blocked = true; blockReason = 'source_unreliable';
            blockDetail = `Rate ${rate}%, consec fail ${src.consecutiveFailures}`; gateUnreliable++;
          }
        }
      }
      if (!blocked) {
        const alive = await this.checkLinkAlive(checkUrl);
        if (!alive.alive) { blocked = true; blockReason = 'link_dead'; blockDetail = alive.detail; gateDead++; }
      }
      if (blocked) {
        await this.blockArticle(artRow.id, blockReason, blockDetail);
        blockedAtGateIds.add(artRow.id);
      }
    }

    const dedupPassed = await this.checkDuplicateGates(allNewArticles);
    const gateDup = allNewArticles.length - dedupPassed.length;
    const gatePassedIds = new Set(dedupPassed.map((art) => art.id));
    for (const id of allArticleIds) {
      if (!gateArticleMap.has(id) && !blockedAtGateIds.has(id)) gatePassedIds.add(id);
    }
    this.logger.log(`[11/12] quality_gate: passed=${gatePassedIds.size}, stale=${gateStale}, unreliable=${gateUnreliable}, dead=${gateDead}, dup=${gateDup}`);

    // ── Stage 12/12: publish ──
    const publishedCount = await this.executePublishGate([...gatePassedIds].map((id) => ({ id })), publishThreshold);
    await this.selectForFrontPage();
    await this.ensureDigest(today);
    this.logger.log(`[12/12] publish: published=${publishedCount} (threshold=${publishThreshold})`);
    this.logger.log('Pipeline completed successfully');
  }

  // ─── Origin Tracing ───────────────────────────────────────

  private async traceOrigin(art: PipelineArticle): Promise<boolean> {
    try {
      const origin = traceFromRssContent(art.url, art.rawContent, art.sourceUrl);
      if (origin) {
        await this.db.update(article).set({ originalUrl: origin }).where(eq(article.id, art.id));
        this.logger.log(`Traced "${art.title}" -> ${origin}`);
        return true;
      }
      this.logger.warn(`No origin found for "${art.title}"`);
      return false;
    } catch (error: unknown) {
      this.logger.warn(`Origin tracing error for "${art.title}": ${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
  }
  private async createReviewItem(articleId: string): Promise<void> {
    await this.db.insert(reviewItem).values({ articleId, status: 'pending' });
  }

  // ─── Duplicate Gates ──────────────────────────────────────

  private async checkDuplicateGates(articles: PipelineArticle[]): Promise<PipelineArticle[]> {
    if (articles.length === 0) return [];
    const blockedIds = new Set<string>();
    const recentArticles = await this.db
      .select({ id: article.id, title: article.title, url: article.url })
      .from(article).where(sql`${article.collectedAt} > NOW() - INTERVAL '30 days'`);
    const dbUrlMap = new Map<string, string>();
    const dbTitleMap = new Map<string, string>();
    for (const recent of recentArticles) {
      const nUrl = normalizeUrl(recent.url);
      const nTitle = normalizeTitle(recent.title);
      if (!dbUrlMap.has(nUrl)) dbUrlMap.set(nUrl, recent.id);
      if (!dbTitleMap.has(nTitle)) dbTitleMap.set(nTitle, recent.id);
    }
    for (const art of articles) {
      if (blockedIds.has(art.id)) continue;
      const nUrl = normalizeUrl(art.url);
      const nTitle = normalizeTitle(art.title);
      const dupUrlId = dbUrlMap.get(nUrl);
      if (dupUrlId && dupUrlId !== art.id) { await this.blockArticle(art.id, 'same_url', `URL matches article ${dupUrlId}`); blockedIds.add(art.id); continue; }
      const dupTitleId = dbTitleMap.get(nTitle);
      if (dupTitleId && dupTitleId !== art.id) { await this.blockArticle(art.id, 'same_title', `Title matches article ${dupTitleId}`); blockedIds.add(art.id); continue; }
    }
    const batchUrlMap = new Map<string, string>();
    const batchTitleMap = new Map<string, string>();
    for (const art of articles) {
      if (blockedIds.has(art.id)) continue;
      const nUrl = normalizeUrl(art.url);
      const nTitle = normalizeTitle(art.title);
      const existUrl = batchUrlMap.get(nUrl);
      if (existUrl) { await this.blockArticle(art.id, 'same_batch_url', `Batch URL matches ${existUrl}`); blockedIds.add(art.id); continue; }
      batchUrlMap.set(nUrl, art.id);
      const existTitle = batchTitleMap.get(nTitle);
      if (existTitle) { await this.blockArticle(art.id, 'same_batch_title', `Batch title matches ${existTitle}`); blockedIds.add(art.id); continue; }
      batchTitleMap.set(nTitle, art.id);
    }
    return articles.filter((a) => !blockedIds.has(a.id));
  }

  private async getFinalUrl(articleId: string): Promise<string> {
    const [row] = await this.db.select({ url: article.url, originalUrl: article.originalUrl }).from(article).where(eq(article.id, articleId));
    if (!row) return '';
    return row.originalUrl || row.url;
  }

  private async checkLinkAlive(url: string): Promise<{ alive: boolean; detail: string }> {
    if (!url) return { alive: true, detail: '' };
    const UA = 'Mozilla/5.0 (compatible; AI-News-Bot/1.0)';
    let status: number | null = null;
    let errorDetail = '';
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 10000);
      const response = await fetch(url, { method: 'HEAD', redirect: 'follow', signal: controller.signal, headers: { 'User-Agent': UA } });
      clearTimeout(timer);
      status = response.status;
    } catch (error: unknown) { errorDetail = error instanceof Error ? error.message : String(error); }
    if (status === null || status >= 400) {
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 10000);
        const response = await fetch(url, { method: 'GET', redirect: 'follow', signal: controller.signal, headers: { 'User-Agent': UA, Range: 'bytes=0-0' } });
        clearTimeout(timer);
        status = response.status;
        errorDetail = '';
      } catch { return { alive: true, detail: `probe_timeout: ${errorDetail}` }; }
    }
    if (status !== null && (status === 404 || status === 410)) return { alive: false, detail: `HTTP ${status} for ${url}` };
    if (status !== null && status >= 400) return { alive: true, detail: `probe_status: ${status}` };
    return { alive: true, detail: '' };
  }

  private async blockArticle(articleId: string, reason: string, detail: string): Promise<void> {
    await this.db.insert(qualityGate).values({ articleId, reason, detail });
    await this.db.update(article).set({ status: 'blocked' }).where(eq(article.id, articleId));
  }

  // ─── Event Clustering ─────────────────────────────────────
  private async clusterArticles(articles: PipelineArticle[]): Promise<void> {
    if (articles.length < 2) return;
    const parent: Record<string, string> = {};
    for (const art of articles) parent[art.id] = art.id;
    const find = (id: string): string => { if (parent[id] !== id) parent[id] = find(parent[id]); return parent[id]; };
    const union = (id1: string, id2: string): void => { const r1 = find(id1), r2 = find(id2); if (r1 !== r2) parent[r1] = r2; };
    for (let i = 0; i < articles.length; i++)
      for (let j = i + 1; j < articles.length; j++)
        if (jaccardSimilarity(articles[i].title, articles[j].title) >= CLUSTER_THRESHOLD) union(articles[i].id, articles[j].id);
    const groups = new Map<string, PipelineArticle[]>();
    for (const art of articles) { const root = find(art.id); if (!groups.has(root)) groups.set(root, []); groups.get(root)!.push(art); }
    for (const [, grp] of groups) {
      if (grp.length < 2) continue;
      const wordSets = grp.map((a: PipelineArticle) => getWordSet(a.title));
      let cw = new Set(wordSets[0]);
      for (let i = 1; i < wordSets.length; i++) cw = new Set([...cw].filter((w) => wordSets[i].has(w)));
      const clusterId = cw.size > 0
        ? crypto.createHash('md5').update([...cw].sort().join(' ')).digest('hex').slice(0, 16)
        : crypto.createHash('md5').update(grp.map((a: PipelineArticle) => a.id).sort().join(',')).digest('hex').slice(0, 16);
      await this.db.update(article).set({ clusterId }).where(inArray(article.id, grp.map((a: PipelineArticle) => a.id)));
    }
    this.logger.log(`Clustering completed: ${groups.size} groups`);
  }

  // ─── Front Page Diversity Selection ───────────────────────

  async selectForFrontPage(): Promise<void> {
    const limit = await this.getConfig('daily_front_page_limit', 20);
    const sourceCap = Math.max(2, Math.ceil(limit / 5));
    const directionCap = Math.max(2, Math.ceil(limit / 2));
    const DIRECTION_ORDER = ['model', 'agent', 'multimodal', 'coding', 'infrastructure', 'data_eval', 'safety_governance', 'applications', 'business_ecosystem'];
    await this.db.execute(sql`UPDATE article SET front_page_rank = NULL, exclude_reason = NULL WHERE front_page_rank IS NOT NULL OR exclude_reason IS NOT NULL`);
    const publishThreshold = await this.getConfig('publish_threshold', 75);
    const candidatesResult = await this.db.execute(sql`
      SELECT id, source_name, primary_direction, primary_score FROM article
      WHERE status = 'published' AND primary_score >= ${publishThreshold} AND published_at > now() - interval '7 days'
      ORDER BY primary_score DESC
    `);
    interface CandidateRow { id: string; source_name: string; primary_direction: string | null; primary_score: number | null; }
    const rows = candidatesResult as unknown as CandidateRow[];
    const byDirection = new Map<string, CandidateRow[]>();
    for (const c of rows) { const dir = c.primary_direction ?? 'model'; if (!byDirection.has(dir)) byDirection.set(dir, []); byDirection.get(dir)!.push(c); }
    const selected: CandidateRow[] = [];
    const sourceCounts = new Map<string, number>();
    const directionCounts = new Map<string, number>();
    let changed = true;
    while (selected.length < limit && changed) {
      changed = false;
      for (const dir of DIRECTION_ORDER) {
        if (selected.length >= limit) break;
        const queue = byDirection.get(dir) || [];
        let picked = false;
        while (queue.length > 0 && !picked) {
          const c = queue.shift()!;
          const src = c.source_name || 'unknown';
          if ((sourceCounts.get(src) || 0) >= sourceCap) continue;
          if ((directionCounts.get(dir) || 0) >= directionCap) break;
          selected.push(c); sourceCounts.set(src, (sourceCounts.get(src) || 0) + 1); directionCounts.set(dir, (directionCounts.get(dir) || 0) + 1);
          changed = true; picked = true;
        }
      }
    }
    for (const c of rows) {
      if (selected.length >= limit) break;
      if (selected.some((s: CandidateRow) => s.id === c.id)) continue;
      const src = c.source_name || 'unknown';
      const dir = c.primary_direction ?? 'model';
      if ((sourceCounts.get(src) || 0) >= sourceCap) continue;
      if ((directionCounts.get(dir) || 0) >= directionCap + 1 && selected.length < limit - 1) continue;
      selected.push(c); sourceCounts.set(src, (sourceCounts.get(src) || 0) + 1); directionCounts.set(dir, (directionCounts.get(dir) || 0) + 1);
    }
    for (let i = 0; i < selected.length; i++) await this.db.execute(sql`UPDATE article SET front_page_rank = ${100 + i} WHERE id = ${selected[i].id}`);
    const selectedIds = new Set(selected.map((s: CandidateRow) => s.id));
    for (const c of rows) {
      if (selectedIds.has(c.id)) continue;
      const src = c.source_name || 'unknown';
      const dir = c.primary_direction ?? 'model';
      let reason: string;
      if ((sourceCounts.get(src) || 0) >= sourceCap) reason = 'source_cap';
      else if ((directionCounts.get(dir) || 0) >= directionCap) reason = 'direction_cap';
      else reason = 'limit_reached';
      await this.db.execute(sql`UPDATE article SET exclude_reason = ${reason} WHERE id = ${c.id}`);
    }
    this.logger.log(`Front page: selected ${selected.length}/${rows.length} candidates`);
  }

  // ─── Rescore Pending ──────────────────────────────────────

  async rescorePending(shared?: {
    aiCount: number; perSourceCount: Map<string, number>; today: string;
  }): Promise<{ rescored: number; succeeded: number; failed: number; rescoredIds: Set<string> }> {
    const today = shared?.today ?? new Date().toISOString().split('T')[0];
    const aiDailyLimit = await this.getConfig('ai_daily_limit', 500);
    const aiPerSourceLimit = await this.getConfig('ai_per_source_limit', 30);
    let aiCount: number;
    let perSourceCount: Map<string, number>;
    if (shared) {
      aiCount = shared.aiCount;
      perSourceCount = shared.perSourceCount;
    } else {
      aiCount = await this.getAiCallCount(today);
      perSourceCount = new Map<string, number>();
      const todayAi = await this.db.select({ sourceName: article.sourceName }).from(article)
        .where(and(eq(article.aiProcessed, true), sql`${article.collectedAt}::date = ${today}::date`));
      for (const row of todayAi) perSourceCount.set(row.sourceName, (perSourceCount.get(row.sourceName) || 0) + 1);
    }

    const pendingArticles = await this.db
      .select({ id: article.id, title: article.title, sourceName: article.sourceName, feedSourceId: article.feedSourceId })
      .from(article)
      .where(and(
        eq(article.aiProcessed, false),
        sql`(${article.publishedAt} IS NULL OR ${article.publishedAt} > NOW() - INTERVAL '7 days')`,
        sql`${article.sourceName} != 'arXiv cs.AI'`,
      ));
    this.logger.log(`Rescore pending: ${pendingArticles.length} articles, ai=${aiCount}/${aiDailyLimit}`);

    const sourceTiers = new Map<string, string>();
    const allSources = await this.db.select().from(feedSource);
    for (const s of allSources) sourceTiers.set(s.id, s.tier);

    let rescored = 0, succeeded = 0, failed = 0;
    const rescoredIds = new Set<string>();
    for (const art of pendingArticles) {
      const srcUsed = perSourceCount.get(art.sourceName) || 0;
      if (srcUsed >= aiPerSourceLimit) continue;
      if (!await this.reserveAiCall(today, aiDailyLimit)) {
        this.logger.log('Rescore: daily limit reached');
        break;
      }
      aiCount++;
      perSourceCount.set(art.sourceName, srcUsed + 1);
      const tier = sourceTiers.get(art.feedSourceId) ?? 'signal';
      const [fullArt] = await this.db.select().from(article).where(eq(article.id, art.id));
      if (!fullArt) continue;
      const content = fullArt.summary || art.title;
      try {
        const result = await this.aiScoringService.scoreArticle(art.title, content, tier);
        if (!result.aiProcessed) { failed++; continue; }
        await this.db.delete(directionScore).where(eq(directionScore.articleId, art.id));
        for (const dir of DIRECTIONS) {
          const ev = result.directionScores[dir];
          await this.db.insert(directionScore).values({
            articleId: art.id, direction: dir,
            dimensionScores: ev?.dimensionScores ?? {},
            totalScore: ev?.normalizedScore ?? 0,
          });
        }
        await this.db.update(article).set({
          primaryDirection: result.primaryDirection,
          primaryScore: result.publishScore,
          summary: result.summary,
          aiProcessed: true,
          aiDegradeReason: null,
        }).where(eq(article.id, art.id));
        rescored++;
        succeeded++;
        rescoredIds.add(art.id);
      } catch (error: unknown) {
        const errMsg = error instanceof Error ? error.message : String(error);
        this.logger.error(`Rescore failed for "${art.title}": ${errMsg}`);
        failed++;
      }
    }
    if (shared) shared.aiCount = aiCount;
    this.logger.log(`Rescore: ${rescored} rescored, ${succeeded} ok, ${failed} fail`);
    return { rescored, succeeded, failed, rescoredIds };
  }

  // ─── Publish Gate ─────────────────────────────────────────

  private async executePublishGate(articles: { id: string }[], publishThreshold: number): Promise<number> {
    if (articles.length === 0) return 0;
    const articleIds = articles.map((a) => a.id);
    const allArticles = await this.db
      .select({ id: article.id, primaryDirection: article.primaryDirection, primaryScore: article.primaryScore, status: article.status })
      .from(article).where(inArray(article.id, articleIds));
    const primaryDirScores = await this.db.execute(sql`
      SELECT ds.article_id, ds.dimension_scores FROM direction_score ds
      JOIN article a ON ds.article_id = a.id AND ds.direction = a.primary_direction
      WHERE ds.article_id = ANY(${sql.join(articleIds.map((id) => sql`${id}`), sql`, `)}::uuid[])
    `) as unknown as { article_id: string; dimension_scores: Record<string, number> }[];
    const scoreMap = new Map<string, Record<string, number>>();
    for (const row of primaryDirScores) scoreMap.set(row.article_id, row.dimension_scores ?? {});
    let publishedCount = 0;
    for (const art of allArticles) {
      const passes = canPublishArticle({
        primaryDirection: art.primaryDirection, primaryScore: art.primaryScore,
        status: art.status, dimensionScores: scoreMap.get(art.id) ?? null, publishThreshold,
      });
      if (passes && art.status !== 'published') {
        await this.db.update(article).set({ status: 'published' }).where(eq(article.id, art.id));
        publishedCount++;
      } else if (!passes) {
        const updates: Record<string, unknown> = { frontPageRank: null };
        if (art.status === 'published' && art.primaryDirection !== null) updates.status = 'draft';
        await this.db.update(article).set(updates).where(eq(article.id, art.id));
      }
    }
    return publishedCount;
  }

  // ─── Config Helpers ───────────────────────────────────────

  private async getConfig(key: string, defaultValue: number): Promise<number> {
    const [config] = await this.db.select().from(appConfig).where(eq(appConfig.key, key));
    if (!config) return defaultValue;
    return typeof config.value === 'number' ? config.value : parseInt(String(config.value), 10) || defaultValue;
  }
  private async getAiCallCount(today: string): Promise<number> {
    const [config] = await this.db.select().from(appConfig).where(eq(appConfig.key, `ai_daily_count_${today}`));
    if (!config) return 0;
    return typeof config.value === 'number' ? config.value : parseInt(String(config.value), 10) || 0;
  }
  /** Atomically reserve a call before invoking the provider. Failed calls consume quota too. */
  private async reserveAiCall(today: string, limit: number): Promise<boolean> {
    const key = `ai_daily_count_${today}`;
    const rows = await this.db.execute(sql`
      INSERT INTO app_config (key, value, description)
      SELECT ${key}, '1'::jsonb, ${`AI calls on ${today}`}
      WHERE ${limit} > 0
      ON CONFLICT (key) DO UPDATE
        SET value = to_jsonb(COALESCE((app_config.value #>> '{}')::integer, 0) + 1)
        WHERE COALESCE((app_config.value #>> '{}')::integer, 0) < ${limit}
      RETURNING value
    `);
    return (rows as unknown as unknown[]).length > 0;
  }

  private async ensureDigest(today: string): Promise<void> {
    const [existing] = await this.db.select({ id: dailyDigest.id }).from(dailyDigest).where(eq(dailyDigest.digestDate, today));
    if (!existing) {
      try {
        await this.digestService.generateDigest(today);
        this.logger.log(`Digest generated for ${today}`);
      } catch (error: unknown) {
        const errMsg = error instanceof Error ? error.message : String(error);
        this.logger.error(`Failed to generate digest: ${errMsg}`);
      }
    }
  }

  private async processBatch<T>(items: T[], batchSize: number, fn: (item: T) => Promise<void>): Promise<void> {
    for (let i = 0; i < items.length; i += batchSize) {
      const batch = items.slice(i, i + batchSize);
      await Promise.allSettled(batch.map((item: T) => fn(item)));
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
