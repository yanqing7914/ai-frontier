import {
  Injectable,
  Inject,
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { DRIZZLE_DATABASE } from '../../infrastructure/database';
import type { PostgresJsDatabase } from '../../infrastructure/database';
import { eq, and, count, sql, isNull, lte, or } from 'drizzle-orm';
import { feedSource } from '@server/database/schema';
import type {
  FeedSourceListItem,
  FeedSourceHealth,
  CreateFeedSourceRequest,
  UpdateFeedSourceRequest,
  ToggleFeedSourceRequest,
} from '@shared/api.interface';
import { isValidDirection, normalizeDirection } from '@shared/api.interface';

const TIERS = new Set(['authoritative', 'validation', 'signal']);
const FEED_TYPES = new Set(['rss', 'atom', 'api', 'web']);
const ORIGIN_POLICIES = new Set(['first_party', 'editorial', 'aggregator']);
const SOURCE_CATEGORY_IDS = new Set([
  'research_papers',
  'official_release',
  'open_source_community',
  'evaluation_data',
  'infrastructure_supply_chain',
  'policy_safety_governance',
  'media_analysis',
  'interviews_podcasts',
]);
const SOURCE_CATEGORY_LABELS: Record<string, string> = {
  research_papers: '论文研究',
  official_release: '官方发布',
  open_source_community: '开源社区',
  evaluation_data: '评测数据',
  infrastructure_supply_chain: '基础设施产业链',
  policy_safety_governance: '政策安全治理',
  media_analysis: '媒体分析',
  interviews_podcasts: '访谈播客',
};
const REGIONS = new Set(['global', 'cn', 'us', 'eu', 'apac']);
const SOURCE_LAYERS = new Set(['primary', 'secondary', 'tertiary']);
const BLOCKED_HOSTS = new Set([
  'localhost',
  'localhost.localdomain',
  'metadata',
  'metadata.google.internal',
  'instance-data',
]);
const BLOCKED_HOST_SUFFIXES = ['.localhost', '.local', '.internal', '.home.arpa'];

type FeedSourceInput = CreateFeedSourceRequest | UpdateFeedSourceRequest;

interface ValidatedFeedSourceInput {
  name?: string;
  url?: string;
  tier?: string;
  feedType?: string;
  sourceCategory?: string;
  sourceCategoryId?: string;
  region?: string;
  primaryDirectionId?: string | null;
  directionIds?: string[];
  sourceLayer?: string;
  originPolicy?: string;
  notes?: string;
}

@Injectable()
export class FeedSourceService {
  constructor(
    @Inject(DRIZZLE_DATABASE)
    private readonly db: PostgresJsDatabase,
  ) {}

  async findAll(params: {
    page: number;
    pageSize: number;
    tier?: string;
    enabled?: string;
    sourceCategoryId?: string;
  }): Promise<{ items: FeedSourceListItem[]; total: number }> {
    const { page, pageSize, tier, enabled, sourceCategoryId } = params;
    assertPagination(page, pageSize);
    const offset = (page - 1) * pageSize;

    const conditions = [];
    if (tier) {
      conditions.push(eq(feedSource.tier, assertEnum(tier, TIERS, 'tier')));
    }
    if (enabled !== undefined && enabled !== '') {
      if (enabled !== 'true' && enabled !== 'false') {
        throw new BadRequestException('enabled must be true or false');
      }
      conditions.push(eq(feedSource.enabled, enabled === 'true'));
    }
    if (sourceCategoryId !== undefined && sourceCategoryId !== '') {
      if (!SOURCE_CATEGORY_IDS.has(sourceCategoryId)) {
        throw new BadRequestException('sourceCategoryId is not supported');
      }
      conditions.push(eq(feedSource.sourceCategoryId, sourceCategoryId));
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
    const values = this.validateInput(dto, true);
    try {
      const rows = await this.db
        .insert(feedSource)
        .values({
          name: values.name!,
          url: values.url!,
          tier: values.tier!,
          feedType: values.feedType!,
          sourceCategory: values.sourceCategory,
          sourceCategoryId: values.sourceCategoryId,
          region: values.region ?? 'global',
          primaryDirectionId: values.primaryDirectionId,
          directionIds: values.directionIds,
          sourceLayer: values.sourceLayer,
          originPolicy: values.originPolicy,
          notes: values.notes,
        })
        .returning();
      return rows[0];
    } catch (error: unknown) {
      this.throwIfDuplicateUrl(error);
      throw error;
    }
  }

  async update(id: string, dto: UpdateFeedSourceRequest) {
    const updateData = this.validateInput(dto, false);

    if (Object.keys(updateData).length === 0) {
      return this.findOne(id);
    }

    if (updateData.tier !== undefined || updateData.originPolicy !== undefined) {
      const existing = await this.findOne(id);
      assertReliabilityPolicy(
        updateData.tier ?? existing.tier,
        updateData.originPolicy ?? existing.originPolicy,
      );
    }

    let rows;
    try {
      rows = await this.db
        .update(feedSource)
        .set(updateData)
        .where(eq(feedSource.id, id))
        .returning();
    } catch (error: unknown) {
      this.throwIfDuplicateUrl(error);
      throw error;
    }

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
    if (typeof dto?.enabled !== 'boolean') {
      throw new BadRequestException('enabled must be a boolean');
    }
    const rows = await this.db
      .update(feedSource)
      // Enabling clears only the cooldown; reliability counters and the last
      // error remain available to operators for the next retry decision.
      .set(dto.enabled ? { enabled: true, nextFetchAt: null } : { enabled: false })
      .where(eq(feedSource.id, id))
      .returning({ id: feedSource.id, enabled: feedSource.enabled });

    if (rows.length === 0) {
      throw new NotFoundException(`Feed source ${id} not found`);
    }

    return rows[0];
  }

  async findEligibleForIngest(now: Date = new Date()) {
    return this.db
      .select()
      .from(feedSource)
      .where(
        and(
          eq(feedSource.enabled, true),
          or(isNull(feedSource.nextFetchAt), lte(feedSource.nextFetchAt, now)),
        ),
      );
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

    const rows = await this.db
      .update(feedSource)
      .set({
        totalFetches: sql`${feedSource.totalFetches} + 1`,
        consecutiveFailures: sql`${feedSource.consecutiveFailures} + 1`,
        lastError: error ?? null,
        // Compute cooldown from the current counter in the same UPDATE. This
        // avoids a read-modify-write race when two attempts finish together.
        nextFetchAt: sql`CASE
          WHEN ${feedSource.consecutiveFailures} + 1 < 3 THEN NULL
          WHEN ${error ?? ''} ~* 'HTTP\\s+(401|403|404|410)\\y'
            THEN NOW() + INTERVAL '7 days'
          ELSE NOW() + LEAST(
            INTERVAL '7 days',
            INTERVAL '2 hours' * power(2, LEAST(${feedSource.consecutiveFailures} - 2, 12))
          )
        END`,
      })
      .where(eq(feedSource.id, id))
      .returning({ id: feedSource.id });

    if (rows.length === 0) {
      throw new NotFoundException(`Feed source ${id} not found`);
    }

    return rows[0];
  }

  private validateInput(
    dto: FeedSourceInput,
    isCreate: boolean,
  ): ValidatedFeedSourceInput {
    if (!dto || typeof dto !== 'object' || Array.isArray(dto)) {
      throw new BadRequestException('feed source payload must be an object');
    }
    const result: ValidatedFeedSourceInput = {};
    const value = dto as Record<string, unknown>;

    if (isCreate || value.name !== undefined) {
      result.name = normalizeRequiredText(value.name, 'name', 255);
    }
    if (isCreate || value.url !== undefined) {
      result.url = canonicalizeFeedUrl(value.url);
    }
    if (isCreate || value.tier !== undefined) {
      result.tier = assertEnum(value.tier, TIERS, 'tier');
    }
    if (isCreate || value.feedType !== undefined) {
      result.feedType = assertEnum(value.feedType, FEED_TYPES, 'feedType');
    }
    if (isCreate || value.sourceCategoryId !== undefined) {
      const sourceCategoryId = assertEnum(
        value.sourceCategoryId,
        SOURCE_CATEGORY_IDS,
        'sourceCategoryId',
      );
      result.sourceCategoryId = sourceCategoryId;
      result.sourceCategory = SOURCE_CATEGORY_LABELS[sourceCategoryId];
      if (
        value.sourceCategory !== undefined
        && normalizeOptionalText(value.sourceCategory, 'sourceCategory', 100)
          !== result.sourceCategory
      ) {
        throw new BadRequestException('sourceCategory must match sourceCategoryId');
      }
    } else if (value.sourceCategory !== undefined) {
      throw new BadRequestException('sourceCategoryId is required when changing sourceCategory');
    }
    if (value.region !== undefined) {
      result.region = assertEnum(value.region, REGIONS, 'region');
    }
    if (value.primaryDirectionId !== undefined) {
      result.primaryDirectionId = assertDirection(value.primaryDirectionId, 'primaryDirectionId');
    }
    if (value.directionIds !== undefined) {
      if (!Array.isArray(value.directionIds) || value.directionIds.length === 0) {
        throw new BadRequestException('directionIds must be a non-empty array');
      }
      const directionIds = value.directionIds.map((direction, index) =>
        assertDirection(direction, `directionIds[${index}]`),
      );
      if (new Set(directionIds).size !== directionIds.length) {
        throw new BadRequestException('directionIds must not contain duplicates');
      }
      result.directionIds = directionIds;
    }
    if (value.sourceLayer !== undefined) {
      result.sourceLayer = assertEnum(value.sourceLayer, SOURCE_LAYERS, 'sourceLayer');
    }
    if (isCreate || value.originPolicy !== undefined) {
      result.originPolicy = assertEnum(value.originPolicy, ORIGIN_POLICIES, 'originPolicy');
    }
    if (value.notes !== undefined) {
      result.notes = normalizeOptionalText(value.notes, 'notes', 10_000);
    }

    if (isCreate) assertReliabilityPolicy(result.tier, result.originPolicy);
    return result;
  }

  private throwIfDuplicateUrl(error: unknown): void {
    const databaseError = error as { code?: string; constraint?: string; message?: string };
    if (
      databaseError?.code === '23505'
      || databaseError?.constraint === 'feed_source_url_key'
      || /feed_source_url_key|duplicate key/i.test(databaseError?.message ?? '')
    ) {
      throw new ConflictException('A feed source with this canonical URL already exists');
    }
  }
}

function assertReliabilityPolicy(tier: unknown, originPolicy: unknown): void {
  if (tier === 'authoritative' && originPolicy === 'aggregator') {
    throw new BadRequestException('aggregator sources cannot use the authoritative tier');
  }
  if (tier === 'authoritative' && originPolicy !== 'first_party') {
    throw new BadRequestException('authoritative sources must use first_party originPolicy');
  }
}

function normalizeRequiredText(value: unknown, field: string, maxLength: number): string {
  const normalized = normalizeOptionalText(value, field, maxLength);
  if (!normalized) throw new BadRequestException(`${field} is required`);
  return normalized;
}

function normalizeOptionalText(value: unknown, field: string, maxLength: number): string | undefined {
  if (typeof value !== 'string') {
    throw new BadRequestException(`${field} must be a string`);
  }
  const normalized = value.trim();
  if (normalized.length > maxLength) {
    throw new BadRequestException(`${field} must be at most ${maxLength} characters`);
  }
  return normalized || undefined;
}

function assertEnum(value: unknown, values: Set<string>, field: string): string {
  if (typeof value !== 'string' || !values.has(value)) {
    throw new BadRequestException(`${field} is not supported`);
  }
  return value;
}

function assertPagination(page: number, pageSize: number): void {
  if (!Number.isSafeInteger(page) || page < 1 || page > 10_000) {
    throw new BadRequestException('page must be between 1 and 10000');
  }
  if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 200) {
    throw new BadRequestException('pageSize must be between 1 and 200');
  }
}

function assertDirection(value: unknown, field: string): string | null {
  if (value === null) return null;
  if (typeof value !== 'string') {
    throw new BadRequestException(`${field} is not supported`);
  }
  const normalized = normalizeDirection(value);
  if (!normalized || !isValidDirection(normalized)) {
    throw new BadRequestException(`${field} is not supported`);
  }
  return normalized;
}

export function canonicalizeFeedUrl(value: unknown): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new BadRequestException('url is required');
  }

  let parsed: URL;
  try {
    parsed = new URL(value.trim());
  } catch {
    throw new BadRequestException('url must be a valid absolute URL');
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new BadRequestException('url protocol must be http or https');
  }
  if (parsed.username || parsed.password) {
    throw new BadRequestException('url must not contain userinfo');
  }
  if (parsed.port) throw new BadRequestException('url port is not allowed');

  const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (
    !host
    || BLOCKED_HOSTS.has(host)
    || BLOCKED_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix))
    || /^0x[0-9a-f]+$/i.test(host)
    || /^\d+$/.test(host)
    || isPrivateNetworkHost(host)
  ) {
    throw new BadRequestException('url host is not allowed');
  }

  parsed.hostname = host;
  parsed.hash = '';
  if (parsed.pathname.length > 1) parsed.pathname = parsed.pathname.replace(/\/+$/, '');
  parsed.searchParams.sort();
  return parsed.toString();
}

function isPrivateNetworkHost(host: string): boolean {
  if (
    host === '::1'
    || host === '::'
    || host.startsWith('::ffff:')
    || host.startsWith('fe80:')
    || host.startsWith('fc')
    || host.startsWith('fd')
  ) {
    return true;
  }
  const ipv4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!ipv4) return false;
  const octets = ipv4.slice(1).map(Number);
  if (octets.some((octet) => octet > 255)) return true;
  const [first, second] = octets;
  return first === 0
    || first === 10
    || first === 127
    || first === 169 && second === 254
    || first === 172 && second >= 16 && second <= 31
    || first === 192 && second === 168
    || first >= 224;
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
