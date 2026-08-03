import { Injectable, Inject, Logger } from '@nestjs/common';
import {
  DRIZZLE_DATABASE,
  type PostgresJsDatabase,
} from '@lark-apaas/fullstack-nestjs-core';
import { eq, inArray } from 'drizzle-orm';
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
import * as crypto from 'crypto';
import Parser from 'rss-parser';

const DIRECTIONS = [
  'agent', 'model', 'coding', 'multi',
  'eval', 'infra', 'data', 'security',
] as const;

const STALE_DAYS = 7;
const CLUSTER_THRESHOLD = 0.5;

interface NewArticleInfo {
  id: string;
  title: string;
  url: string;
  content: string;
  feedSourceId: string;
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

  // ─── Main Pipeline ────────────────────────────────────────

  async runPipeline(): Promise<void> {
    this.logger.log('Pipeline started');

    // 1. Fetch enabled sources
    const sources = await this.db
      .select()
      .from(feedSource)
      .where(eq(feedSource.enabled, true));

    if (sources.length === 0) {
      this.logger.log('No enabled feed sources, skipping pipeline');
      return;
    }

    // Read config
    const concurrency = await this.getConfig('fetch_concurrency', 3);
    const retryCount = await this.getConfig('fetch_retry_count', 3);
    const aiDailyLimit = await this.getConfig('ai_daily_limit', 100);
    const today = new Date().toISOString().split('T')[0];

    this.logger.log(
      `Processing ${sources.length} sources (concurrency=${concurrency})`,
    );

    // 2. Fetch & parse in batches
    const allNewArticles: NewArticleInfo[] = [];
    await this.processBatch(sources, concurrency, async (source) => {
      const newArticles = await this.fetchAndParse(
        source,
        retryCount,
      );
      allNewArticles.push(...newArticles);
    });

    this.logger.log(
      `Collected ${allNewArticles.length} new articles`,
    );

    if (allNewArticles.length === 0) {
      this.logger.log('No new articles, checking digest');
      await this.ensureDigest(today);
      return;
    }

    // 3. Trace origins (signal tier only)
    const articlesForScoring: NewArticleInfo[] = [];
    for (const art of allNewArticles) {
      const source = sources.find(
        (s) => s.id === art.feedSourceId,
      );
      const tier = source?.tier ?? 'signal';

      if (tier === 'signal') {
        const traced = await this.traceOrigin(art);
        if (!traced) {
          await this.createReviewItem(art.id);
          await this.db
            .update(article)
            .set({ status: 'pending_review' })
            .where(eq(article.id, art.id));
          continue;
        }
      }
      articlesForScoring.push(art);
    }

    // 4. Quality filter
    const qualityPassed: NewArticleInfo[] = [];
    for (const art of articlesForScoring) {
      const passed = await this.qualityFilter(art);
      if (passed) {
        qualityPassed.push(art);
      }
    }

    this.logger.log(
      `${qualityPassed.length} articles passed quality filter`,
    );

    // 5. Cluster
    await this.clusterArticles(qualityPassed);

    // 6. AI scoring
    let aiCount = await this.getAiCallCount(today);
    for (const art of qualityPassed) {
      const source = sources.find(
        (s) => s.id === art.feedSourceId,
      );
      const tier = source?.tier ?? 'signal';

      let result;
      let aiUsed = false;

      if (aiCount < aiDailyLimit) {
        try {
          result = await this.aiScoringService.scoreArticle(
            art.title,
            art.content,
            tier,
          );
          if (result.aiProcessed) {
            aiUsed = true;
          }
        } catch {
          result = this.aiScoringService.ruleBasedScore(
            art.title,
            art.content,
            tier,
          );
        }
      } else {
        result = this.aiScoringService.ruleBasedScore(
          art.title,
          art.content,
          tier,
        );
      }

      // Write 8 direction_score records
      for (const dir of DIRECTIONS) {
        const dimScores = result.scores[dir] ?? {
          novelty: 0,
          depth: 0,
          impact: 0,
          authority: 0,
          timeliness: 0,
        };
        const totalScore =
          dimScores.novelty +
          dimScores.depth +
          dimScores.impact +
          dimScores.authority +
          dimScores.timeliness;

        await this.db.insert(directionScore).values({
          articleId: art.id,
          direction: dir,
          dimensionScores: dimScores,
          totalScore,
        });
      }

      // Determine primary direction (highest total)
      let primaryDir: string = DIRECTIONS[0];
      let primaryScore = 0;
      for (const dir of DIRECTIONS) {
        const dim = result.scores[dir];
        if (dim) {
          const total =
            dim.novelty +
            dim.depth +
            dim.impact +
            dim.authority +
            dim.timeliness;
          if (total > primaryScore) {
            primaryScore = total;
            primaryDir = dir;
          }
        }
      }

      await this.db
        .update(article)
        .set({
          primaryDirection: primaryDir,
          primaryScore,
          summary: result.summary,
          aiProcessed: result.aiProcessed,
        })
        .where(eq(article.id, art.id));

      if (aiUsed) {
        aiCount++;
        await this.incrementAiCount(today);
      }
    }

    // 7. Publish decision
    const publishThreshold = await this.getConfig(
      'publish_threshold',
      75,
    );
    for (const art of qualityPassed) {
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
        current.status !== 'pending_review'
      ) {
        await this.db
          .update(article)
          .set({ status: 'published' })
          .where(eq(article.id, art.id));
      }
    }

    this.logger.log(
      `Publish decision completed (threshold=${publishThreshold})`,
    );

    // 8. Daily digest
    await this.ensureDigest(today);

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

    await this.feedSourceService.updateFetchStats(
      source.id,
      true,
    );

    const newArticles: NewArticleInfo[] = [];
    const seenHashes = new Set<string>();

    for (const item of feed.items) {
      const title = (item.title ?? '').trim();
      const url = (item.link ?? '').trim();

      if (!title || !url) continue;

      const pubDate = item.pubDate
        ? new Date(item.pubDate)
        : null;
      const rawContent =
        item.content ?? item.contentSnippet ?? '';
      const content = decodeEntities(
        rawContent.replace(/<[^>]*>/g, '').trim(),
      );

      const contentHash = computeHash(title, url);

      // Check DB for duplicate
      const [existing] = await this.db
        .select({ id: article.id })
        .from(article)
        .where(eq(article.contentHash, contentHash));

      if (existing) continue;

      // Check in-batch duplicate
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
            pubDate && !isNaN(pubDate.getTime())
              ? pubDate
              : null,
          status: 'draft',
        })
        .returning({ id: article.id });

      newArticles.push({
        id: inserted.id,
        title,
        url,
        content,
        feedSourceId: source.id,
      });
    }

    this.logger.log(
      `Source "${source.name}": ${newArticles.length} new articles`,
    );
    return newArticles;
  }

  // ─── Origin Tracing ───────────────────────────────────────

  private async traceOrigin(
    art: NewArticleInfo,
  ): Promise<boolean> {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(
        () => controller.abort(),
        10000,
      );

      const response = await fetch(art.url, {
        redirect: 'follow',
        signal: controller.signal,
        headers: {
          'User-Agent': 'AI-News-Dashboard/1.0',
        },
      });

      clearTimeout(timeout);

      const finalUrl = response.url || art.url;

      if (finalUrl && finalUrl !== art.url) {
        await this.db
          .update(article)
          .set({ originalUrl: finalUrl })
          .where(eq(article.id, art.id));
      } else {
        await this.db
          .update(article)
          .set({ originalUrl: art.url })
          .where(eq(article.id, art.id));
      }

      return true;
    } catch (error: unknown) {
      const errMsg =
        error instanceof Error ? error.message : String(error);
      this.logger.warn(
        `Origin tracing failed for "${art.title}": ${errMsg}`,
      );
      return false;
    }
  }

  private async createReviewItem(
    articleId: string,
  ): Promise<void> {
    await this.db.insert(reviewItem).values({
      articleId,
      status: 'pending',
    });
  }

  // ─── Quality Filter ───────────────────────────────────────

  private async qualityFilter(
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
        await this.db.insert(qualityGate).values({
          articleId: art.id,
          reason: 'content_stale',
          detail:
            `Published at ${artRow.publishedAt instanceof Date ? artRow.publishedAt.toISOString() : String(artRow.publishedAt)}, ` +
            `more than ${STALE_DAYS} days old`,
        });
        await this.db
          .update(article)
          .set({ status: 'blocked' })
          .where(eq(article.id, art.id));
        return false;
      }
    }

    return true;
  }

  // ─── Event Clustering ─────────────────────────────────────

  private async clusterArticles(
    articles: NewArticleInfo[],
  ): Promise<void> {
    if (articles.length < 2) return;

    // Union-Find
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

    // Pairwise similarity
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

    // Group by root
    const groups = new Map<string, NewArticleInfo[]>();
    for (const art of articles) {
      const root = find(art.id);
      if (!groups.has(root)) {
        groups.set(root, []);
      }
      groups.get(root)!.push(art);
    }

    // Assign cluster IDs to groups with 2+ members
    for (const [, groupArticles] of groups) {
      if (groupArticles.length < 2) continue;

      // Compute word intersection across all members
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

      const ids = groupArticles.map(
        (a: NewArticleInfo) => a.id,
      );
      await this.db
        .update(article)
        .set({ clusterId })
        .where(inArray(article.id, ids));
    }

    this.logger.log(
      `Clustering completed: ${groups.size} groups`,
    );
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
          error instanceof Error
            ? error.message
            : String(error);
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
