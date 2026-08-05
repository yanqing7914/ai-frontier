import type { Direction } from './directions';
export type { Direction } from './directions';
export {
  normalizeDirection,
  isValidDirection,
  ALL_DIRECTION_IDS,
  DIRECTIONS,
  LEGACY_DIRECTION_MAP,
  getDirectionMeta,
} from './directions';

export type Tier = 'authoritative' | 'validation' | 'signal';
export type FeedType = 'rss' | 'atom' | 'api' | 'web';
export type OriginPolicy = 'first_party' | 'editorial' | 'aggregator';
export type OriginStatus = 'first_party' | 'editorial' | 'verified_reference' | 'needs_review' | 'unknown';
export type ArticleStatus = 'published' | 'draft' | 'blocked' | 'pending_review';
export type QualityGateReason = 'link_dead' | 'content_stale' | 'untraceable' | 'same_url' | 'same_title' | 'same_batch_url' | 'same_batch_title' | 'source_unreliable';
export type ReviewStatus = 'pending' | 'approved' | 'rejected';

export interface FeedSource {
  id: string;
  name: string;
  url: string;
  tier: Tier;
  feedType: FeedType;
  enabled: boolean;
  totalFetches: number;
  successFetches: number;
  lastSuccessAt: string | null;
  consecutiveFailures: number;
  lastError: string | null;
  sourceCategory: string | null;
  sourceCategoryId: string | null;
  region: string | null;
  primaryDirectionId: string | null;
  directionIds: string[];
  sourceLayer: string | null;
  originPolicy: OriginPolicy | null;
  createdAt: string;
  updatedAt: string;
}

export interface FeedSourceListItem {
  id: string;
  name: string;
  url: string;
  tier: Tier;
  feedType: FeedType;
  enabled: boolean;
  successRate: number;
  lastSuccessAt: string | null;
  consecutiveFailures: number;
  sourceCategory: string | null;
  sourceCategoryId: string | null;
  primaryDirectionId: string | null;
  sourceLayer: string | null;
  originPolicy: OriginPolicy | null;
}

export interface FeedSourceHealth {
  totalFetches: number;
  successFetches: number;
  successRate: number;
  lastSuccessAt: string | null;
  consecutiveFailures: number;
  lastError: string | null;
}

export interface CreateFeedSourceRequest {
  name: string;
  url: string;
  tier: Tier;
  feedType: FeedType;
  sourceCategory?: string;
  sourceCategoryId?: string;
  region?: string;
  primaryDirectionId?: string;
  directionIds?: string[];
  sourceLayer?: string;
  originPolicy?: OriginPolicy;
  notes?: string;
}

export interface UpdateFeedSourceRequest {
  name?: string;
  url?: string;
  tier?: Tier;
  feedType?: FeedType;
  sourceCategory?: string;
  sourceCategoryId?: string;
  region?: string;
  primaryDirectionId?: string;
  directionIds?: string[];
  sourceLayer?: string;
  originPolicy?: OriginPolicy;
  notes?: string;
}

export interface ToggleFeedSourceRequest {
  enabled: boolean;
}

export interface Article {
  id: string;
  title: string;
  url: string;
  originalUrl: string | null;
  contentHash: string;
  summary: string;
  sourceName: string;
  feedSourceId: string;
  publishedAt: string;
  collectedAt: string;
  clusterId: string | null;
  status: ArticleStatus;
  primaryDirection: Direction | null;
  primaryScore: number | null;
  aiProcessed: boolean;
}

export interface HotArticleItem {
  id: string;
  title: string;
  url: string;
  originalUrl: string | null;
  summary: string;
  sourceName: string;
  primaryDirection: Direction;
  primaryScore: number;
  publishedAt: string;
  clusterCount: number;
  frontPageRank: number | null;
}

export type ExcludeReason = 'source_cap' | 'direction_cap' | 'limit_reached';

export interface WorkbenchArticleItem {
  id: string;
  title: string;
  sourceName: string;
  primaryDirection: Direction | null;
  primaryScore: number | null;
  status: ArticleStatus;
  aiProcessed: boolean;
  aiDegradeReason: string | null;
  excludeReason: ExcludeReason | null;
  collectedAt: string;
}

export interface DirectionScoreItem {
  direction: Direction;
  totalScore: number;
  dimensionScores: DimensionScores;
}

export type DimensionScores = Record<string, number>;

export interface QualityGateItem {
  id: string;
  articleTitle: string;
  sourceName: string;
  reason: QualityGateReason;
  detail: string;
  blockedAt: string;
}

export interface ReviewItem {
  id: string;
  articleId: string;
  articleTitle: string;
  sourceName: string;
  url: string;
  status: ReviewStatus;
  collectedAt: string;
}

export interface ReviewActionRequest {
  action: 'approve' | 'reject';
  note?: string;
}

export type TraceStatus = OriginStatus;

export interface ArticleTrace {
  articleId: string;
  title: string;
  url: string;
  originalUrl: string | null;
  sourceName: string;
  originPolicy: OriginPolicy;
  originStatus: OriginStatus;
  originEvidence: string | null;
  originConfidence: number | null;
  traced: boolean;
  traceStatus: TraceStatus;
}

export interface DailyDigest {
  id: string;
  digestDate: string;
  summary: string;
  articleCount: number;
  articles: DailyDigestArticle[];
}

export interface DailyDigestArticle {
  id: string;
  title: string;
  primaryDirection: Direction;
  primaryScore: number;
}

export interface WorkbenchOverview {
  totalCollected: number;
  publishedCount: number;
  draftCount: number;
  pendingReviewCount: number;
  aiCallsToday: number;
  aiDailyLimit: number;
  aiDegraded: boolean;
}

export type HotlistKind = 'github' | 'weibo';

export interface GithubTrendingItem {
  rank: number;
  repo: string;
  url: string;
  description: string;
  descriptionZh: string;
  language: string;
  stars: number;
  starsToday: number;
}

export interface WeiboHotItem {
  rank: number;
  title: string;
  url: string;
  hot: number;
  tag: string;
}

export interface HotlistResponse<T = GithubTrendingItem | WeiboHotItem> {
  ok: boolean;
  kind: HotlistKind;
  updatedAt: string;
  source: 'live' | 'snapshot';
  items: T[];
}

export interface PaginatedResponse<T> {
  items: T[];
  total: number;
}

export interface PaginationParams {
  page: number;
  pageSize: number;
}
