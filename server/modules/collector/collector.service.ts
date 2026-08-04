import { Injectable, Inject, Logger } from '@nestjs/common';
import {
  DRIZZLE_DATABASE,
  type PostgresJsDatabase,
} from '@lark-apaas/fullstack-nestjs-core';
import { eq, inArray, and, sql } from 'drizzle-orm';
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
import * as crypto from 'crypto';
import Parser from 'rss-parser';

import {
  ALL_DIRECTION_IDS as DIRECTIONS,
  normalizeDirection,
} from '@shared/directions';

const STALE_DAYS = 7;
const CLUSTER_THRESHOLD = 0.5;

interface NewArticleInfo {
  id: string;
  title: string;
  url: string;
  content: string;
  rawContent: string;
  feedSourceId: string;
  sourceUrl: string;
  sourceTier: string;
}

function decodeEntities(text: string): string {
  return text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&#x2F;/g, '/')
    .replace(/&nbsp;/g, ' ')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, code: string) =>
      String.fromCharCode(parseInt(code, 10)),
    )
    .replace(/&#x([0-9a-fA-F]+);/g, (_, code: string) =>
      String.fromCharCode(parseInt(code, 16)),
    );
}

function computeHash(title: string, url: string): string {
  return crypto
    .createHash('md5')
    .update(title + url)
    .digest('hex');
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

  private readonly parser = new Parser({
    timeout: 15000,
    maxRedirects: 5,
    headers: { 'User-Agent': 'AI-News-Dashboard/1.0' },
  });

  constructor(
    @Inject(DRIZZLE_DATABASE)
    private readonly db: PostgresJsDatabase,
    private readonly feedSourceService: FeedSourceService,
    private readonly digestService: DigestService,
    private readonly aiScoringService: AiScoringService,
  ) {}

  async runPipeline(): Promise<void> {
    this.logger.log('Pipeline started');

    const sources = await this.db
      .select()
      .from(feedSource)
      .where(eq(feedSource.enabled, true));

    if (sources.length === 0) {
      this.logger.log('No enabled feed sources, skipping pipeline');
      return;
    }

    const concurrency = await this.getConfig('fetch_concurrency', 3);
    const retryCount = await this.getConfig('fetch_retry_count', 3);
    const aiDailyLimit = await this.getConfig('ai_daily_limit', 500);
    const today = new Date().toISOString().split('T')[0];

    this.logger.log(
      `Processing ${sources.length} sources (concurrency=${concurrency})`,
    );

    // 1. Fetch & parse
    const allNewArticles: NewArticleInfo[] = [];
    await this.processBatch(sources, concurrency, async (source) => {
      const newArticles = await this.fetchAndParse(source, retryCount);
      allNewArticles.push(...newArticles);
    });

    const totalCollected = allNewArticles.length;
    this.logger.log(`Collected ${totalCollected} new articles`);

    if (totalCollected === 0) {
      this.logger.log('No new articles, checking digest');
      await this.ensureDigest(today);
      return;
    }

    // 2. Dedup quality gates
    const dedupPassed = await this.checkDuplicateGates(allNewArticles);
    this.logger.log(
      `${dedupPassed.length}/${totalCollected} passed dedup gates`,
    );

    // 3. Source reliability
    const reliabilityPassed: NewArticleInfo[] = [];
    for (const art of dedupPassed) {
      const passed = await this.checkSourceReliabilityGate(art);
      if (passed) reliabilityPassed.push(art);
    }
    this.logger.log(
      `${reliabilityPassed.length} passed source reliability`,
    );

    // 4. Content stale
    const stalePassed: NewArticleInfo[] = [];
    for (const art of reliabilityPassed) {
      const passed = await this.checkContentStale(art);
      if (passed) stalePassed.push(art);
    }
    this.logger.log(`${stalePassed.length} passed content stale`);

    // 5. Tracing
    const articlesForScoring: NewArticleInfo[] = [];
    let traceNeeded = 0;
    let traceSuccess = 0;
    let traceFailed = 0;

    for (const art of stalePassed) {
      const needsTrace = shouldTrace(art.sourceTier, art.url);
      if (needsTrace) {
        traceNeeded++;
        const traced = await this.traceOrigin(art);
        if (!traced) {
          traceFailed++;
          await this.createReviewItem(art.id);
          await this.db
            .update(article)
            .set({ status: 'pending_review' })
            .where(eq(article.id, art.id));
          continue;
        }
        traceSuccess++;
      }
      articlesForScoring.push(art);
    }

    this.logger.log(
      `Tracing: needed=${traceNeeded}, success=${traceSuccess}, failed=${traceFailed}`,
    );

    // 6. Link dead check (parallelized, concurrency=10)
    const linkAlive: NewArticleInfo[] = [];
    await this.processBatch(articlesForScoring, 10, async (art) => {
      const finalUrl = await this.getFinalUrl(art.id);
      const alive = await this.checkLinkAlive(finalUrl);
      if (!alive.alive) {
        await this.db.insert(qualityGate).values({
          articleId: art.id,
          reason: 'link_dead',
          detail: alive.detail,
        });
        await this.db
          .update(article)
          .set({ status: 'blocked' })
          .where(eq(article.id, art.id));
      } else {
        linkAlive.push(art);
      }
    });
    this.logger.log(
      `${linkAlive.length} passed link alive check`,
    );

    // 7. Cluster
    await this.clusterArticles(linkAlive);

    // 8. AI scoring (with per-source quota and tier-priority sorting)
    const aiPerSourceLimit = await this.getConfig('ai_per_source_limit', 30);
    let aiCount = await this.getAiCallCount(today);

    const tierMap = new Map<string, string>();
    for (const s of sources) {
      tierMap.set(s.id, s.tier);
    }
    const sourceNameMap = new Map<string, string>();
    for (const s of sources) {
      sourceNameMap.set(s.id, s.name);
    }

    const perSourceCount = new Map<string, number>();
    const todayAiArticles = await this.db
      .select({ sourceName: article.sourceName })
      .from(article)
      .where(
        and(
          eq(article.aiProcessed, true),
          sql`${article.collectedAt}::date = ${today}::date`,
        ),
      );
    for (const row of todayAiArticles) {
      perSourceCount.set(
        row.sourceName,
        (perSourceCount.get(row.sourceName) || 0) + 1,
      );
    }

    const TIER_PRIORITY: Record<string, number> = {
      authoritative: 0,
      validation: 1,
      signal: 2,
    };
    const sortedForScoring = [...linkAlive].sort((a, b) => {
      const tierA = tierMap.get(a.feedSourceId) ?? 'signal';
      const tierB = tierMap.get(b.feedSourceId) ?? 'signal';
      const pA = TIER_PRIORITY[tierA] ?? 2;
      const pB = TIER_PRIORITY[tierB] ?? 2;
      if (pA !== pB) return pA - pB;
      const nameA = sourceNameMap.get(a.feedSourceId) ?? '';
      const nameB = sourceNameMap.get(b.feedSourceId) ?? '';
      const cntA = perSourceCount.get(nameA) || 0;
      const cntB = perSourceCount.get(nameB) || 0;
      return cntA - cntB;
    });

    let degradedCount = 0;
    for (const art of sortedForScoring) {
      const source = sources.find((s) => s.id === art.feedSourceId);
      const tier = source?.tier ?? 'signal';
      const srcName = source?.name ?? 'unknown';
      const srcUsed = perSourceCount.get(srcName) || 0;

      let result;
      let aiUsed = false;

      if (aiCount < aiDailyLimit && srcUsed < aiPerSourceLimit) {
        try {
          result = await this.aiScoringService.scoreArticle(
            art.title,
            art.content,
            tier,
          );
          if (result.aiProcessed) {
            aiUsed = true;
          }
        } catch (outerError: unknown) {
          const errType = outerError instanceof Error
            ? outerError.constructor.name : typeof outerError;
          const errMsg = outerError instanceof Error
            ? outerError.message : String(outerError);
          const degradeReason = `[${errType}] ${errMsg}`;
          this.logger.error(
            `Outer AI scoring catch failed for "${art.title}": ${degradeReason}`,
          );
          result = {
            ...this.aiScoringService.ruleBasedScoreArticle(
              art.title,
              art.content,
              tier,
              degradeReason,
            ),
          };
        }
      } else {
        if (aiCount >= aiDailyLimit) {
          result = {
            ...this.aiScoringService.ruleBasedScoreArticle(
              art.title,
              art.content,
              tier,
              'ai_daily_limit_reached',
            ),
          };
        } else {
          result = {
            ...this.aiScoringService.ruleBasedScoreArticle(
              art.title,
              art.content,
              tier,
              `per_source_limit_reached(${srcName}:${srcUsed}/${aiPerSourceLimit})`,
            ),
          };
        }
        degradedCount++;
      }

      for (const dir of DIRECTIONS) {
        const ev = result.directionScores[dir];
        await this.db.insert(directionScore).values({
          articleId: art.id,
          direction: dir,
          dimensionScores: ev?.dimensionScores ?? {},
          totalScore: ev?.normalizedScore ?? 0,
        });
      }

      const articleStatus = (!result.primaryDirection || !result.aiProcessed)
        ? 'draft' : undefined;

      await this.db
        .update(article)
        .set({
          primaryDirection: result.primaryDirection,
          primaryScore: result.publishScore,
          summary: result.summary,
          aiProcessed: result.aiProcessed,
          aiDegradeReason: result.degradeReason,
          ...(articleStatus ? { status: articleStatus } : {}),
        })
        .where(eq(article.id, art.id));

      if (aiUsed) {
        aiCount++;
        perSourceCount.set(srcName, (perSourceCount.get(srcName) || 0) + 1);
        await this.incrementAiCount(today);
      }
    }

    this.logger.log(
      `AI scoring: ${aiCount}/${aiDailyLimit} used today, ` +
      `${aiPerSourceLimit} max per source, ` +
      `${degradedCount} degraded to rule-based`,
    );

    // 8.5 Auto-approve stuck pending_review articles
    const autoApproveThreshold = await this.getConfig('auto_approve_threshold', 60);
    const autoApproveHours = await this.getConfig('auto_approve_hours', 24);
    const autoApproved = await this.db.execute(sql`
      UPDATE article
      SET status = 'draft'
      WHERE status = 'pending_review'
        AND collected_at < NOW() - (${autoApproveHours} || ' hours')::interval
        AND (primary_score IS NOT NULL AND primary_score >= ${autoApproveThreshold})
      RETURNING id
    `);
    const autoApprovedCount = (autoApproved as unknown as { id: string }[]).length;
    if (autoApprovedCount > 0) {
      this.logger.log(
        `Auto-approved ${autoApprovedCount} stuck pending_review articles ` +
        `(threshold=${autoApproveThreshold}, hours=${autoApproveHours})`,
      );
    }

    // 9. Publish decision
    const publishThreshold = await this.getConfig('publish_threshold', 75);
    let publishedCount = 0;
    for (const art of linkAlive) {
      const [current] = await this.db
        .select({
          primaryScore: article.primaryScore,
          status: article.status,
        })
        .from(article)
        .where(eq(article.id, art.id));

      if (
        current &&
        (current.primaryScore ?? 0) >= publishThreshold &&
        current.status !== 'pending_review' &&
        current.status !== 'blocked'
      ) {
        await this.db
          .update(article)
          .set({ status: 'published' })
          .where(eq(article.id, art.id));
        publishedCount++;
      }
    }

    this.logger.log(
      `Publish: ${publishedCount} articles published (threshold=${publishThreshold})`,
    );

    // 10. Front page diversity selection
    await this.selectForFrontPage();

    // 11. Daily digest
    await this.ensureDigest(today);

    // 12. Auto-rescore pending articles if quota remains
    const finalAiCount = await this.getAiCallCount(today);
    if (finalAiCount < aiDailyLimit) {
      this.logger.log(
        `Auto-rescore: ${aiDailyLimit - finalAiCount} AI quota remaining, rescoring pending articles`,
      );
      const rescoreResult = await this.rescorePending();
      this.logger.log(
        `Auto-rescore: ${rescoreResult.succeeded} succeeded, ${rescoreResult.failed} failed`,
      );
      await this.selectForFrontPage();
    }

    this.logger.log('Pipeline completed successfully');
  }

  // ─── Fetch & Parse ────────────────────────────────────────

  private async fetchAndParse(
    source: typeof feedSource.$inferSelect,
    retryCount: number,
  ): Promise<NewArticleInfo[]> {
    let feed: Parser.Output<Record<string, unknown>> | null = null;

    for (let attempt = 1; attempt <= retryCount; attempt++) {
      try {
        feed = await this.parser.parseURL(source.url);
        break;
      } catch (error: unknown) {
        const errMsg =
          error instanceof Error ? error.message : String(error);
        this.logger.warn(
          `Fetch attempt ${attempt}/${retryCount} failed for ` +
            `"${source.name}": ${errMsg}`,
        );
        if (attempt === retryCount) {
          await this.feedSourceService.updateFetchStats(
            source.id,
            false,
            errMsg,
          );
          return [];
        }
      }
    }

    if (!feed || !feed.items) {
      await this.feedSourceService.updateFetchStats(
        source.id,
        false,
        'No items in feed',
      );
      return [];
    }

    await this.feedSourceService.updateFetchStats(source.id, true);

    const newArticles: NewArticleInfo[] = [];
    const seenHashes = new Set<string>();

    for (const item of feed.items) {
      const title = (item.title ?? '').trim();
      const url = (item.link ?? '').trim();

      if (!title || !url) continue;

      const pubDate = item.pubDate ? new Date(item.pubDate) : null;
      const rawHtml = item.content ?? item.contentSnippet ?? '';
      const content = decodeEntities(
        rawHtml.replace(/<[^>]*>/g, '').trim(),
      );

      const contentHash = computeHash(title, url);

      const [existing] = await this.db
        .select({ id: article.id })
        .from(article)
        .where(eq(article.contentHash, contentHash));

      if (existing) continue;
      if (seenHashes.has(contentHash)) continue;
      seenHashes.add(contentHash);

      const [inserted] = await this.db
        .insert(article)
        .values({
          title,
          url,
          contentHash,
          sourceName: source.name,
          feedSourceId: source.id,
          publishedAt:
            pubDate && !isNaN(pubDate.getTime()) ? pubDate : null,
          status: 'draft',
        })
        .returning({ id: article.id });

      newArticles.push({
        id: inserted.id,
        title,
        url,
        content,
        rawContent: rawHtml,
        feedSourceId: source.id,
        sourceUrl: source.url,
        sourceTier: source.tier,
      });
    }

    this.logger.log(
      `Source "${source.name}": ${newArticles.length} new articles`,
    );
    return newArticles;
  }

  // ─── Origin Tracing ───────────────────────────────────────

  private async traceOrigin(art: NewArticleInfo): Promise<boolean> {
    try {
      const origin = traceFromRssContent(
        art.url,
        art.rawContent,
        art.sourceUrl,
      );

      if (origin) {
        await this.db
          .update(article)
          .set({ originalUrl: origin })
          .where(eq(article.id, art.id));
        this.logger.log(
          `Traced "${art.title}" → ${origin}`,
        );
        return true;
      }

      this.logger.warn(
        `No origin found for "${art.title}"`,
      );
      return false;
    } catch (error: unknown) {
      const errMsg =
        error instanceof Error ? error.message : String(error);
      this.logger.warn(
        `Origin tracing error for "${art.title}": ${errMsg}`,
      );
      return false;
    }
  }

  private async createReviewItem(articleId: string): Promise<void> {
    await this.db.insert(reviewItem).values({
      articleId,
      status: 'pending',
    });
  }

  // ─── Quality Gates ───────────────────────────────────────

  private async checkDuplicateGates(
    articles: NewArticleInfo[],
  ): Promise<NewArticleInfo[]> {
    if (articles.length === 0) return [];

    const blockedIds = new Set<string>();

    const recentArticles = await this.db
      .select({
        id: article.id,
        title: article.title,
        url: article.url,
      })
      .from(article)
      .where(
        sql`${article.collectedAt} > NOW() - INTERVAL '30 days'`,
      );

    const dbUrlMap = new Map<string, string>();
    const dbTitleMap = new Map<string, string>();

    for (const recent of recentArticles) {
      const normUrl = normalizeUrl(recent.url);
      const normTitle = normalizeTitle(recent.title);
      if (!dbUrlMap.has(normUrl)) dbUrlMap.set(normUrl, recent.id);
      if (!dbTitleMap.has(normTitle)) dbTitleMap.set(normTitle, recent.id);
    }

    for (const art of articles) {
      if (blockedIds.has(art.id)) continue;

      const normUrl = normalizeUrl(art.url);
      const normTitle = normalizeTitle(art.title);

      const dupUrlId = dbUrlMap.get(normUrl);
      if (dupUrlId && dupUrlId !== art.id) {
        await this.blockArticle(art.id, 'same_url',
          `URL 与文章 ${dupUrlId} 重复（规范化后相同）`);
        blockedIds.add(art.id);
        continue;
      }

      const dupTitleId = dbTitleMap.get(normTitle);
      if (dupTitleId && dupTitleId !== art.id) {
        await this.blockArticle(art.id, 'same_title',
          `标题与文章 ${dupTitleId} 重复`);
        blockedIds.add(art.id);
        continue;
      }
    }

    const batchUrlMap = new Map<string, string>();
    const batchTitleMap = new Map<string, string>();

    for (const art of articles) {
      if (blockedIds.has(art.id)) continue;

      const normUrl = normalizeUrl(art.url);
      const normTitle = normalizeTitle(art.title);

      const existingUrlId = batchUrlMap.get(normUrl);
      if (existingUrlId) {
        await this.blockArticle(art.id, 'same_batch_url',
          `本批次内 URL 与文章 ${existingUrlId} 重复`);
        blockedIds.add(art.id);
        continue;
      }
      batchUrlMap.set(normUrl, art.id);

      const existingTitleId = batchTitleMap.get(normTitle);
      if (existingTitleId) {
        await this.blockArticle(art.id, 'same_batch_title',
          `本批次内标题与文章 ${existingTitleId} 重复`);
        blockedIds.add(art.id);
        continue;
      }
      batchTitleMap.set(normTitle, art.id);
    }

    return articles.filter((a) => !blockedIds.has(a.id));
  }

  private async checkSourceReliabilityGate(
    art: NewArticleInfo,
  ): Promise<boolean> {
    const minSuccessRate = await this.getConfig(
      'source_min_success_rate', 30,
    );
    const maxConsecutiveFailures = await this.getConfig(
      'source_max_consecutive_failures', 5,
    );

    const [source] = await this.db
      .select({
        totalFetches: feedSource.totalFetches,
        successFetches: feedSource.successFetches,
        consecutiveFailures: feedSource.consecutiveFailures,
      })
      .from(feedSource)
      .where(eq(feedSource.id, art.feedSourceId));

    if (!source) return true;
    if (source.totalFetches < 3) return true;

    const successRate = Math.round(
      (source.successFetches / source.totalFetches) * 100,
    );

    if (
      successRate < minSuccessRate ||
      source.consecutiveFailures >= maxConsecutiveFailures
    ) {
      await this.blockArticle(art.id, 'source_unreliable',
        `源成功率 ${successRate}%（阈值 ${minSuccessRate}%），` +
        `连续失败 ${source.consecutiveFailures} 次（阈值 ${maxConsecutiveFailures}）`);
      return false;
    }

    return true;
  }

  private async checkContentStale(
    art: NewArticleInfo,
  ): Promise<boolean> {
    const [artRow] = await this.db
      .select({ publishedAt: article.publishedAt })
      .from(article)
      .where(eq(article.id, art.id));

    if (artRow?.publishedAt) {
      const pubTime =
        artRow.publishedAt instanceof Date
          ? artRow.publishedAt.getTime()
          : new Date(artRow.publishedAt).getTime();
      const staleThreshold =
        Date.now() - STALE_DAYS * 24 * 60 * 60 * 1000;

      if (pubTime < staleThreshold) {
        await this.blockArticle(art.id, 'content_stale',
          `发布时间 ${artRow.publishedAt instanceof Date ? artRow.publishedAt.toISOString() : String(artRow.publishedAt)}，` +
          `超过 ${STALE_DAYS} 天`);
        return false;
      }
    }

    return true;
  }

  private async getFinalUrl(articleId: string): Promise<string> {
    const [row] = await this.db
      .select({ url: article.url, originalUrl: article.originalUrl })
      .from(article)
      .where(eq(article.id, articleId));

    if (!row) return '';
    return row.originalUrl || row.url;
  }

  private async checkLinkAlive(
    url: string,
  ): Promise<{ alive: boolean; detail: string }> {
    if (!url) return { alive: true, detail: '' };

    const UA = 'Mozilla/5.0 (compatible; AI-News-Bot/1.0)';

    let status: number | null = null;
    let errorDetail = '';

    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 10000);
      const response = await fetch(url, {
        method: 'HEAD',
        redirect: 'follow',
        signal: controller.signal,
        headers: { 'User-Agent': UA },
      });
      clearTimeout(timer);
      status = response.status;
    } catch (error: unknown) {
      errorDetail = error instanceof Error ? error.message : String(error);
    }

    if (status === null || status >= 400) {
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 10000);
        const response = await fetch(url, {
          method: 'GET',
          redirect: 'follow',
          signal: controller.signal,
          headers: { 'User-Agent': UA, Range: 'bytes=0-0' },
        });
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

  private async blockArticle(
    articleId: string,
    reason: string,
    detail: string,
  ): Promise<void> {
    await this.db.insert(qualityGate).values({
      articleId,
      reason,
      detail,
    });
    await this.db
      .update(article)
      .set({ status: 'blocked' })
      .where(eq(article.id, articleId));
  }

  // ─── Event Clustering ─────────────────────────────────────

  private async clusterArticles(
    articles: NewArticleInfo[],
  ): Promise<void> {
    if (articles.length < 2) return;

    const parent: Record<string, string> = {};
    for (const art of articles) {
      parent[art.id] = art.id;
    }

    const find = (id: string): string => {
      if (parent[id] !== id) {
        parent[id] = find(parent[id]);
      }
      return parent[id];
    };

    const union = (id1: string, id2: string): void => {
      const root1 = find(id1);
      const root2 = find(id2);
      if (root1 !== root2) {
        parent[root1] = root2;
      }
    };

    for (let i = 0; i < articles.length; i++) {
      for (let j = i + 1; j < articles.length; j++) {
        const sim = jaccardSimilarity(
          articles[i].title,
          articles[j].title,
        );
        if (sim >= CLUSTER_THRESHOLD) {
          union(articles[i].id, articles[j].id);
        }
      }
    }

    const groups = new Map<string, NewArticleInfo[]>();
    for (const art of articles) {
      const root = find(art.id);
      if (!groups.has(root)) {
        groups.set(root, []);
      }
      groups.get(root)!.push(art);
    }

    for (const [, groupArticles] of groups) {
      if (groupArticles.length < 2) continue;

      const wordSets = groupArticles.map(
        (a: NewArticleInfo) => getWordSet(a.title),
      );
      let commonWords = new Set(wordSets[0]);
      for (let i = 1; i < wordSets.length; i++) {
        commonWords = new Set(
          [...commonWords].filter((w) => wordSets[i].has(w)),
        );
      }

      let clusterId: string;
      if (commonWords.size > 0) {
        clusterId = crypto
          .createHash('md5')
          .update([...commonWords].sort().join(' '))
          .digest('hex')
          .slice(0, 16);
      } else {
        clusterId = crypto
          .createHash('md5')
          .update(
            groupArticles
              .map((a: NewArticleInfo) => a.id)
              .sort()
              .join(','),
          )
          .digest('hex')
          .slice(0, 16);
      }

      const ids = groupArticles.map((a: NewArticleInfo) => a.id);
      await this.db
        .update(article)
        .set({ clusterId })
        .where(inArray(article.id, ids));
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
      if (
        (directionCounts.get(dir) || 0) >= directionCap + 1 &&
        selected.length < limit - 1
      ) continue;
      selected.push(c);
      sourceCounts.set(src, (sourceCounts.get(src) || 0) + 1);
      directionCounts.set(dir, (directionCounts.get(dir) || 0) + 1);
    }

    for (let i = 0; i < selected.length; i++) {
      await this.db.execute(sql`
        UPDATE article SET front_page_rank = ${100 + i} WHERE id = ${selected[i].id}
      `);
    }

    const selectedIds = new Set(selected.map((s: CandidateRow) => s.id));
    for (const c of rows) {
      if (selectedIds.has(c.id)) continue;
      const src = c.source_name || 'unknown';
      const dir = normalizeDirection(c.primary_direction) ?? 'model';
      let reason: string;
      if ((sourceCounts.get(src) || 0) >= sourceCap) {
        reason = 'source_cap';
      } else if ((directionCounts.get(dir) || 0) >= directionCap) {
        reason = 'direction_cap';
      } else {
        reason = 'limit_reached';
      }
      await this.db.execute(sql`
        UPDATE article SET exclude_reason = ${reason} WHERE id = ${c.id}
      `);
    }

    this.logger.log(
      `Front page: selected ${selected.length}/${rows.length} candidates`,
    );
  }

  // ─── Rescore Pending (AI 补打分) ────────────────────────────

  async rescorePending(): Promise<{
    rescored: number;
    succeeded: number;
    failed: number;
  }> {
    const today = new Date().toISOString().split('T')[0];
    const aiDailyLimit = await this.getConfig('ai_daily_limit', 500);
    const aiPerSourceLimit = await this.getConfig('ai_per_source_limit', 30);
    let aiCount = await this.getAiCallCount(today);

    const pendingArticles = await this.db
      .select({
        id: article.id,
        title: article.title,
        sourceName: article.sourceName,
        feedSourceId: article.feedSourceId,
      })
      .from(article)
      .where(
        and(
          eq(article.aiProcessed, false),
          sql`${article.publishedAt} > NOW() - INTERVAL '7 days'`,
          sql`${article.sourceName} != 'arXiv cs.AI'`,
        ),
      );

    this.logger.log(
      `Rescore pending: found ${pendingArticles.length} articles, ` +
      `ai count today: ${aiCount}/${aiDailyLimit}`,
    );

    const sourceTiers = new Map<string, string>();
    const allSources = await this.db.select().from(feedSource);
    for (const s of allSources) {
      sourceTiers.set(s.id, s.tier);
    }

    const perSourceCount = new Map<string, number>();
    const todayAiArticles = await this.db
      .select({ sourceName: article.sourceName })
      .from(article)
      .where(
        and(
          eq(article.aiProcessed, true),
          sql`${article.collectedAt}::date = ${today}::date`,
        ),
      );
    for (const row of todayAiArticles) {
      perSourceCount.set(
        row.sourceName,
        (perSourceCount.get(row.sourceName) || 0) + 1,
      );
    }

    let rescored = 0;
    let succeeded = 0;
    let failed = 0;

    for (const art of pendingArticles) {
      if (aiCount >= aiDailyLimit) {
        this.logger.log('Rescore: daily AI limit reached, stopping');
        break;
      }
      const srcUsed = perSourceCount.get(art.sourceName) || 0;
      if (srcUsed >= aiPerSourceLimit) {
        this.logger.log(
          `Rescore: per-source limit reached for ${art.sourceName} (${srcUsed}/${aiPerSourceLimit})`,
        );
        continue;
      }

      const tier = sourceTiers.get(art.feedSourceId) ?? 'signal';
      const [fullArt] = await this.db
        .select()
        .from(article)
        .where(eq(article.id, art.id));

      if (!fullArt) continue;

      const content = fullArt.summary || art.title;

      try {
        const result = await this.aiScoringService.scoreArticle(
          art.title,
          content,
          tier,
        );

        if (!result.aiProcessed) {
          failed++;
          continue;
        }

        await this.db
          .delete(directionScore)
          .where(eq(directionScore.articleId, art.id));

        for (const dir of DIRECTIONS) {
          const ev = result.directionScores[dir];
          await this.db.insert(directionScore).values({
            articleId: art.id,
            direction: dir,
            dimensionScores: ev?.dimensionScores ?? {},
            totalScore: ev?.normalizedScore ?? 0,
          });
        }

        await this.db
          .update(article)
          .set({
            primaryDirection: result.primaryDirection,
            primaryScore: result.publishScore,
            summary: result.summary,
            aiProcessed: true,
            aiDegradeReason: null,
          })
          .where(eq(article.id, art.id));

        aiCount++;
        rescored++;
        succeeded++;
        perSourceCount.set(
          art.sourceName,
          (perSourceCount.get(art.sourceName) || 0) + 1,
        );
        await this.incrementAiCount(today);
      } catch (error: unknown) {
        const errMsg = error instanceof Error ? error.message : String(error);
        this.logger.error(
          `Rescore failed for "${art.title}": ${errMsg}`,
        );
        failed++;
      }
    }

    this.logger.log(
      `Rescore completed: ${rescored} rescored, ${succeeded} succeeded, ${failed} failed`,
    );

    return { rescored, succeeded, failed };
  }

  // ─── Config Helpers ───────────────────────────────────────

  private async getConfig(
    key: string,
    defaultValue: number,
  ): Promise<number> {
    const [config] = await this.db
      .select()
      .from(appConfig)
      .where(eq(appConfig.key, key));
    if (!config) return defaultValue;
    return typeof config.value === 'number'
      ? config.value
      : parseInt(String(config.value), 10) || defaultValue;
  }

  private async getAiCallCount(today: string): Promise<number> {
    const key = `ai_daily_count_${today}`;
    const [config] = await this.db
      .select()
      .from(appConfig)
      .where(eq(appConfig.key, key));
    if (!config) return 0;
    return typeof config.value === 'number'
      ? config.value
      : parseInt(String(config.value), 10) || 0;
  }

  private async incrementAiCount(today: string): Promise<void> {
    const key = `ai_daily_count_${today}`;
    const count = await this.getAiCallCount(today);
    const [existing] = await this.db
      .select({ id: appConfig.id })
      .from(appConfig)
      .where(eq(appConfig.key, key));

    if (existing) {
      await this.db
        .update(appConfig)
        .set({ value: count + 1 })
        .where(eq(appConfig.key, key));
    } else {
      await this.db.insert(appConfig).values({
        key,
        value: 1,
        description: `AI calls on ${today}`,
      });
    }
  }

  private async ensureDigest(today: string): Promise<void> {
    const [existing] = await this.db
      .select({ id: dailyDigest.id })
      .from(dailyDigest)
      .where(eq(dailyDigest.digestDate, today));

    if (!existing) {
      try {
        await this.digestService.generateDigest(today);
        this.logger.log(`Digest generated for ${today}`);
      } catch (error: unknown) {
        const errMsg =
          error instanceof Error ? error.message : String(error);
        this.logger.error(
          `Failed to generate digest for ${today}: ${errMsg}`,
        );
      }
    }
  }

  // ─── Batch Processing ─────────────────────────────────────

  private async processBatch<T>(
    items: T[],
    batchSize: number,
    fn: (item: T) => Promise<void>,
  ): Promise<void> {
    for (let i = 0; i < items.length; i += batchSize) {
      const batch = items.slice(i, i + batchSize);
      await Promise.allSettled(
        batch.map((item: T) => fn(item)),
      );
    }
  }
}
