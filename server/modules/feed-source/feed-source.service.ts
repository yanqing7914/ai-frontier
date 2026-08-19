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
import { normalizeDirection } from '@shared/api.interface';

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
          nextFetchAt: feedSource.nextFetchAt,
          sourceCategory: feedSource.sourceCategory,
          sourceCategoryId: feedSource.sourceCategoryId,
          primaryDirectionId: feedSource.primaryDirectionId,
          sourceLayer: feedSource.sourceLayer,
          originPolicy: feedSource.originPolicy,
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
      nextFetchAt: row.nextFetchAt ? row.nextFetchAt.toISOString() : null,
      sourceCategory: row.sourceCategory ?? null,
      sourceCategoryId: row.sourceCategoryId ?? null,
      primaryDirectionId: row.primaryDirectionId
        ? normalizeDirection(row.primaryDirectionId)
        : null,
      sourceLayer: row.sourceLayer ?? null,
      originPolicy: row.originPolicy as FeedSourceListItem['originPolicy'],
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
        sourceCategory: dto.sourceCategory,
        sourceCategoryId: dto.sourceCategoryId,
        region: dto.region ?? 'global',
        primaryDirectionId: dto.primaryDirectionId
          ? normalizeDirection(dto.primaryDirectionId)
          : undefined,
        directionIds: dto.directionIds
          ? dto.directionIds.map((d: string) => normalizeDirection(d))
          : undefined,
        sourceLayer: dto.sourceLayer,
        originPolicy: dto.originPolicy,
        notes: dto.notes,
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
    if (dto.sourceCategory !== undefined) updateData.sourceCategory = dto.sourceCategory;
    if (dto.sourceCategoryId !== undefined) updateData.sourceCategoryId = dto.sourceCategoryId;
    if (dto.region !== undefined) updateData.region = dto.region;
    if (dto.primaryDirectionId !== undefined) {
      updateData.primaryDirectionId = normalizeDirection(dto.primaryDirectionId);
    }
    if (dto.directionIds !== undefined) {
      updateData.directionIds = dto.directionIds.map((d: string) => normalizeDirection(d));
    }
    if (dto.sourceLayer !== undefined) updateData.sourceLayer = dto.sourceLayer;
    if (dto.originPolicy !== undefined) updateData.originPolicy = dto.originPolicy;
    if (dto.notes !== undefined) updateData.notes = dto.notes;

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
        nextFetchAt: feedSource.nextFetchAt,
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
      nextFetchAt: row.nextFetchAt ? row.nextFetchAt.toISOString() : null,
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
          nextFetchAt: null,
        })
        .where(eq(feedSource.id, id))
        .returning({ id: feedSource.id });

      if (rows.length === 0) {
        throw new NotFoundException(`Feed source ${id} not found`);
      }

      return rows[0];
    }

    // Keep retrying recoverable outages, but never spend every scheduled run
    // on a source that is known to be broken.  Permanent-looking HTTP errors
    // get a longer cooldown while still remaining automatically recoverable.
    const nextFetchAt = getSourceRetryAt(
      error,
      await this.getConsecutiveFailures(id),
    );
    const rows = await this.db
      .update(feedSource)
      .set({
        totalFetches: sql`${feedSource.totalFetches} + 1`,
        consecutiveFailures: sql`${feedSource.consecutiveFailures} + 1`,
        lastError: error ?? null,
        nextFetchAt,
      })
      .where(eq(feedSource.id, id))
      .returning({ id: feedSource.id });

    if (rows.length === 0) {
      throw new NotFoundException(`Feed source ${id} not found`);
    }

    return rows[0];
  }

  private async getConsecutiveFailures(id: string): Promise<number> {
    const [row] = await this.db
      .select({ consecutiveFailures: feedSource.consecutiveFailures })
      .from(feedSource)
      .where(eq(feedSource.id, id))
      .limit(1);
    return row?.consecutiveFailures ?? 0;
  }
}

/**
 * Return the next retry time after a failed attempt. The caller supplies the
 * current consecutive-failure count; the failed attempt itself is counted
 * before calculating the delay.
 */
export function getSourceRetryAt(
  error: string | undefined,
  currentConsecutiveFailures: number,
  now: Date = new Date(),
): Date | null {
  const failures = Math.max(1, currentConsecutiveFailures + 1);
  if (failures < 3) return null;

  const message = error ?? '';
  const isPermanentHttpError = /HTTP\s+(?:401|403|404|410)\b/i.test(message);
  const delayMs = isPermanentHttpError
    ? 7 * 24 * 60 * 60 * 1000
    // The pipeline runs hourly, so the first cooldown must exceed one hour;
    // otherwise a source still gets retried by the very next scheduled run.
    : Math.min(7 * 24 * 60 * 60 * 1000, 2 * 60 * 60 * 1000 * 2 ** (failures - 3));
  return new Date(now.getTime() + delayMs);
}
