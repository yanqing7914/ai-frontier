export const PIPELINE_STAGE_ORDER = [
  'source_ingest', 'scheduled_fetch', 'parse', 'normalize', 'url_dedup', 'trace',
  'classify', 'cluster', 'rule_score', 'ai_score', 'quality_gate', 'publish_outputs',
] as const;

export type PipelineStage = typeof PIPELINE_STAGE_ORDER[number];

export const STALE_DAYS = 7;
export const PIPELINE_RUN_STATE_KEY = 'pipeline_run_state';
export const PIPELINE_RUN_LEASE_KEY = 'pipeline_run_lease';
export const PIPELINE_LEASE_MS = 30 * 60 * 1000;
export const MAX_FETCH_CONCURRENCY = 10;
export const MAX_FETCH_RETRIES = 5;
export const MIN_FETCH_TIMEOUT_MS = 1_000;
export const MAX_FETCH_TIMEOUT_MS = 60_000;
export const MIN_FETCH_BODY_BYTES = 64 * 1024;
export const MAX_FETCH_BODY_BYTES = 10 * 1024 * 1024;

/** Only classified/ambiguous topics are worth spending the daily AI quota on. */
export function shouldAttemptAiScoring(status: string | undefined): boolean {
  return status === 'classified' || status === 'ambiguous';
}

export interface PipelineArticle {
  id: string;
  title: string;
  url: string;
  dedupUrl: string;
  content: string;
  rawContent: string;
  feedSourceId: string;
  sourceUrl: string;
  sourceTier: string;
  sourceName: string;
  sourceCategoryId: string | null;
  originPolicy: 'first_party' | 'editorial' | 'aggregator';
  publishedAt?: Date | null;
}

export interface RawFetchResponse {
  feedSourceId: string;
  feedType: string;
  url: string;
  finalUrl: string;
  contentType: string;
  sourceName: string;
  sourceTier: string;
  sourceCategoryId: string | null;
  originPolicy: string | null;
  rawContent: string;
  byteLength: number;
  httpStatus: number;
}
