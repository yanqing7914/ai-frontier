import {
  DRIZZLE_DATABASE,
  type PostgresJsDatabase,
} from '@lark-apaas/fullstack-nestjs-core';
import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { eq, and, inArray, sql } from 'drizzle-orm';
import { dailyDigest, article } from '@server/database/schema';
import type { DailyDigest, DailyDigestArticle } from '@shared/api.interface';

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
        primaryDirection:
          a.primaryDirection as DailyDigestArticle['primaryDirection'],
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
    const [existing] = await this.db
      .select()
      .from(dailyDigest)
      .where(eq(dailyDigest.digestDate, dateStr));

    if (existing) {
      return this.getDigestByDate(dateStr);
    }

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
          sql`${article.collectedAt}::date::text = ${dateStr}`,
        ),
      );

    const summaryParts = articles.map(
      (a, i: number) =>
        `${i + 1}. ${a.title} (${a.primaryScore ?? 0}分)`,
    );
    const summary = `今日共 ${articles.length} 条 AI 热点：${summaryParts.join('；')}`;

    const [inserted] = await this.db
      .insert(dailyDigest)
      .values({
        digestDate: dateStr,
        summary,
        articleCount: articles.length,
        articleIds: articles.map((a) => a.id),
      })
      .returning();

    const digestArticles: DailyDigestArticle[] = articles.map((a) => ({
      id: a.id,
      title: a.title,
      primaryDirection:
        a.primaryDirection as DailyDigestArticle['primaryDirection'],
      primaryScore: a.primaryScore as number,
    }));

    return {
      id: inserted.id,
      digestDate: inserted.digestDate,
      summary: inserted.summary ?? '',
      articleCount: inserted.articleCount,
      articles: digestArticles,
    };
  }
}
