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
import { isSecondHandDomain, getDomain } from '../collector/trace-engine';
import { normalizeDirection } from '@shared/api.interface';

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

    const baseConditions = [
      eq(article.status, 'published'),
    ];
    if (directions && directions.length > 0) {
      baseConditions.push(inArray(article.primaryDirection, directions));
    }

    const sevenDaysAgo = sql`now() - interval '7 days'`;

    const frontPageWhere = and(
      ...baseConditions,
      isNotNull(article.frontPageRank),
    );

    const rankedRows = await this.db
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
      .where(frontPageWhere)
      .orderBy(article.frontPageRank);

    const rankedCount = rankedRows.length;
    const minItems = Math.max(pageSize, 10);

    let rows = rankedRows;
    let total = rankedCount;

    if (rankedCount < minItems) {
      const rankedIds = rankedRows.map((r) => r.id);
      const supplementWhere = rankedIds.length > 0
        ? and(
            ...baseConditions,
            isNull(article.frontPageRank),
            gte(article.publishedAt, sevenDaysAgo),
            gte(article.primaryScore, 75),
            sql`${article.id} NOT IN (${sql.join(rankedIds.map((id: string) => sql`${id}`), sql`, `)})`,
          )
        : and(
            ...baseConditions,
            isNull(article.frontPageRank),
            gte(article.publishedAt, sevenDaysAgo),
            gte(article.primaryScore, 75),
          );

      const supplementRows = await this.db
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
        .where(supplementWhere)
        .orderBy(desc(article.primaryScore), desc(article.publishedAt))
        .limit(minItems - rankedCount);

      rows = [...rankedRows, ...supplementRows];

      const supplementCountResult = await this.db
        .select({ count: count() })
        .from(article)
        .where(supplementWhere);
      total = rankedCount + Number(supplementCountResult[0]?.count ?? 0);
    } else {
      const totalResult = await this.db
        .select({ count: count() })
        .from(article)
        .where(frontPageWhere);
      total = Number(totalResult[0]?.count ?? 0);
    }

    rows = rows.slice(offset, offset + pageSize);

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
      primaryDirection: normalizeDirection(row.primaryDirection),
      primaryScore: row.primaryScore ?? 0,
      publishedAt: row.publishedAt?.toISOString() ?? '',
      clusterCount: row.clusterId
        ? (clusterCountMap.get(row.clusterId) ?? 1)
        : 1,
      frontPageRank: row.frontPageRank ?? null,
    }));

    return { items, total };
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
      conditions.push(eq(article.primaryDirection, direction));
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
      })
      .from(directionScore)
      .where(eq(directionScore.articleId, id));

    const items: DirectionScoreItem[] = scores.map((row) => ({
      direction: row.direction as Direction,
      totalScore: row.totalScore,
      dimensionScores: row.dimensionScores as DimensionScores,
    }));

    return { items };
  }

  async getArticleTrace(id: string): Promise<ArticleTrace> {
    const rows = await this.db
      .select({
        id: article.id,
        title: article.title,
        url: article.url,
        originalUrl: article.originalUrl,
        sourceName: article.sourceName,
        tier: feedSource.tier,
      })
      .from(article)
      .leftJoin(feedSource, eq(article.feedSourceId, feedSource.id))
      .where(eq(article.id, id))
      .limit(1);

    if (rows.length === 0) {
      throw new NotFoundException(`Article ${id} not found`);
    }

    const row = rows[0];
    const hasOrigin = row.originalUrl !== null
      && row.originalUrl !== ''
      && row.originalUrl !== row.url;
    const needsTrace = row.tier === 'signal'
      || isSecondHandDomain(getDomain(row.url));
    const traceStatus: TraceStatus = hasOrigin
      ? 'success'
      : needsTrace ? 'failed' : 'not_needed';

    return {
      articleId: row.id,
      title: row.title,
      url: row.url,
      originalUrl: row.originalUrl,
      sourceName: row.sourceName,
      traced: hasOrigin,
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
        sourceName: article.sourceName,
        tier: feedSource.tier,
      })
      .from(article)
      .leftJoin(feedSource, eq(article.feedSourceId, feedSource.id))
      .orderBy(desc(article.collectedAt));

    const allItems: ArticleTrace[] = rows.map((row) => {
      const hasOrigin = row.originalUrl !== null
        && row.originalUrl !== ''
        && row.originalUrl !== row.url;
      const needsTrace = row.tier === 'signal'
        || isSecondHandDomain(getDomain(row.url));
      const status: TraceStatus = hasOrigin
        ? 'success'
        : needsTrace ? 'failed' : 'not_needed';

      return {
        articleId: row.id,
        title: row.title,
        url: row.url,
        originalUrl: row.originalUrl,
        sourceName: row.sourceName,
        traced: hasOrigin,
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
