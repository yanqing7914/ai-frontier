import {
  Injectable,
  Inject,
  NotFoundException,
  Logger,
} from '@nestjs/common';
import {
  DRIZZLE_DATABASE,
  type PostgresJsDatabase,
} from '@lark-apaas/fullstack-nestjs-core';
import { eq, and, count, sql } from 'drizzle-orm';
import { feedSource } from '@server/database/schema';
import type {
  FeedSourceListItem,
  FeedSourceHealth,
  CreateFeedSourceRequest,
  UpdateFeedSourceRequest,
  ToggleFeedSourceRequest,
} from '@shared/api.interface';

@Injectable()
export class FeedSourceService {
  private readonly logger = new Logger(FeedSourceService.name);

  constructor(
    @Inject(DRIZZLE_DATABASE)
    private readonly db: PostgresJsDatabase,
  ) {}

  async findAll(params: {
    page: number;
    pageSize: number;
    tier?: string;
    enabled?: string;
  }): Promise<{ items: FeedSourceListItem[]; total: number }> {
    const { page, pageSize, tier, enabled } = params;
    const offset = (page - 1) * pageSize;

    const conditions = [];
    if (tier) {
      conditions.push(eq(feedSource.tier, tier));
    }
    if (enabled !== undefined && enabled !== '') {
      conditions.push(eq(feedSource.enabled, enabled === 'true'));
    }

    const whereClause =
      conditions.length > 0 ? and(...conditions) : undefined;

    const [rows, countResult] = await Promise.all([
      this.db
        .select({
          id: feedSource.id,
          name: feedSource.name,
          url: feedSource.url,
          tier: feedSource.tier,
          feedType: feedSource.feedType,
          enabled: feedSource.enabled,
          totalFetches: feedSource.totalFetches,
          successFetches: feedSource.successFetches,
          lastSuccessAt: feedSource.lastSuccessAt,
          consecutiveFailures: feedSource.consecutiveFailures,
        })
        .from(feedSource)
        .where(whereClause)
        .orderBy(feedSource.createdAt)
        .limit(pageSize)
        .offset(offset),
      this.db
        .select({ count: count() })
        .from(feedSource)
        .where(whereClause),
    ]);

    const total = Number(countResult[0]?.count ?? 0);

    const items: FeedSourceListItem[] = rows.map((row) => ({
      id: row.id,
      name: row.name,
      url: row.url,
      tier: row.tier as FeedSourceListItem['tier'],
      feedType: row.feedType as FeedSourceListItem['feedType'],
      enabled: row.enabled,
      successRate:
        row.totalFetches > 0
          ? Math.round((row.successFetches / row.totalFetches) * 10000) / 100
          : 0,
      lastSuccessAt: row.lastSuccessAt
        ? row.lastSuccessAt.toISOString()
        : null,
      consecutiveFailures: row.consecutiveFailures,
    }));

    return { items, total };
  }

  async findOne(id: string) {
    const rows = await this.db
      .select()
      .from(feedSource)
      .where(eq(feedSource.id, id))
      .limit(1);

    if (rows.length === 0) {
      throw new NotFoundException(`Feed source ${id} not found`);
    }

    return rows[0];
  }

  async create(dto: CreateFeedSourceRequest) {
    const rows = await this.db
      .insert(feedSource)
      .values({
        name: dto.name,
        url: dto.url,
        tier: dto.tier,
        feedType: dto.feedType,
      })
      .returning();

    return rows[0];
  }

  async update(id: string, dto: UpdateFeedSourceRequest) {
    const updateData: Record<string, unknown> = {};
    if (dto.name !== undefined) updateData.name = dto.name;
    if (dto.url !== undefined) updateData.url = dto.url;
    if (dto.tier !== undefined) updateData.tier = dto.tier;
    if (dto.feedType !== undefined) updateData.feedType = dto.feedType;

    if (Object.keys(updateData).length === 0) {
      return this.findOne(id);
    }

    const rows = await this.db
      .update(feedSource)
      .set(updateData)
      .where(eq(feedSource.id, id))
      .returning();

    if (rows.length === 0) {
      throw new NotFoundException(`Feed source ${id} not found`);
    }

    return rows[0];
  }

  async delete(id: string) {
    const rows = await this.db
      .delete(feedSource)
      .where(eq(feedSource.id, id))
      .returning({ id: feedSource.id });

    if (rows.length === 0) {
      throw new NotFoundException(`Feed source ${id} not found`);
    }

    return { id };
  }

  async toggle(id: string, dto: ToggleFeedSourceRequest) {
    const rows = await this.db
      .update(feedSource)
      .set({ enabled: dto.enabled })
      .where(eq(feedSource.id, id))
      .returning({ id: feedSource.id, enabled: feedSource.enabled });

    if (rows.length === 0) {
      throw new NotFoundException(`Feed source ${id} not found`);
    }

    return rows[0];
  }

  async getHealth(id: string): Promise<FeedSourceHealth> {
    const rows = await this.db
      .select({
        totalFetches: feedSource.totalFetches,
        successFetches: feedSource.successFetches,
        lastSuccessAt: feedSource.lastSuccessAt,
        consecutiveFailures: feedSource.consecutiveFailures,
        lastError: feedSource.lastError,
      })
      .from(feedSource)
      .where(eq(feedSource.id, id))
      .limit(1);

    if (rows.length === 0) {
      throw new NotFoundException(`Feed source ${id} not found`);
    }

    const row = rows[0];
    const successRate =
      row.totalFetches > 0
        ? Math.round((row.successFetches / row.totalFetches) * 10000) / 100
        : 0;

    return {
      totalFetches: row.totalFetches,
      successFetches: row.successFetches,
      successRate,
      lastSuccessAt: row.lastSuccessAt
        ? row.lastSuccessAt.toISOString()
        : null,
      consecutiveFailures: row.consecutiveFailures,
      lastError: row.lastError,
    };
  }

  async updateFetchStats(
    id: string,
    success: boolean,
    error?: string,
  ) {
    if (success) {
      const rows = await this.db
        .update(feedSource)
        .set({
          totalFetches: sql`${feedSource.totalFetches} + 1`,
          successFetches: sql`${feedSource.successFetches} + 1`,
          consecutiveFailures: 0,
          lastSuccessAt: new Date(),
          lastError: null,
        })
        .where(eq(feedSource.id, id))
        .returning({ id: feedSource.id });

      if (rows.length === 0) {
        throw new NotFoundException(`Feed source ${id} not found`);
      }

      return rows[0];
    }

    const rows = await this.db
      .update(feedSource)
      .set({
        totalFetches: sql`${feedSource.totalFetches} + 1`,
        consecutiveFailures: sql`${feedSource.consecutiveFailures} + 1`,
        lastError: error ?? null,
      })
      .where(eq(feedSource.id, id))
      .returning({ id: feedSource.id });

    if (rows.length === 0) {
      throw new NotFoundException(`Feed source ${id} not found`);
    }

    return rows[0];
  }
}
