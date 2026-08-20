import {
  DRIZZLE_DATABASE,
  type PostgresJsDatabase,
} from '@lark-apaas/fullstack-nestjs-core';
import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { eq, and, inArray, sql, isNotNull } from 'drizzle-orm';
import { dailyDigest, article } from '@server/database/schema';
import type { DailyDigest, DailyDigestArticle, Direction } from '@shared/api.interface';
import { normalizeDirection } from '@shared/api.interface';

@Injectable()
export class DigestService {
  constructor(
    @Inject(DRIZZLE_DATABASE)
    private readonly db: PostgresJsDatabase,
  ) {}

  async getDigestByDate(dateStr: string): Promise<DailyDigest> {
    const [digest] = await this.db
      .select()
      .from(dailyDigest)
      .where(eq(dailyDigest.digestDate, dateStr));

    if (!digest) {
      throw new NotFoundException(
        `No digest found for date ${dateStr}`,
      );
    }

    const articleIds = (digest.articleIds ?? []) as string[];
    let articles: DailyDigestArticle[] = [];

    if (articleIds.length > 0) {
      const rows = await this.db
        .select({
          id: article.id,
          title: article.title,
          primaryDirection: article.primaryDirection,
          primaryScore: article.primaryScore,
        })
        .from(article)
        .where(inArray(article.id, articleIds));

      articles = rows.map((a) => ({
        id: a.id,
        title: a.title,
        primaryDirection: normalizeDirection(a.primaryDirection) as DailyDigestArticle['primaryDirection'],
        primaryScore: a.primaryScore as number,
      }));
    }

    return {
      id: digest.id,
      digestDate: digest.digestDate,
      summary: digest.summary ?? '',
      articleCount: digest.articleCount,
      articles,
    };
  }

  async generateDigest(dateStr: string): Promise<DailyDigest> {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
      throw new Error(`Invalid digest date: ${dateStr}`);
    }
    const nextDate = new Date(`${dateStr}T00:00:00Z`);
    nextDate.setUTCDate(nextDate.getUTCDate() + 1);
    const nextDateStr = nextDate.toISOString().slice(0, 10);
    const start = `${dateStr} 00:00:00+08:00`;
    const end = `${nextDateStr} 00:00:00+08:00`;

    const articles = await this.db
      .select({
        id: article.id,
        title: article.title,
        primaryDirection: article.primaryDirection,
        primaryScore: article.primaryScore,
      })
      .from(article)
      .where(
        and(
          eq(article.status, 'published'),
          isNotNull(article.primaryScore),
          isNotNull(article.primaryDirection),
          sql`COALESCE(${article.publishedAt}, ${article.collectedAt}) >= ${start}::timestamptz`,
          sql`COALESCE(${article.publishedAt}, ${article.collectedAt}) < ${end}::timestamptz`,
        ),
      );

    const summaryParts = articles.map(
      (a, i: number) =>
        `${i + 1}. ${a.title} (${a.primaryScore ?? 0}分)`,
    );
    const summary = `今日共 ${articles.length} 条 AI 热点：${summaryParts.join('；')}`;

    const [digestRow] = await this.db
      .insert(dailyDigest)
      .values({
        digestDate: dateStr,
        summary,
        articleCount: articles.length,
        articleIds: articles.map((a) => a.id),
      })
      .onConflictDoUpdate({
        target: dailyDigest.digestDate,
        set: {
          summary,
          articleCount: articles.length,
          articleIds: articles.map((a) => a.id),
        },
      })
      .returning();

    const digestArticles: DailyDigestArticle[] = articles.map((a) => ({
      id: a.id,
      title: a.title,
      primaryDirection: normalizeDirection(a.primaryDirection) as DailyDigestArticle['primaryDirection'],
      primaryScore: a.primaryScore as number,
    }));

    return {
      id: digestRow.id,
      digestDate: digestRow.digestDate,
      summary: digestRow.summary ?? '',
      articleCount: digestRow.articleCount,
      articles: digestArticles,
    };
  }
}
