import { DRIZZLE_DATABASE } from '../../infrastructure/database';
import type { PostgresJsDatabase } from '../../infrastructure/database';
import {
  Inject,
  Injectable,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { eq, and, desc, count } from 'drizzle-orm';
import { reviewItem, article } from '@server/database/schema';
import type { ReviewItem, PaginatedResponse } from '@shared/api.interface';

@Injectable()
export class ReviewService {
  constructor(
    @Inject(DRIZZLE_DATABASE)
    private readonly db: PostgresJsDatabase,
  ) {}

  async getReviews(params: {
    page: number;
    pageSize: number;
    status?: string;
  }): Promise<PaginatedResponse<ReviewItem>> {
    const { page, pageSize, status } = params;
    const offset = (page - 1) * pageSize;

    const conditions = [];
    if (status) {
      conditions.push(eq(reviewItem.status, status));
    }

    const whereClause =
      conditions.length > 0 ? and(...conditions) : undefined;

    const items = await this.db
      .select({
        id: reviewItem.id,
        articleId: reviewItem.articleId,
        articleTitle: article.title,
        sourceName: article.sourceName,
        url: article.url,
        status: reviewItem.status,
        collectedAt: article.collectedAt,
      })
      .from(reviewItem)
      .leftJoin(article, eq(reviewItem.articleId, article.id))
      .where(whereClause)
      .orderBy(desc(reviewItem.createdAt))
      .limit(pageSize)
      .offset(offset);

    const [countResult] = await this.db
      .select({ count: count() })
      .from(reviewItem)
      .where(whereClause);

    const formattedItems: ReviewItem[] = items.map((item) => ({
      id: item.id,
      articleId: item.articleId,
      articleTitle: item.articleTitle ?? '',
      sourceName: item.sourceName ?? '',
      url: item.url ?? '',
      status: item.status as ReviewItem['status'],
      collectedAt: item.collectedAt
        ? item.collectedAt instanceof Date
          ? item.collectedAt.toISOString()
          : String(item.collectedAt)
        : '',
    }));

    return {
      items: formattedItems,
      total: Number(countResult?.count ?? 0),
    };
  }

  async processReview(
    id: string,
    action: 'approve' | 'reject',
    note?: string,
  ): Promise<{ id: string; status: string }> {
    const [item] = await this.db
      .select()
      .from(reviewItem)
      .where(eq(reviewItem.id, id));

    if (!item) {
      throw new NotFoundException(`Review item ${id} not found`);
    }

    if (item.status !== 'pending') {
      throw new BadRequestException(
        `Review item is already ${item.status}`,
      );
    }

    const newStatus =
      action === 'approve' ? 'approved' : 'rejected';

    await this.db
      .update(reviewItem)
      .set({
        status: newStatus,
        reviewedAt: new Date(),
        reviewNote: note ?? null,
      })
      .where(eq(reviewItem.id, id));

    const articleStatus =
      action === 'approve' ? 'draft' : 'blocked';

    await this.db
      .update(article)
      .set({ status: articleStatus })
      .where(eq(article.id, item.articleId));

    if (action === 'approve') {
      // Approval is an explicit provenance audit. Keep the original trace for
      // auditability, but allow the publish gate to release this reviewed item.
      await this.db.update(article).set({
        provenanceOverride: true,
        provenanceAuditedAt: new Date(),
        originEvidence: note ? `manual_review_approved: ${note}` : 'manual_review_approved',
      }).where(eq(article.id, item.articleId));
    } else {
      await this.db.update(article).set({
        provenanceOverride: false,
        provenanceAuditedAt: new Date(),
      }).where(eq(article.id, item.articleId));
    }

    return { id, status: newStatus };
  }
}
