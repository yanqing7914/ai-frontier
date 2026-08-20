import {
  DRIZZLE_DATABASE,
  type PostgresJsDatabase,
} from '@lark-apaas/fullstack-nestjs-core';
import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import {
  eq,
  and,
  or,
  count,
  desc,
  inArray,
  gte,
  isNotNull,
  isNull,
  ne,
  sql,
} from 'drizzle-orm';
import {
  article,
  feedSource,
  directionScore,
  qualityGate,
  appConfig,
} from '@server/database/schema';
import type {
  HotArticleItem,
  WorkbenchOverview,
  WorkbenchArticleItem,
  DirectionScoreItem,
  ScoreEvidence,
  ArticleTrace,
  QualityGateItem,
  PaginatedResponse,
  DimensionScores,
  Direction,
  ArticleStatus,
  QualityGateReason,
  TraceStatus,
  ExcludeReason,
} from '@shared/api.interface';
import { getOriginPolicy } from '../collector/trace-engine';
import { normalizeDirection } from '@shared/api.interface';
import { ALL_DIRECTION_IDS } from '@shared/directions';

@Injectable()
export class ArticleService {
  constructor(
    @Inject(DRIZZLE_DATABASE)
    private readonly db: PostgresJsDatabase,
  ) {}

  async getHotArticles(params: {
    page: number;
    pageSize: number;
    directions?: string[];
  }): Promise<PaginatedResponse<HotArticleItem>> {
    const { page, pageSize, directions } = params;
    const offset = (page - 1) * pageSize;
    const publishThreshold = await this.getPublishThreshold();

    const normalizedDirections = directions && directions.length > 0
      ? directions.map((d: string) => normalizeDirection(d)).filter((d): d is Direction => d !== null)
      : undefined;

    // Today's feed is intentionally a Shanghai-calendar view. Historical
    // published articles belong to archive endpoints and must not silently
    // backfill the page when today's selection is small.
    const baseConditions = [
      eq(article.status, 'published'),
      sql`(
        coalesce(${article.publishedAt}, ${article.collectedAt}) AT TIME ZONE 'Asia/Shanghai'
      )::date = (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Shanghai')::date`,
      gte(article.primaryScore, publishThreshold),
    ];
    if (normalizedDirections && normalizedDirections.length > 0) {
      baseConditions.push(inArray(article.primaryDirection, normalizedDirections));
    }

    // The bounded front page is intentionally strict: archive/supplement items
    // must be exposed by a separate endpoint and never mixed into this feed.
    const rankedWhere = and(...baseConditions, isNotNull(article.frontPageRank), isNull(article.excludeReason));
    const [rankedCountResult] = await Promise.all([
      this.db.select({ count: count() }).from(article).where(rankedWhere),
    ]);
    const rankedCount = Number(rankedCountResult[0]?.count ?? 0);
    const total = rankedCount;

    const pageItems: Array<{
      id: string;
      title: string;
      url: string;
      originalUrl: string | null;
      summary: string | null;
      sourceName: string;
      primaryDirection: string | null;
      primaryScore: number | null;
      publishedAt: Date | null;
      clusterId: string | null;
      frontPageRank: number | null;
    }> = [];

    if (offset < rankedCount) {
      const rankedPage = await this.db
        .select({
          id: article.id,
          title: article.title,
          url: article.url,
          originalUrl: article.originalUrl,
          summary: article.summary,
          sourceName: article.sourceName,
          primaryDirection: article.primaryDirection,
          primaryScore: article.primaryScore,
          publishedAt: article.publishedAt,
          clusterId: article.clusterId,
          frontPageRank: article.frontPageRank,
        })
        .from(article)
        .where(rankedWhere)
        .orderBy(article.frontPageRank)
        .limit(pageSize)
        .offset(offset);
      pageItems.push(...rankedPage);
    }

    const rows = pageItems;

    // Batch compute cluster counts
    const clusterIds = rows
      .map((r) => r.clusterId)
      .filter((id): id is string => id !== null);

    const uniqueClusterIds = [...new Set(clusterIds)];
    const clusterCountMap = new Map<string, number>();

    if (uniqueClusterIds.length > 0) {
      const clusterCounts = await this.db
        .select({
          clusterId: article.clusterId,
          count: count(),
        })
        .from(article)
        .where(inArray(article.clusterId, uniqueClusterIds))
        .groupBy(article.clusterId);

      for (const row of clusterCounts) {
        if (row.clusterId) {
          clusterCountMap.set(row.clusterId, Number(row.count));
        }
      }
    }

    const items: HotArticleItem[] = rows.map((row) => ({
      id: row.id,
      title: row.title,
      url: row.url,
      originalUrl: row.originalUrl,
      summary: row.summary ?? '',
      sourceName: row.sourceName,
      primaryDirection: normalizeDirection(row.primaryDirection) ?? 'model',
      primaryScore: row.primaryScore ?? 0,
      publishedAt: row.publishedAt?.toISOString() ?? '',
      clusterCount: row.clusterId
        ? (clusterCountMap.get(row.clusterId) ?? 1)
        : 1,
      frontPageRank: row.frontPageRank ?? null,
    }));

    return { items, total };
  }

  /** Keep the read API in sync with the configurable collector publication gate. */
  private async getPublishThreshold(): Promise<number> {
    const [config] = await this.db
      .select({ value: appConfig.value })
      .from(appConfig)
      .where(eq(appConfig.key, 'publish_threshold'));
    const raw = config?.value;
    const parsed = typeof raw === 'number' ? raw : Number(raw);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : 75;
  }

  async getWorkbenchOverview(): Promise<WorkbenchOverview> {
    const totalCollectedResult = await this.db
      .select({ count: count() })
      .from(article);
    const totalCollected = Number(totalCollectedResult[0]?.count ?? 0);

    const publishedResult = await this.db
      .select({ count: count() })
      .from(article)
      .where(eq(article.status, 'published'));
    const publishedCount = Number(publishedResult[0]?.count ?? 0);

    const draftResult = await this.db
      .select({ count: count() })
      .from(article)
      .where(eq(article.status, 'draft'));
    const draftCount = Number(draftResult[0]?.count ?? 0);

    const pendingResult = await this.db
      .select({ count: count() })
      .from(article)
      .where(eq(article.status, 'pending_review'));
    const pendingReviewCount = Number(pendingResult[0]?.count ?? 0);

    // AI daily limit config
    const aiLimitRows = await this.db
      .select()
      .from(appConfig)
      .where(eq(appConfig.key, 'ai_daily_limit'));
    const rawLimit = aiLimitRows[0]?.value;
    const parsedLimit = Number(rawLimit);
    const aiDailyLimit = isNaN(parsedLimit) ? 200 : parsedLimit;

    // AI calls today config
    const today = new Date().toISOString().slice(0, 10);
    const todayKey = `ai_daily_count_${today}`;
    const todayRows = await this.db
      .select()
      .from(appConfig)
      .where(eq(appConfig.key, todayKey));
    const rawToday = todayRows[0]?.value;
    const parsedToday = Number(rawToday);
    const aiCallsToday = isNaN(parsedToday) ? 0 : parsedToday;

    return {
      totalCollected,
      publishedCount,
      draftCount,
      pendingReviewCount,
      aiCallsToday,
      aiDailyLimit,
      aiDegraded: aiCallsToday >= aiDailyLimit,
    };
  }

  async getWorkbenchArticles(params: {
    page: number;
    pageSize: number;
    status?: string;
    direction?: string;
    sortBy?: string;
  }): Promise<PaginatedResponse<WorkbenchArticleItem>> {
    const { page, pageSize, status, direction } = params;
    const offset = (page - 1) * pageSize;

    const conditions = [];
    if (status) {
      conditions.push(eq(article.status, status));
    }
    if (direction) {
      const normDir = normalizeDirection(direction);
      if (normDir) conditions.push(eq(article.primaryDirection, normDir));
    }
    const whereClause =
      conditions.length > 0 ? and(...conditions) : undefined;

    const rows = await this.db
      .select({
        id: article.id,
        title: article.title,
        sourceName: article.sourceName,
        primaryDirection: article.primaryDirection,
        primaryScore: article.primaryScore,
        status: article.status,
        aiProcessed: article.aiProcessed,
        aiDegradeReason: article.aiDegradeReason,
        excludeReason: article.excludeReason,
        collectedAt: article.collectedAt,
      })
      .from(article)
      .where(whereClause)
      .orderBy(desc(article.primaryScore))
      .limit(pageSize)
      .offset(offset);

    const totalResult = await this.db
      .select({ count: count() })
      .from(article)
      .where(whereClause);
    const total = Number(totalResult[0]?.count ?? 0);

    const items: WorkbenchArticleItem[] = rows.map((row) => ({
      id: row.id,
      title: row.title,
      sourceName: row.sourceName,
      primaryDirection: normalizeDirection(row.primaryDirection),
      primaryScore: row.primaryScore,
      status: row.status as ArticleStatus,
      aiProcessed: row.aiProcessed,
      aiDegradeReason: row.aiDegradeReason,
      excludeReason: row.excludeReason as ExcludeReason | null,
      collectedAt: row.collectedAt.toISOString(),
    }));

    return { items, total };
  }

  async getArticleScores(
    id: string,
  ): Promise<{ items: DirectionScoreItem[] }> {
    const existing = await this.db
      .select({ id: article.id })
      .from(article)
      .where(eq(article.id, id))
      .limit(1);

    if (existing.length === 0) {
      throw new NotFoundException(`Article ${id} not found`);
    }

    const scores = await this.db
      .select({
        direction: directionScore.direction,
        totalScore: directionScore.totalScore,
        dimensionScores: directionScore.dimensionScores,
        evidence: directionScore.evidence,
      })
      .from(directionScore)
      .where(eq(directionScore.articleId, id));

    const grouped = new Map<string, {
      totalScore: number;
      dimensionScores: DimensionScores;
      evidence: ScoreEvidence[];
    }>();

    for (const row of scores) {
      const dir = normalizeDirection(row.direction);
      if (!dir) continue;
      const existing = grouped.get(dir);
      const rowScores = (row.dimensionScores ?? {}) as DimensionScores;
      const rowEvidence = Array.isArray(row.evidence)
        ? row.evidence as ScoreEvidence[]
        : [];
      if (existing) {
        const merged: DimensionScores = { ...existing.dimensionScores };
        for (const [k, v] of Object.entries(rowScores)) {
          merged[k] = Math.max(merged[k] ?? 0, v as number);
        }
        grouped.set(dir, {
          totalScore: Math.max(existing.totalScore, row.totalScore),
          dimensionScores: merged,
          evidence: [...existing.evidence, ...rowEvidence],
        });
      } else {
        grouped.set(dir, {
          totalScore: row.totalScore,
          dimensionScores: { ...rowScores },
          evidence: rowEvidence,
        });
      }
    }

    const items: DirectionScoreItem[] = ALL_DIRECTION_IDS.map((dir) => {
      const data = grouped.get(dir);
      return {
        direction: dir,
        totalScore: data?.totalScore ?? 0,
        dimensionScores: data?.dimensionScores ?? {},
        evidence: data?.evidence ?? [],
      };
    });

    return { items };
  }

  async getArticleTrace(id: string): Promise<ArticleTrace> {
    const rows = await this.db
      .select({
        id: article.id,
        title: article.title,
        url: article.url,
        originalUrl: article.originalUrl,
        originStatus: article.originStatus,
        originEvidence: article.originEvidence,
        originConfidence: article.originConfidence,
        sourceName: article.sourceName,
        tier: feedSource.tier,
        sourceUrl: feedSource.url,
        sourceCategoryId: feedSource.sourceCategoryId,
        originPolicy: feedSource.originPolicy,
      })
      .from(article)
      .leftJoin(feedSource, eq(article.feedSourceId, feedSource.id))
      .where(eq(article.id, id))
      .limit(1);

    if (rows.length === 0) {
      throw new NotFoundException(`Article ${id} not found`);
    }

    const row = rows[0];
    const originPolicy = getOriginPolicy({
      originPolicy: row.originPolicy,
      tier: row.tier,
      discoveryUrl: row.url,
      sourceUrl: row.sourceUrl,
      sourceName: row.sourceName,
      sourceCategoryId: row.sourceCategoryId,
    });
    const traceStatus = (row.originStatus ?? originPolicy) as TraceStatus;

    return {
      articleId: row.id,
      title: row.title,
      url: row.url,
      originalUrl: row.originalUrl,
      sourceName: row.sourceName,
      originPolicy,
      originStatus: traceStatus,
      originEvidence: row.originEvidence,
      originConfidence: row.originConfidence,
      traced: traceStatus === 'verified_reference',
      traceStatus,
    };
  }

  async getQualityGates(params: {
    page: number;
    pageSize: number;
    reason?: string;
  }): Promise<PaginatedResponse<QualityGateItem>> {
    const { page, pageSize, reason } = params;
    const offset = (page - 1) * pageSize;

    const conditions = [];
    if (reason) {
      conditions.push(eq(qualityGate.reason, reason));
    }
    const whereClause =
      conditions.length > 0 ? and(...conditions) : undefined;

    const rows = await this.db
      .select({
        id: qualityGate.id,
        articleTitle: article.title,
        sourceName: article.sourceName,
        reason: qualityGate.reason,
        detail: qualityGate.detail,
        blockedAt: qualityGate.blockedAt,
      })
      .from(qualityGate)
      .innerJoin(article, eq(qualityGate.articleId, article.id))
      .where(whereClause)
      .orderBy(desc(qualityGate.blockedAt))
      .limit(pageSize)
      .offset(offset);

    const totalResult = await this.db
      .select({ count: count() })
      .from(qualityGate)
      .innerJoin(article, eq(qualityGate.articleId, article.id))
      .where(whereClause);
    const total = Number(totalResult[0]?.count ?? 0);

    const items: QualityGateItem[] = rows.map((row) => ({
      id: row.id,
      articleTitle: row.articleTitle,
      sourceName: row.sourceName,
      reason: row.reason as QualityGateReason,
      detail: row.detail ?? '',
      blockedAt: row.blockedAt.toISOString(),
    }));

    return { items, total };
  }

  async getTraceList(params: {
    page: number;
    pageSize: number;
    traceStatus?: TraceStatus;
  }): Promise<PaginatedResponse<ArticleTrace>> {
    const { page, pageSize, traceStatus } = params;

    const rows = await this.db
      .select({
        id: article.id,
        title: article.title,
        url: article.url,
        originalUrl: article.originalUrl,
        originStatus: article.originStatus,
        originEvidence: article.originEvidence,
        originConfidence: article.originConfidence,
        sourceName: article.sourceName,
        tier: feedSource.tier,
        sourceUrl: feedSource.url,
        sourceCategoryId: feedSource.sourceCategoryId,
        originPolicy: feedSource.originPolicy,
      })
      .from(article)
      .leftJoin(feedSource, eq(article.feedSourceId, feedSource.id))
      .orderBy(desc(article.collectedAt));

    const allItems: ArticleTrace[] = rows.map((row) => {
      const originPolicy = getOriginPolicy({
        originPolicy: row.originPolicy,
        tier: row.tier,
        discoveryUrl: row.url,
        sourceUrl: row.sourceUrl,
        sourceName: row.sourceName,
        sourceCategoryId: row.sourceCategoryId,
      });
      const status = (row.originStatus ?? originPolicy) as TraceStatus;

      return {
        articleId: row.id,
        title: row.title,
        url: row.url,
        originalUrl: row.originalUrl,
        sourceName: row.sourceName,
        originPolicy,
        originStatus: status,
        originEvidence: row.originEvidence,
        originConfidence: row.originConfidence,
        traced: status === 'verified_reference',
        traceStatus: status,
      };
    });

    const filtered = traceStatus
      ? allItems.filter((item: ArticleTrace) => item.traceStatus === traceStatus)
      : allItems;

    const total = filtered.length;
    const offset = (page - 1) * pageSize;
    const items = filtered.slice(offset, offset + pageSize);

    return { items, total };
  }
}
