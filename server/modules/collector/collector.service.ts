import { Injectable, Inject, Logger } from '@nestjs/common';
import {
  DRIZZLE_DATABASE,
  type PostgresJsDatabase,
} from '@lark-apaas/fullstack-nestjs-core';
import { eq, ne, inArray, and, isNotNull, sql } from 'drizzle-orm';
import {
  article,
  feedSource,
  directionScore,
  qualityGate,
  reviewItem,
  appConfig,
  dailyDigest,
} from '@server/database/schema';
import { FeedSourceService } from '../feed-source/feed-source.service';
import { DigestService } from '../digest/digest.service';
import { AiScoringService } from './ai-scoring.service';
import {
  normalizeUrl,
  normalizeTitle,
  shouldTrace,
  traceFromRssContent,
} from './trace-engine';
import { parseFeed } from './parsers';
import { normalizeItems } from './pipeline-normalize';
import { dedupBatch, filterAgainstExisting } from './pipeline-dedup';
import * as crypto from 'crypto';
import {
  ALL_DIRECTION_IDS as DIRECTIONS,
  normalizeDirection,
} from '@shared/directions';
import { canPublishArticle } from './publish-gate';

const STALE_DAYS = 7;
const CLUSTER_THRESHOLD = 0.5;

interface PipelineArticle {
  id: string;
  title: string;
  url: string;
  content: string;
  rawContent: string;
  feedSourceId: string;
  sourceUrl: string;
  sourceTier: string;
}

function jaccardSimilarity(text1: string, text2: string): number {
  const set1 = new Set(
    text1.toLowerCase().split(/\s+/).filter((w: string) => w.length > 2),
  );
  const set2 = new Set(
    text2.toLowerCase().split(/\s+/).filter((w: string) => w.length > 2),
  );
  const intersection = new Set([...set1].filter((x) => set2.has(x)));
  const union = new Set([...set1, ...set2]);
  return union.size === 0 ? 0 : intersection.size / union.size;
}

function getWordSet(text: string): Set<string> {
  return new Set(
    text.toLowerCase().split(/\s+/).filter((w: string) => w.length > 2),
  );
}

@Injectable()
export class CollectorService {
  private readonly logger = new Logger(CollectorService.name);
  private pipelineRunning = false;

  constructor(
    @Inject(DRIZZLE_DATABASE)
    private readonly db: PostgresJsDatabase,
    private readonly feedSourceService: FeedSourceService,
    private readonly digestService: DigestService,
    private readonly aiScoringService: AiScoringService,
  ) {}

  async runPipeline(): Promise<void> {
    if (this.pipelineRunning) {
      this.logger.log('Pipeline already running, skipping');
      return;
    }
    this.pipelineRunning = true;
    const startTime = Date.now();
    try {
      await this.executeFullPipeline();
    } catch (error: unknown) {
      const errMsg = error instanceof Error ? error.message : String(error);
      this.logger.error(`Pipeline failed: ${errMsg}`);
    } finally {
      this.pipelineRunning = false;
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      this.logger.log(`Pipeline finished in ${elapsed}s`);
    }
  }

  private async executeFullPipeline(): Promise<void> {
    this.logger.log('Pipeline started');
    const today = new Date().toISOString().split('T')[0];
    const concurrency = await this.getConfig('fetch_concurrency', 3);
    const retryCount = await this.getConfig('fetch_retry_count', 3);
    const aiDailyLimit = await this.getConfig('ai_daily_limit', 500);

    // ── Stage 1: Source Snapshot ──
    const sources = await this.db
      .select()
      .from(feedSource)
      .where(eq(feedSource.enabled, true));

    if (sources.length === 0) {
      this.logger.log('Stage 1: No enabled sources');
      await this.ensureDigest(today);
      return;
    }
    this.logger.log(`Stage 1: ${sources.length} enabled sources`);

    // ── Stage 2: Scheduled Fetch ──
    const allParsedItems: {
      items: Array<{ title: string; url: string; canonicalUrl?: string; publishedAt: Date | null; content: string; rawContent: string }>;
      feedSourceId: string;
      sourceName: string;
      sourceTier: string;
    }[] = [];
    let fetchOk = 0;
    let fetchFail = 0;

    await this.processBatch(sources, concurrency, async (source) => {
      let parsed = null;
      for (let attempt = 1; attempt <= retryCount; attempt++) {
        try {
          const result = await parseFeed(source.feedType, source.url);
          if (result.error) {
            if (attempt === retryCount) {
              await this.feedSourceService.updateFetchStats(source.id, false, result.error);
              return;
            }
            await this.sleep(1000 * Math.pow(2, attempt - 1));
            continue;
          }
          parsed = result;
          break;
        } catch (error: unknown) {
          const errMsg = error instanceof Error ? error.message : String(error);
          this.logger.warn(`Fetch attempt ${attempt}/${retryCount} for "${source.name}": ${errMsg}`);
          if (attempt === retryCount) {
            await this.feedSourceService.updateFetchStats(source.id, false, errMsg);
            return;
          }
          await this.sleep(1000 * Math.pow(2, attempt - 1));
        }
      }
      if (parsed && parsed.items.length > 0) {
        await this.feedSourceService.updateFetchStats(source.id, true);
        fetchOk++;
        allParsedItems.push({
          items: parsed.items,
          feedSourceId: source.id,
          sourceName: source.name,
          sourceTier: source.tier,
        });
      } else {
        fetchFail++;
        if (parsed) {
          await this.feedSourceService.updateFetchStats(source.id, false, 'No items in feed');
        }
      }
    });
    this.logger.log(`Stage 2: fetch ok=${fetchOk}, fail=${fetchFail}`);

    // ── Stage 3: Standardize ──
    let allNormalized: Array<{
      title: string; url: string; originalUrl: string; canonicalUrl: string | null;
      contentHash: string; content: string; rawContent: string; publishedAt: Date | null;
      sourceName: string; sourceTier: string; feedSourceId: string;
    }> = [];
    let normalizeDropped = 0;
    for (const batch of allParsedItems) {
      const result = normalizeItems(batch.items, {
        name: batch.sourceName,
        tier: batch.sourceTier,
        feedSourceId: batch.feedSourceId,
      });
      allNormalized = allNormalized.concat(result.items);
      normalizeDropped += result.dropped;
    }
    this.logger.log(`Stage 3: normalized=${allNormalized.length}, dropped=${normalizeDropped}`);

    // ── Stage 4: URL Dedup ──
    const recentArticles = await this.db
      .select({ url: article.url, contentHash: article.contentHash })
      .from(article)
      .where(sql`${article.collectedAt} > NOW() - INTERVAL '30 days'`);

    const existingHashes = new Set(recentArticles.map((r) => r.contentHash));
    const existingUrls = new Set(recentArticles.map((r) => {
      try {
        const parsed = new URL(r.url);
        parsed.hash = '';
        return parsed.toString().replace(/\?$/, '');
      } catch {
        return r.url;
      }
    }));

    const dedupInput = allNormalized.map((n) => ({
      url: n.url,
      contentHash: n.contentHash,
      title: n.title,
    }));

    const dbFiltered = filterAgainstExisting(dedupInput, existingHashes, existingUrls);
    const batchDedup = dedupBatch(dbFiltered.passed);
    const totalDeduped = dbFiltered.deduped + batchDedup.deduped;

    const newItemsMap = new Map(batchDedup.passed.map((p) => [p.contentHash, allNormalized.find((n) => n.contentHash === p.contentHash)!]));
    const newItems = batchDedup.passed.map((p) => newItemsMap.get(p.contentHash)!).filter(Boolean);

    this.logger.log(`Stage 4: passed=${newItems.length}, deduped=${totalDeduped}`);

    if (newItems.length === 0) {
      this.logger.log('No new articles after dedup');
      await this.ensureDigest(today);
      return;
    }

    const allNewArticles: PipelineArticle[] = [];
    for (const item of newItems) {
      const [inserted] = await this.db
        .insert(article)
        .values({
          title: item.title,
          url: item.url,
          contentHash: item.contentHash,
          sourceName: item.sourceName,
          feedSourceId: item.feedSourceId,
          publishedAt: item.publishedAt,
          status: 'draft',
        })
        .returning({ id: article.id });

      allNewArticles.push({
        id: inserted.id,
        title: item.title,
        url: item.url,
        content: item.content,
        rawContent: item.rawContent,
        feedSourceId: item.feedSourceId,
        sourceUrl: item.feedSourceId,
        sourceTier: item.sourceTier,
      });
    }
    this.logger.log(`Inserted ${allNewArticles.length} new articles`);

    // ── Stage 5: Origin Tracing ──
    let traceNeeded = 0;
    let traceOk = 0;
    let traceFail = 0;
    const traceFailIds = new Set<string>();

    for (const art of allNewArticles) {
      const needsTrace = shouldTrace(art.sourceTier, art.url);
      if (!needsTrace) continue;
      traceNeeded++;
      const traced = await this.traceOrigin(art);
      if (traced) {
        traceOk++;
      } else {
        traceFail++;
        traceFailIds.add(art.id);
      }
    }
    this.logger.log(`Stage 5: needed=${traceNeeded}, ok=${traceOk}, fail=${traceFail}`);

    // ── Stage 6: Content Classification (rule-based, before clustering) ──
    let classOk = 0;
    let classDegraded = 0;
    const classifiedArticles: PipelineArticle[] = [];

    for (const art of allNewArticles) {
      try {
        const source = sources.find((s) => s.id === art.feedSourceId);
        const tier = source?.tier ?? 'signal';
        const ruleResult = this.aiScoringService.ruleBasedScoreArticle(art.title, art.content, tier);

        await this.db.delete(directionScore).where(eq(directionScore.articleId, art.id));
        for (const dir of DIRECTIONS) {
          const ev = ruleResult.directionScores[dir];
          await this.db.insert(directionScore).values({
            articleId: art.id,
            direction: dir,
            dimensionScores: ev?.dimensionScores ?? {},
            totalScore: ev?.normalizedScore ?? 0,
          });
        }

        const setStatus = traceFailIds.has(art.id) ? 'pending_review' : undefined;
        const articleStatus = (!ruleResult.primaryDirection && !setStatus) ? 'draft'
          : setStatus ?? undefined;

        await this.db.update(article).set({
          primaryDirection: ruleResult.primaryDirection,
          primaryScore: ruleResult.publishScore,
          summary: ruleResult.summary,
          aiProcessed: false,
          aiDegradeReason: ruleResult.degradeReason,
          ...(articleStatus ? { status: articleStatus } : {}),
        }).where(eq(article.id, art.id));

        if (traceFailIds.has(art.id)) {
          await this.createReviewItem(art.id);
        }

        classOk++;
        classifiedArticles.push(art);
      } catch (error: unknown) {
        const errMsg = error instanceof Error ? error.message : String(error);
        this.logger.warn(`Classification failed for "${art.title}": ${errMsg}`);
        classDegraded++;
        if (traceFailIds.has(art.id)) {
          await this.db.update(article).set({ status: 'pending_review' }).where(eq(article.id, art.id));
          await this.createReviewItem(art.id);
        }
        classifiedArticles.push(art);
      }
    }
    this.logger.log(`Stage 6: classified=${classOk}, degraded=${classDegraded}`);

    // ── Stage 7: Event Clustering ──
    await this.clusterArticles(classifiedArticles);
    this.logger.log(`Stage 7: clustering completed for ${classifiedArticles.length} articles`);

    // ── Stage 8: AI Scoring (enhance rule results) ──
    const aiPerSourceLimit = await this.getConfig('ai_per_source_limit', 30);
    let aiCount = await this.getAiCallCount(today);

    const tierMap = new Map<string, string>();
    const sourceNameMap = new Map<string, string>();
    for (const s of sources) {
      tierMap.set(s.id, s.tier);
      sourceNameMap.set(s.id, s.name);
    }

    const perSourceCount = new Map<string, number>();
    const todayAiArticles = await this.db
      .select({ sourceName: article.sourceName })
      .from(article)
      .where(and(eq(article.aiProcessed, true), sql`${article.collectedAt}::date = ${today}::date`));
    for (const row of todayAiArticles) {
      perSourceCount.set(row.sourceName, (perSourceCount.get(row.sourceName) || 0) + 1);
    }

    const TIER_PRIORITY: Record<string, number> = { authoritative: 0, validation: 1, signal: 2 };
    const sortedForScoring = [...classifiedArticles].sort((a, b) => {
      const pA = TIER_PRIORITY[tierMap.get(a.feedSourceId) ?? 'signal'] ?? 2;
      const pB = TIER_PRIORITY[tierMap.get(b.feedSourceId) ?? 'signal'] ?? 2;
      if (pA !== pB) return pA - pB;
      const cntA = perSourceCount.get(sourceNameMap.get(a.feedSourceId) ?? '') || 0;
      const cntB = perSourceCount.get(sourceNameMap.get(b.feedSourceId) ?? '') || 0;
      return cntA - cntB;
    });

    let aiUsed = 0;
    let aiDegraded = 0;
    for (const art of sortedForScoring) {
      const source = sources.find((s) => s.id === art.feedSourceId);
      const tier = source?.tier ?? 'signal';
      const srcName = source?.name ?? 'unknown';
      const srcUsed = perSourceCount.get(srcName) || 0;

      let result;
      let usedAi = false;

      if (aiCount < aiDailyLimit && srcUsed < aiPerSourceLimit) {
        try {
          result = await this.aiScoringService.scoreArticle(art.title, art.content, tier);
          if (result.aiProcessed) { usedAi = true; }
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
          articleId: art.id,
          direction: dir,
          dimensionScores: ev?.dimensionScores ?? {},
          totalScore: ev?.normalizedScore ?? 0,
        });
      }

      const articleStatus = (!result.primaryDirection || !result.aiProcessed) ? 'draft' : undefined;
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
        perSourceCount.set(srcName, (perSourceCount.get(srcName) || 0) + 1);
        await this.incrementAiCount(today);
      }
    }
    this.logger.log(`Stage 8: ai=${aiUsed}/${aiDailyLimit}, degraded=${aiDegraded}`);

    // Auto-approve stuck pending_review
    const autoApproveThreshold = await this.getConfig('auto_approve_threshold', 60);
    const autoApproveHours = await this.getConfig('auto_approve_hours', 24);
    const autoApproved = await this.db.execute(sql`
      UPDATE article SET status = 'draft'
      WHERE status = 'pending_review'
        AND collected_at < NOW() - (${autoApproveHours} || ' hours')::interval
        AND primary_direction IS NOT NULL
        AND (primary_score IS NOT NULL AND primary_score >= ${autoApproveThreshold})
      RETURNING id
    `);
    const autoApprovedCount = (autoApproved as unknown as { id: string }[]).length;
    if (autoApprovedCount > 0) {
      this.logger.log(`Auto-approved ${autoApprovedCount} stuck pending_review articles`);
    }

    // ── Stage 9: Unified Quality Gate ──
    const publishThreshold = await this.getConfig('publish_threshold', 75);
    const minSuccessRate = await this.getConfig('source_min_success_rate', 30);
    const maxConsecFail = await this.getConfig('source_max_consecutive_failures', 5);

    let gateStale = 0;
    let gateUnreliable = 0;
    let gateDead = 0;
    let gateDup = 0;
    let gatePassed = 0;

    const allArticleIds = allNewArticles.map((a) => a.id);
    const articlesForGate = await this.db
      .select({ id: article.id, title: article.title, url: article.url, status: article.status, publishedAt: article.publishedAt, feedSourceId: article.feedSourceId })
      .from(article)
      .where(inArray(article.id, allArticleIds));

    const gateArticleMap = new Map(allNewArticles.map((a) => [a.id, a]));

    for (const artRow of articlesForGate) {
      const artInfo = gateArticleMap.get(artRow.id);
      if (!artInfo) continue;

      const checkUrl = await this.getFinalUrl(artRow.id);
      let blocked = false;
      let blockReason = '';
      let blockDetail = '';

      // Stale
      if (artRow.publishedAt) {
        const pubTime = artRow.publishedAt instanceof Date ? artRow.publishedAt.getTime() : new Date(artRow.publishedAt).getTime();
        if (pubTime < Date.now() - STALE_DAYS * 24 * 60 * 60 * 1000) {
          blocked = true;
          blockReason = 'content_stale';
          blockDetail = `Published > ${STALE_DAYS} days ago`;
          gateStale++;
        }
      }

      // Source reliability
      if (!blocked) {
        const [src] = await this.db
          .select({ totalFetches: feedSource.totalFetches, successFetches: feedSource.successFetches, consecutiveFailures: feedSource.consecutiveFailures })
          .from(feedSource)
          .where(eq(feedSource.id, artRow.feedSourceId));
        if (src && src.totalFetches >= 3) {
          const rate = Math.round((src.successFetches / src.totalFetches) * 100);
          if (rate < minSuccessRate || src.consecutiveFailures >= maxConsecFail) {
            blocked = true;
            blockReason = 'source_unreliable';
            blockDetail = `Rate ${rate}%, consec fail ${src.consecutiveFailures}`;
            gateUnreliable++;
          }
        }
      }

      // Link alive
      if (!blocked) {
        const alive = await this.checkLinkAlive(checkUrl);
        if (!alive.alive) {
          blocked = true;
          blockReason = 'link_dead';
          blockDetail = alive.detail;
          gateDead++;
        }
      }

      if (blocked) {
        await this.blockArticle(artRow.id, blockReason, blockDetail);
      }
    }

    // Dedup gate (batch-internal and cross-db URL/title)
    const aliveArticles = articlesForGate.filter((a) => {
      const info = gateArticleMap.get(a.id);
      return info !== undefined;
    }).map((a) => ({ ...a, artInfo: gateArticleMap.get(a.id)! })).filter((_a) => {
      return true;
    });

    // Use existing checkDuplicateGates for URL/title dedup on non-blocked articles
    const nonBlocked = allNewArticles.filter((a) => {
      return !allArticleIds.some((id) => id === a.id);
    });
    // Actually, run checkDuplicateGates on all new articles (it will skip already-blocked ones)
    const dedupPassed = await this.checkDuplicateGates(allNewArticles);
    gateDup = allNewArticles.length - dedupPassed.length;

    const passedGateIds = new Set(dedupPassed.map((a) => a.id));
    const gateAliveArticles = dedupPassed;
    gatePassed = gateAliveArticles.length;

    this.logger.log(`Stage 9: passed=${gatePassed}, stale=${gateStale}, unreliable=${gateUnreliable}, dead=${gateDead}, dup=${gateDup}`);

    // ── Stage 10: Publish ──
    const publishedCount = await this.executePublishGate(gateAliveArticles, publishThreshold);
    this.logger.log(`Stage 10: published=${publishedCount} (threshold=${publishThreshold})`);

    // ── Stage 11: Front Page + Digest ──
    await this.selectForFrontPage();
    await this.ensureDigest(today);

    // ── Stage 12: Auto-rescore if quota remains ──
    const finalAiCount = await this.getAiCallCount(today);
    if (finalAiCount < aiDailyLimit) {
      this.logger.log(`Stage 12: ${aiDailyLimit - finalAiCount} AI quota remaining, rescoring`);
      const rescoreResult = await this.rescorePending();
      this.logger.log(`Rescore: ${rescoreResult.succeeded} ok, ${rescoreResult.failed} fail`);
      const rescoredArticles = await this.db
        .select({ id: article.id })
        .from(article)
        .where(and(ne(article.status, 'published'), ne(article.status, 'blocked'), isNotNull(article.primaryDirection)));
      if (rescoredArticles.length > 0) {
        const rescoredPublished = await this.executePublishGate(rescoredArticles, publishThreshold);
        if (rescoredPublished > 0) {
          this.logger.log(`Post-rescore publish: ${rescoredPublished}`);
        }
      }
      await this.selectForFrontPage();
    }

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
      const errMsg = error instanceof Error ? error.message : String(error);
      this.logger.warn(`Origin tracing error for "${art.title}": ${errMsg}`);
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
      .from(article)
      .where(sql`${article.collectedAt} > NOW() - INTERVAL '30 days'`);

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
      if (dupUrlId && dupUrlId !== art.id) {
        await this.blockArticle(art.id, 'same_url', `URL matches article ${dupUrlId}`);
        blockedIds.add(art.id);
        continue;
      }
      const dupTitleId = dbTitleMap.get(nTitle);
      if (dupTitleId && dupTitleId !== art.id) {
        await this.blockArticle(art.id, 'same_title', `Title matches article ${dupTitleId}`);
        blockedIds.add(art.id);
        continue;
      }
    }

    const batchUrlMap = new Map<string, string>();
    const batchTitleMap = new Map<string, string>();
    for (const art of articles) {
      if (blockedIds.has(art.id)) continue;
      const nUrl = normalizeUrl(art.url);
      const nTitle = normalizeTitle(art.title);
      const existUrl = batchUrlMap.get(nUrl);
      if (existUrl) {
        await this.blockArticle(art.id, 'same_batch_url', `Batch URL matches ${existUrl}`);
        blockedIds.add(art.id);
        continue;
      }
      batchUrlMap.set(nUrl, art.id);
      const existTitle = batchTitleMap.get(nTitle);
      if (existTitle) {
        await this.blockArticle(art.id, 'same_batch_title', `Batch title matches ${existTitle}`);
        blockedIds.add(art.id);
        continue;
      }
      batchTitleMap.set(nTitle, art.id);
    }

    return articles.filter((a) => !blockedIds.has(a.id));
  }

  private async getFinalUrl(articleId: string): Promise<string> {
    const [row] = await this.db
      .select({ url: article.url, originalUrl: article.originalUrl })
      .from(article)
      .where(eq(article.id, articleId));
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
    } catch (error: unknown) {
      errorDetail = error instanceof Error ? error.message : String(error);
    }

    if (status === null || status >= 400) {
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 10000);
        const response = await fetch(url, { method: 'GET', redirect: 'follow', signal: controller.signal, headers: { 'User-Agent': UA, Range: 'bytes=0-0' } });
        clearTimeout(timer);
        status = response.status;
        errorDetail = '';
      } catch {
        return { alive: true, detail: `probe_timeout: ${errorDetail}` };
      }
    }

    if (status !== null && (status === 404 || status === 410)) {
      return { alive: false, detail: `HTTP ${status} for ${url}` };
    }
    if (status !== null && status >= 400) {
      return { alive: true, detail: `probe_status: ${status}` };
    }
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

    const find = (id: string): string => {
      if (parent[id] !== id) parent[id] = find(parent[id]);
      return parent[id];
    };
    const union = (id1: string, id2: string): void => {
      const root1 = find(id1);
      const root2 = find(id2);
      if (root1 !== root2) parent[root1] = root2;
    };

    for (let i = 0; i < articles.length; i++) {
      for (let j = i + 1; j < articles.length; j++) {
        if (jaccardSimilarity(articles[i].title, articles[j].title) >= CLUSTER_THRESHOLD) {
          union(articles[i].id, articles[j].id);
        }
      }
    }

    const groups = new Map<string, PipelineArticle[]>();
    for (const art of articles) {
      const root = find(art.id);
      if (!groups.has(root)) groups.set(root, []);
      groups.get(root)!.push(art);
    }

    for (const [, groupArticles] of groups) {
      if (groupArticles.length < 2) continue;
      const wordSets = groupArticles.map((a: PipelineArticle) => getWordSet(a.title));
      let commonWords = new Set(wordSets[0]);
      for (let i = 1; i < wordSets.length; i++) {
        commonWords = new Set([...commonWords].filter((w) => wordSets[i].has(w)));
      }

      let clusterId: string;
      if (commonWords.size > 0) {
        clusterId = crypto.createHash('md5').update([...commonWords].sort().join(' ')).digest('hex').slice(0, 16);
      } else {
        clusterId = crypto.createHash('md5').update(groupArticles.map((a: PipelineArticle) => a.id).sort().join(',')).digest('hex').slice(0, 16);
      }

      const ids = groupArticles.map((a: PipelineArticle) => a.id);
      await this.db.update(article).set({ clusterId }).where(inArray(article.id, ids));
    }

    this.logger.log(`Clustering completed: ${groups.size} groups`);
  }

  // ─── Front Page Diversity Selection ───────────────────────

  async selectForFrontPage(): Promise<void> {
    const limit = await this.getConfig('daily_front_page_limit', 20);
    const sourceCap = Math.max(2, Math.ceil(limit / 5));
    const directionCap = Math.max(2, Math.ceil(limit / 2));
    const DIRECTION_ORDER = [
      'model', 'agent', 'multimodal', 'coding',
      'infrastructure', 'data_eval', 'safety_governance',
      'applications', 'business_ecosystem',
    ];

    await this.db.execute(sql`
      UPDATE article SET front_page_rank = NULL, exclude_reason = NULL
      WHERE front_page_rank IS NOT NULL OR exclude_reason IS NOT NULL
    `);

    const publishThreshold = await this.getConfig('publish_threshold', 75);
    const candidatesResult = await this.db.execute(sql`
      SELECT id, source_name, primary_direction, primary_score
      FROM article
      WHERE status = 'published' AND primary_score >= ${publishThreshold}
        AND published_at > now() - interval '7 days'
      ORDER BY primary_score DESC
    `);

    interface CandidateRow {
      id: string;
      source_name: string;
      primary_direction: string | null;
      primary_score: number | null;
    }

    const rows = candidatesResult as unknown as CandidateRow[];
    const byDirection = new Map<string, CandidateRow[]>();
    for (const c of rows) {
      const d = normalizeDirection(c.primary_direction) ?? 'model';
      if (!byDirection.has(d)) byDirection.set(d, []);
      byDirection.get(d)!.push(c);
    }

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
          selected.push(c);
          sourceCounts.set(src, (sourceCounts.get(src) || 0) + 1);
          directionCounts.set(dir, (directionCounts.get(dir) || 0) + 1);
          changed = true;
          picked = true;
        }
      }
    }

    for (const c of rows) {
      if (selected.length >= limit) break;
      if (selected.some((s: CandidateRow) => s.id === c.id)) continue;
      const src = c.source_name || 'unknown';
      const dir = normalizeDirection(c.primary_direction) ?? 'model';
      if ((sourceCounts.get(src) || 0) >= sourceCap) continue;
      if ((directionCounts.get(dir) || 0) >= directionCap + 1 && selected.length < limit - 1) continue;
      selected.push(c);
      sourceCounts.set(src, (sourceCounts.get(src) || 0) + 1);
      directionCounts.set(dir, (directionCounts.get(dir) || 0) + 1);
    }

    for (let i = 0; i < selected.length; i++) {
      await this.db.execute(sql`UPDATE article SET front_page_rank = ${100 + i} WHERE id = ${selected[i].id}`);
    }

    const selectedIds = new Set(selected.map((s: CandidateRow) => s.id));
    for (const c of rows) {
      if (selectedIds.has(c.id)) continue;
      const src = c.source_name || 'unknown';
      const dir = normalizeDirection(c.primary_direction) ?? 'model';
      let reason: string;
      if ((sourceCounts.get(src) || 0) >= sourceCap) reason = 'source_cap';
      else if ((directionCounts.get(dir) || 0) >= directionCap) reason = 'direction_cap';
      else reason = 'limit_reached';
      await this.db.execute(sql`UPDATE article SET exclude_reason = ${reason} WHERE id = ${c.id}`);
    }

    this.logger.log(`Front page: selected ${selected.length}/${rows.length} candidates`);
  }

  // ─── Rescore Pending ──────────────────────────────────────

  async rescorePending(): Promise<{ rescored: number; succeeded: number; failed: number }> {
    const today = new Date().toISOString().split('T')[0];
    const aiDailyLimit = await this.getConfig('ai_daily_limit', 500);
    const aiPerSourceLimit = await this.getConfig('ai_per_source_limit', 30);
    let aiCount = await this.getAiCallCount(today);

    const pendingArticles = await this.db
      .select({ id: article.id, title: article.title, sourceName: article.sourceName, feedSourceId: article.feedSourceId })
      .from(article)
      .where(and(eq(article.aiProcessed, false), sql`${article.publishedAt} > NOW() - INTERVAL '7 days'`, sql`${article.sourceName} != 'arXiv cs.AI'`));

    this.logger.log(`Rescore pending: ${pendingArticles.length} articles, ai=${aiCount}/${aiDailyLimit}`);

    const sourceTiers = new Map<string, string>();
    const allSources = await this.db.select().from(feedSource);
    for (const s of allSources) sourceTiers.set(s.id, s.tier);

    const perSourceCount = new Map<string, number>();
    const todayAiArticles = await this.db
      .select({ sourceName: article.sourceName })
      .from(article)
      .where(and(eq(article.aiProcessed, true), sql`${article.collectedAt}::date = ${today}::date`));
    for (const row of todayAiArticles) {
      perSourceCount.set(row.sourceName, (perSourceCount.get(row.sourceName) || 0) + 1);
    }

    let rescored = 0;
    let succeeded = 0;
    let failed = 0;

    for (const art of pendingArticles) {
      if (aiCount >= aiDailyLimit) { this.logger.log('Rescore: daily limit reached'); break; }
      const srcUsed = perSourceCount.get(art.sourceName) || 0;
      if (srcUsed >= aiPerSourceLimit) continue;

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

        aiCount++;
        rescored++;
        succeeded++;
        perSourceCount.set(art.sourceName, (perSourceCount.get(art.sourceName) || 0) + 1);
        await this.incrementAiCount(today);
      } catch (error: unknown) {
        const errMsg = error instanceof Error ? error.message : String(error);
        this.logger.error(`Rescore failed for "${art.title}": ${errMsg}`);
        failed++;
      }
    }

    this.logger.log(`Rescore: ${rescored} rescored, ${succeeded} ok, ${failed} fail`);
    return { rescored, succeeded, failed };
  }

  // ─── Publish Gate ─────────────────────────────────────────

  private async executePublishGate(articles: { id: string }[], publishThreshold: number): Promise<number> {
    if (articles.length === 0) return 0;
    const articleIds = articles.map((a) => a.id);

    const allArticles = await this.db
      .select({ id: article.id, primaryDirection: article.primaryDirection, primaryScore: article.primaryScore, status: article.status })
      .from(article)
      .where(inArray(article.id, articleIds));

    const primaryDirScores = await this.db.execute(sql`
      SELECT ds.article_id, ds.dimension_scores
      FROM direction_score ds
      JOIN article a ON ds.article_id = a.id AND ds.direction = a.primary_direction
      WHERE ds.article_id = ANY(${sql.join(articleIds.map((id) => sql`${id}`), sql`, `)}::uuid[])
    `) as unknown as { article_id: string; dimension_scores: Record<string, number> }[];

    const scoreMap = new Map<string, Record<string, number>>();
    for (const row of primaryDirScores) scoreMap.set(row.article_id, row.dimension_scores ?? {});

    let publishedCount = 0;
    for (const art of allArticles) {
      const passes = canPublishArticle({
        primaryDirection: art.primaryDirection,
        primaryScore: art.primaryScore,
        status: art.status,
        dimensionScores: scoreMap.get(art.id) ?? null,
        publishThreshold,
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
    const key = `ai_daily_count_${today}`;
    const [config] = await this.db.select().from(appConfig).where(eq(appConfig.key, key));
    if (!config) return 0;
    return typeof config.value === 'number' ? config.value : parseInt(String(config.value), 10) || 0;
  }

  private async incrementAiCount(today: string): Promise<void> {
    const key = `ai_daily_count_${today}`;
    const count = await this.getAiCallCount(today);
    const [existing] = await this.db.select({ id: appConfig.id }).from(appConfig).where(eq(appConfig.key, key));
    if (existing) {
      await this.db.update(appConfig).set({ value: count + 1 }).where(eq(appConfig.key, key));
    } else {
      await this.db.insert(appConfig).values({ key, value: 1, description: `AI calls on ${today}` });
    }
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
