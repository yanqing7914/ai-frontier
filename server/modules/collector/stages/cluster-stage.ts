import { and, inArray, isNotNull, sql } from 'drizzle-orm';
import type { PostgresJsDatabase } from '../../../infrastructure/database';
import { article } from '@server/database/schema';
import {
  CLUSTER_WINDOW_HOURS,
  MAX_CLUSTER_HISTORY_ARTICLES,
  planEventClusters,
} from '../event-cluster';
import type { PipelineArticle } from '../pipeline-types';

export interface ClusterStageLogger {
  error(message: string): void;
  warn(message: string): void;
}

export interface ClusterStageResult {
  groups: number;
  comparisons: number;
  degraded: boolean;
}

type ClusterHistoryRow = {
  id: string;
  title: string;
  url: string;
  clusterId: string | null;
};

/**
 * Enrich new articles with event clusters. Clustering is deliberately
 * best-effort: a history read or assignment failure must not stop scoring.
 */
export async function runClusterStage(
  db: PostgresJsDatabase,
  articles: PipelineArticle[],
  logger: ClusterStageLogger,
): Promise<ClusterStageResult> {
  if (articles.length === 0) {
    return { groups: 0, comparisons: 0, degraded: false };
  }

  let history: ClusterHistoryRow[] = [];
  let degraded = false;
  try {
    history = (await db
      .select({
        id: article.id,
        title: article.title,
        url: article.url,
        clusterId: article.clusterId,
      })
      .from(article)
      .where(and(
        isNotNull(article.clusterId),
        sql`COALESCE(${article.publishedAt}, ${article.collectedAt}) > NOW() - INTERVAL '${sql.raw(String(CLUSTER_WINDOW_HOURS))} hours'`,
      ))
      .limit(MAX_CLUSTER_HISTORY_ARTICLES)) as ClusterHistoryRow[];
  } catch (error: unknown) {
    degraded = true;
    logger.error(
      `Cluster history query failed; using batch-only clustering: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const plan = planEventClusters([
    ...history.map((row) => ({
      id: row.id,
      title: row.title,
      url: row.url,
      clusterId: row.clusterId,
      isNew: false,
    })),
    ...articles.map((item) => ({
      id: item.id,
      title: item.title,
      url: item.url,
      isNew: true,
    })),
  ]);

  if (plan.comparisonBudgetExhausted) {
    degraded = true;
    logger.warn(
      `Cluster comparison budget reached after ${plan.comparisons} comparisons; remaining articles stay unclustered`,
    );
  }

  const newArticleIds = new Set(articles.map((item) => item.id));
  try {
    for (const group of plan.groups) {
      const newIds = group.itemIds.filter((id) => newArticleIds.has(id));
      if (newIds.length === 0) continue;
      await db
        .update(article)
        .set({ clusterId: group.clusterId })
        .where(inArray(article.id, newIds));
    }
  } catch (error: unknown) {
    degraded = true;
    logger.error(
      `Cluster assignment failed; continuing pipeline: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  return {
    groups: plan.groups.length,
    comparisons: plan.comparisons,
    degraded,
  };
}
