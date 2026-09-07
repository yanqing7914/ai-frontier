import { Injectable, Inject, Logger } from '@nestjs/common';
import { DRIZZLE_DATABASE } from '../../infrastructure/database';
import type { PostgresJsDatabase } from '../../infrastructure/database';
import { eq, ne, inArray, and, isNotNull, isNull, lte, or, sql } from 'drizzle-orm';
import {
  article, feedSource, directionScore, qualityGate,
  reviewItem, appConfig,
} from '@server/database/schema';
import { FeedSourceService } from '../feed-source/feed-source.service';
import { DigestService } from '../digest/digest.service';
import { AiScoringService, buildScoringInput } from './ai-scoring.service';
import {
  normalizeUrl, normalizeTitle, getOriginPolicy, traceOriginFromContent, probeSafeLink,
} from './trace-engine';
import { fetchRawContent, FetchHttpError, parseRawContent } from './parsers';
import { normalizeItems } from './pipeline-normalize';
import { canonicalizeDedupUrl, computeDedupHash, dedupBatch, filterAgainstExisting } from './pipeline-dedup';
import * as crypto from 'crypto';
import { ALL_DIRECTION_IDS as DIRECTIONS, normalizeDirection } from '@shared/directions';
import { canPublishArticle } from './publish-gate';
import type { ScoreEvidence } from '@shared/api.interface';
import {
  runContentFilter,
} from './architecture';

export const PIPELINE_STAGE_ORDER = [
  'source_ingest', 'scheduled_fetch', 'parse', 'normalize', 'url_dedup', 'trace',
  'classify', 'cluster', 'rule_score', 'ai_score', 'quality_gate', 'publish_outputs',
] as const;

export type PipelineStage = typeof PIPELINE_STAGE_ORDER[number];

const STALE_DAYS = 7;
const CLUSTER_WINDOW_HOURS = 72;
const MAX_CLUSTER_HISTORY_ARTICLES = 1_200;
const MAX_CLUSTER_CANDIDATES_PER_ARTICLE = 80;
const MAX_CLUSTER_CANDIDATE_BUCKET = 50;
const MAX_CLUSTER_COMPARISONS = 20_000;
export const PIPELINE_RUN_STATE_KEY = 'pipeline_run_state';
const PIPELINE_RUN_LEASE_KEY = 'pipeline_run_lease';
const PIPELINE_LEASE_MS = 30 * 60 * 1000;
const MAX_FETCH_CONCURRENCY = 10;
const MAX_FETCH_RETRIES = 5;
const MIN_FETCH_TIMEOUT_MS = 1_000;
const MAX_FETCH_TIMEOUT_MS = 60_000;
const MIN_FETCH_BODY_BYTES = 64 * 1024;
const MAX_FETCH_BODY_BYTES = 10 * 1024 * 1024;

/** Only classified/ambiguous topics are worth spending the daily AI quota on. */
export function shouldAttemptAiScoring(status: string | undefined): boolean {
  return status === 'classified' || status === 'ambiguous';
}

interface PipelineArticle { id: string; title: string; url: string; dedupUrl: string; content: string; rawContent: string; feedSourceId: string; sourceUrl: string; sourceTier: string; sourceName: string; sourceCategoryId: string | null; originPolicy: 'first_party' | 'editorial' | 'aggregator'; publishedAt?: Date | null; }
interface RawFetchResponse { feedSourceId: string; feedType: string; url: string; finalUrl: string; contentType: string; sourceName: string; sourceTier: string; sourceCategoryId: string | null; originPolicy: string | null; rawContent: string; byteLength: number; httpStatus: number; }

/** Inputs and output are exported so clustering behaviour can be regression-tested without a DB. */
export interface EventClusterInput {
  id: string;
  title: string;
  url?: string | null;
  clusterId?: string | null;
  isNew?: boolean;
}

export interface EventClusterGroup {
  clusterId: string;
  itemIds: string[];
  hasExistingCluster: boolean;
}

export interface EventClusterPlan {
  groups: EventClusterGroup[];
  comparisons: number;
  comparisonBudgetExhausted: boolean;
}

interface ClusterTitleFeatures {
  normalized: string;
  terms: Set<string>;
  anchors: Set<string>;
  modelVersions: Set<string>;
  entitySignals: Set<string>;
  dates: Set<string>;
  keyNumbers: Set<string>;
  candidateKeys: string[];
}

interface ClusterRecord extends EventClusterInput {
  isNew: boolean;
  clusterId: string | null;
  features: ClusterTitleFeatures;
}

interface WorkingClusterGroup {
  records: ClusterRecord[];
  clusterId: string | null;
}

const GENERIC_CLUSTER_TERMS = new Set([
  '发布', '正式', '宣布', '推出', '上线', '更新', '模型', '人工智能', '大模型',
  '新闻', '报告', '研究', '测试', '公司', '产品', '版本', 'latest', 'release',
  'launch', 'announces', 'announced', 'update', 'model', 'models', 'new', 'the',
]);

const ENTITY_ALIASES: Array<[string, string]> = [
  ['openai', 'openai'], ['anthropic', 'anthropic'], ['google', 'google'], ['谷歌', 'google'],
  ['deepmind', 'google'], ['microsoft', 'microsoft'], ['微软', 'microsoft'], ['meta', 'meta'],
  ['amazon', 'amazon'], ['亚马逊', 'amazon'], ['nvidia', 'nvidia'], ['英伟达', 'nvidia'],
  ['alibaba', 'alibaba'], ['阿里', 'alibaba'], ['baidu', 'baidu'], ['百度', 'baidu'],
  ['tencent', 'tencent'], ['腾讯', 'tencent'], ['bytedance', 'bytedance'], ['字节', 'bytedance'],
  ['xai', 'xai'], ['mistral', 'mistral'],
];

function setIntersection<T>(left: Set<T>, right: Set<T>): Set<T> {
  const smaller = left.size <= right.size ? left : right;
  const larger = left.size <= right.size ? right : left;
  return new Set([...smaller].filter((item) => larger.has(item)));
}

function jaccardSetSimilarity(left: Set<string>, right: Set<string>): number {
  if (left.size === 0 || right.size === 0) return 0;
  const shared = setIntersection(left, right).size;
  return shared === 0 ? 0 : shared / (left.size + right.size - shared);
}

function addCjkNgrams(run: string, terms: Set<string>): void {
  const chars = [...run];
  for (const n of [2, 3]) {
    for (let index = 0; index <= chars.length - n; index++) {
      const gram = chars.slice(index, index + n).join('');
      if (!GENERIC_CLUSTER_TERMS.has(gram)) terms.add(gram);
    }
  }
}

function buildClusterFeatures(title: string, url?: string | null): ClusterTitleFeatures {
  const normalized = (title || '').normalize('NFKC').toLocaleLowerCase('en-US')
    .replace(/\s+/g, ' ').trim();
  const terms = new Set<string>();
  const modelVersions = new Set<string>();
  const entitySignals = new Set<string>();
  const dates = new Set<string>();
  const keyNumbers = new Set<string>();

  for (const match of normalized.matchAll(/\b(?:gpt|claude|gemini|llama|qwen|deepseek|kimi|longcat|mistral|grok|phi|copilot|codex)[\s_-]*v?(\d+(?:\.\d+)*)\b/g)) {
    modelVersions.add(match[0].replace(/[\s_-]+/g, '-'));
  }
  for (const [alias, canonical] of ENTITY_ALIASES) {
    if (normalized.includes(alias)) entitySignals.add(canonical);
  }
  for (const match of normalized.matchAll(/\b20\d{2}[-/.]\d{1,2}(?:[-/.]\d{1,2})?\b|20\d{2}年\d{1,2}月(?:\d{1,2}日)?/g)) {
    dates.add(match[0]);
  }
  // Units and percentages are comparatively stable event facts. Bare version numbers
  // are handled by modelVersions so they do not make two articles conflict spuriously.
  for (const match of normalized.matchAll(/\b\d+(?:\.\d+)?(?:%|k|m|b|t)\b|\d+(?:\.\d+)?(?:万|亿|兆)/g)) {
    keyNumbers.add(match[0]);
  }

  const cjkRuns = normalized.match(/[\u3400-\u9fff\uf900-\ufaff\u3040-\u30ff\uac00-\ud7af]+/g) || [];
  for (const run of cjkRuns) addCjkNgrams(run, terms);
  for (const token of normalized.match(/[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*/g) || []) {
    if (token.length >= 2 && !GENERIC_CLUSTER_TERMS.has(token)) terms.add(token);
  }
  for (const version of modelVersions) terms.add(version);
  for (const entity of entitySignals) terms.add(entity);

  const anchors = new Set<string>();
  for (const term of terms) {
    const isCjk = /[\u3400-\u9fff\uf900-\ufaff\u3040-\u30ff\uac00-\ud7af]/.test(term);
    if ((isCjk && [...term].length >= 3) || (!isCjk && term.length >= 4)) anchors.add(term);
  }
  for (const value of modelVersions) anchors.add(`model:${value}`);
  for (const value of entitySignals) anchors.add(`entity:${value}`);

  const candidateKeys = [
    ...[...modelVersions].sort().map((value) => `model:${value}`),
    ...[...entitySignals].sort().map((value) => `entity:${value}`),
    ...[...keyNumbers].sort().map((value) => `number:${value}`),
    ...[...anchors].filter((value) => !value.startsWith('model:') && !value.startsWith('entity:')).sort(),
  ];
  if (normalized.length >= 6) candidateKeys.unshift(`title:${normalized}`);
  if (url) {
    try {
      const parsed = new URL(url);
      candidateKeys.unshift(`url:${parsed.hostname.toLowerCase()}${parsed.pathname.replace(/\/+$/, '')}`);
    } catch {
      // URLs are an optional matching signal; malformed input must not stop clustering.
    }
  }
  return { normalized, terms, anchors, modelVersions, entitySignals, dates, keyNumbers, candidateKeys };
}

function conflictingSignals(left: ClusterTitleFeatures, right: ClusterTitleFeatures): boolean {
  if (left.modelVersions.size > 0 && right.modelVersions.size > 0
    && setIntersection(left.modelVersions, right.modelVersions).size === 0) return true;
  if (left.entitySignals.size > 0 && right.entitySignals.size > 0
    && setIntersection(left.entitySignals, right.entitySignals).size === 0) return true;
  if (left.dates.size > 0 && right.dates.size > 0
    && setIntersection(left.dates, right.dates).size === 0) return true;
  return left.keyNumbers.size > 0 && right.keyNumbers.size > 0
    && setIntersection(left.keyNumbers, right.keyNumbers).size === 0;
}

function scoreClusterPair(left: ClusterRecord, right: ClusterRecord): number | null {
  if (conflictingSignals(left.features, right.features)) return null;
  const termSimilarity = jaccardSetSimilarity(left.features.terms, right.features.terms);
  const sharedAnchors = setIntersection(left.features.anchors, right.features.anchors);
  const sharedModels = setIntersection(left.features.modelVersions, right.features.modelVersions);
  const sharedEntities = setIntersection(left.features.entitySignals, right.features.entitySignals);
  const hasStrongSignal = sharedModels.size > 0 || sharedEntities.size > 0 || sharedAnchors.size >= 2;
  if (!hasStrongSignal) return null;
  const anchorSimilarity = jaccardSetSimilarity(left.features.anchors, right.features.anchors);
  const score = termSimilarity * 0.72 + anchorSimilarity * 0.28;
  // A common model/entity may be an event anchor, but it still needs enough title
  // context to avoid merging every article mentioning that model or company.
  const threshold = sharedModels.size > 0 || sharedEntities.size > 0 ? 0.30 : 0.42;
  return score >= threshold ? score : null;
}

function stableClusterId(records: ClusterRecord[]): string {
  const sharedModels = records.map((record) => record.features.modelVersions)
    .reduce((shared, values) => setIntersection(shared, values));
  const sharedAnchors = records.map((record) => record.features.anchors)
    .reduce((shared, values) => setIntersection(shared, values));
  const signatureParts = (sharedModels.size > 0 ? [...sharedModels] : [...sharedAnchors])
    .filter((part) => !part.startsWith('entity:'))
    .sort()
    .slice(0, 6);
  const signature = signatureParts.length > 0
    ? signatureParts.join('|')
    : records.map((record) => record.features.normalized).sort()[0];
  return `evt_${crypto.createHash('sha256').update(`cluster-v2:${signature}`).digest('hex').slice(0, 24)}`;
}

/**
 * Complete-link clustering prevents an A-B-C similarity bridge from absorbing C
 * when A and C describe different events. Candidate generation is bounded before
 * expensive pair scoring so a large feed cannot devolve into an N-squared loop.
 */
export function planEventClusters(inputs: EventClusterInput[]): EventClusterPlan {
  const records: ClusterRecord[] = inputs.map((input) => ({
    ...input,
    isNew: input.isNew === true,
    clusterId: input.clusterId || null,
    features: buildClusterFeatures(input.title, input.url),
  })).sort((left, right) => {
    if (left.isNew !== right.isNew) return left.isNew ? 1 : -1;
    return left.id.localeCompare(right.id);
  });
  const pairScores = new Map<string, number>();
  const candidateIndex = new Map<string, string[]>();
  const byId = new Map(records.map((record) => [record.id, record]));
  let comparisons = 0;
  let comparisonBudgetExhausted = false;
  const pairKey = (left: string, right: string) => left < right ? `${left}\u0000${right}` : `${right}\u0000${left}`;

  for (const record of records) {
    const candidateIds = new Set<string>();
    for (const key of record.features.candidateKeys) {
      for (const id of candidateIndex.get(key) || []) {
        if (candidateIds.size >= MAX_CLUSTER_CANDIDATES_PER_ARTICLE) break;
        candidateIds.add(id);
      }
      if (candidateIds.size >= MAX_CLUSTER_CANDIDATES_PER_ARTICLE) break;
    }
    for (const candidateId of candidateIds) {
      if (comparisons >= MAX_CLUSTER_COMPARISONS) {
        comparisonBudgetExhausted = true;
        break;
      }
      const candidate = byId.get(candidateId);
      if (!candidate) continue;
      comparisons++;
      const score = scoreClusterPair(record, candidate);
      if (score !== null) pairScores.set(pairKey(record.id, candidate.id), score);
    }
    for (const key of record.features.candidateKeys) {
      const bucket = candidateIndex.get(key) || [];
      if (bucket.length < MAX_CLUSTER_CANDIDATE_BUCKET) bucket.push(record.id);
      candidateIndex.set(key, bucket);
    }
    if (comparisonBudgetExhausted) break;
  }

  const groups: WorkingClusterGroup[] = [];
  const knownGroups = new Map<string, WorkingClusterGroup>();
  for (const record of records.filter((item) => !item.isNew && item.clusterId)) {
    const group = knownGroups.get(record.clusterId!) || { records: [], clusterId: record.clusterId };
    group.records.push(record);
    knownGroups.set(record.clusterId!, group);
    if (!groups.includes(group)) groups.push(group);
  }

  const pending = records.filter((record) => !(!record.isNew && record.clusterId));
  for (const record of pending) {
    let bestGroup: WorkingClusterGroup | null = null;
    let bestScore = -1;
    for (const group of groups) {
      const scores = group.records.map((member) => pairScores.get(pairKey(record.id, member.id)));
      if (scores.some((score) => score === undefined)) continue;
      const average = scores.reduce((sum, score) => sum + (score || 0), 0) / scores.length;
      if (average > bestScore || (average === bestScore && group.clusterId !== null && bestGroup?.clusterId === null)) {
        bestGroup = group;
        bestScore = average;
      }
    }
    if (bestGroup) bestGroup.records.push(record);
    else groups.push({ records: [record], clusterId: null });
  }

  return {
    groups: groups
      .filter((group) => group.clusterId !== null || group.records.length > 1)
      .map((group) => ({
        clusterId: group.clusterId || stableClusterId(group.records),
        itemIds: group.records.map((record) => record.id).sort(),
        hasExistingCluster: group.clusterId !== null,
      }))
      .sort((left, right) => left.clusterId.localeCompare(right.clusterId)),
    comparisons,
    comparisonBudgetExhausted,
  };
}

@Injectable()
export class CollectorService {
  private readonly logger = new Logger(CollectorService.name);
  private pipelineRunning = false;

  constructor(
    @Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase,
    private readonly feedSourceService: FeedSourceService,
    private readonly digestService: DigestService,
    private readonly aiScoringService: AiScoringService,
  ) {}

  /**
   * Fast-ack entry point for the scheduler.
   *
   * The platform's dispatch phase hard-fails at ~10s (observed duration_ms 10001),
   * while a full run legitimately takes ~10 minutes — a single AI scoring call alone
   * has been measured at 13.2s. The runtime is NOT killed at the ack deadline
   * (a run was observed continuing for 596s past it), so we acknowledge the trigger
   * immediately and let the pipeline finish detached, recording the real outcome in
   * `pipeline_run_state` instead of hiding it behind a timed-out dispatch record.
   */
  async startPipelineDetached(
    trigger: string,
  ): Promise<{ accepted: boolean; reason?: string }> {
    if (this.pipelineRunning) {
      this.logger.warn(`Pipeline run rejected (${trigger}): a run is already in progress`);
      return { accepted: false, reason: 'a pipeline run is already in progress' };
    }

    // Claim the in-process slot before the first await. This closes the detached
    // entry point's TOCTOU window while the database lease covers other instances.
    this.pipelineRunning = true;
    const startedAt = new Date().toISOString();
    const leaseToken = crypto.randomUUID();

    // Do not await database work here. Scheduler dispatchers commonly impose a
    // ~10 second HTTP budget, while lease/state writes can block on a degraded
    // database before the actual pipeline has even started.
    void this.initializeDetachedRun({ trigger, startedAt, leaseToken });

    this.logger.log(`Pipeline run accepted (${trigger}); executing detached`);
    return { accepted: true };
  }

  /** Acquire the cross-instance lease and run the detached pipeline off-request. */
  private async initializeDetachedRun(context: {
    trigger: string;
    startedAt: string;
    leaseToken: string;
  }): Promise<void> {
    let leaseAcquired = false;
    let pipelineStarted = false;
    try {
      leaseAcquired = await this.acquirePipelineLease(context.leaseToken);
      if (!leaseAcquired) {
        this.pipelineRunning = false;
        this.logger.warn(`Pipeline run rejected (${context.trigger}): a database lease is already active`);
        return;
      }
      await this.writeRunState({
        status: 'running', trigger: context.trigger, startedAt: context.startedAt,
      });
      pipelineStarted = true;
      await this.runWithLease(context);
    } catch (error: unknown) {
      const errMsg = error instanceof Error ? error.message : String(error);
      this.logger.error(`Pipeline could not be initialized (${context.trigger}): ${errMsg}`);
      if (error instanceof Error && error.stack) this.logger.error(`Stack: ${error.stack}`);
      if (leaseAcquired && !pipelineStarted) {
        await this.releasePipelineLease(context.leaseToken).catch((releaseError: unknown) => {
          this.logger.error(`Failed to release pipeline lease: ${releaseError instanceof Error ? releaseError.message : String(releaseError)}`);
        });
      }
      if (!pipelineStarted) {
        await this.writeRunState({
          status: 'failed', trigger: context.trigger, startedAt: context.startedAt,
          finishedAt: new Date().toISOString(), error: errMsg,
        }).catch((stateError: unknown) => {
          this.logger.error(`Failed to persist pipeline initialization failure: ${stateError instanceof Error ? stateError.message : String(stateError)}`);
        });
      }
      this.pipelineRunning = false;
    }
  }

  /** Persist the outcome of the most recent run so a detached failure is never invisible. */
  private async writeRunState(state: {
    status: 'running' | 'succeeded' | 'failed';
    trigger: string;
    startedAt: string;
    finishedAt?: string;
    error?: string;
  }): Promise<void> {
    await this.db
      .insert(appConfig)
      .values({
        key: PIPELINE_RUN_STATE_KEY,
        value: state,
        description: 'Outcome of the most recent collector pipeline run',
      })
      .onConflictDoUpdate({ target: appConfig.key, set: { value: state } });
  }

  async getRunState(): Promise<Record<string, unknown> | null> {
    const [row] = await this.db
      .select()
      .from(appConfig)
      .where(eq(appConfig.key, PIPELINE_RUN_STATE_KEY));
    return (row?.value as Record<string, unknown> | undefined) ?? null;
  }

  async runPipeline(): Promise<void> {
    if (this.pipelineRunning) { this.logger.log('Pipeline already running, skipping'); return; }
    this.pipelineRunning = true;
    const trigger = 'direct';
    const startedAt = new Date().toISOString();
    const leaseToken = crypto.randomUUID();
    try {
      if (!await this.acquirePipelineLease(leaseToken)) {
        this.logger.log('Pipeline already running on another instance, skipping');
        this.pipelineRunning = false;
        return;
      }
      await this.writeRunState({ status: 'running', trigger, startedAt });
      await this.runWithLease({ trigger, startedAt, leaseToken });
    } catch (error: unknown) {
      // runWithLease owns the normal release path; this only handles a failure
      // before it receives the acquired lease.
      await this.releasePipelineLease(leaseToken).catch(() => undefined);
      this.pipelineRunning = false;
      throw error;
    }
  }

  private async runWithLease(context: {
    trigger: string;
    startedAt: string;
    leaseToken: string;
  }): Promise<void> {
    const startTime = Date.now();
    try {
      await this.executeFullPipeline();
      await this.writeRunState({
        status: 'succeeded', trigger: context.trigger, startedAt: context.startedAt,
        finishedAt: new Date().toISOString(),
      });
    } catch (error: unknown) {
      const errMsg = error instanceof Error ? error.message : String(error);
      this.logger.error(`Pipeline failed: ${errMsg}`);
      if (error instanceof Error && error.stack) this.logger.error(`Stack: ${error.stack}`);
      await this.writeRunState({
        status: 'failed', trigger: context.trigger, startedAt: context.startedAt,
        finishedAt: new Date().toISOString(), error: errMsg,
      }).catch((stateErr: unknown) => {
        this.logger.error(`Failed to persist pipeline failure state: ${stateErr instanceof Error ? stateErr.message : String(stateErr)}`);
      });
      throw error;
    } finally {
      await this.releasePipelineLease(context.leaseToken).catch((error: unknown) => {
        this.logger.error(`Failed to release pipeline lease: ${error instanceof Error ? error.message : String(error)}`);
      });
      this.pipelineRunning = false;
      this.logger.log(`Pipeline finished in ${(((Date.now() - startTime) / 1000)).toFixed(1)}s`);
    }
  }

  private async acquirePipelineLease(token: string): Promise<boolean> {
    const now = Date.now();
    const expiresAt = new Date(now + PIPELINE_LEASE_MS).toISOString();
    const [existing] = await this.db
      .select({ value: appConfig.value })
      .from(appConfig)
      .where(eq(appConfig.key, PIPELINE_RUN_LEASE_KEY));

    const existingLease = existing?.value as { expiresAt?: unknown } | undefined;
    const existingExpiresAt = typeof existingLease?.expiresAt === 'string'
      ? Date.parse(existingLease.expiresAt)
      : Number.NaN;
    if (existing && Number.isFinite(existingExpiresAt) && existingExpiresAt >= now) {
      return false;
    }

    const lease = { token, expiresAt };
    if (!existing) {
      try {
        await this.db.insert(appConfig).values({
          key: PIPELINE_RUN_LEASE_KEY,
          value: lease,
          description: 'Cross-instance collector run lease',
        });
        return true;
      } catch (error: unknown) {
        // A competing instance may have inserted the lease first. Re-read instead
        // of treating a unique-key race as a failed collection run.
        const [raced] = await this.db
          .select({ value: appConfig.value })
          .from(appConfig)
          .where(eq(appConfig.key, PIPELINE_RUN_LEASE_KEY));
        if (raced) return false;
        throw error;
      }
    }

    const updated = await this.db
      .update(appConfig)
      .set({ value: lease, description: 'Cross-instance collector run lease' })
      .where(and(
        eq(appConfig.key, PIPELINE_RUN_LEASE_KEY),
        eq(appConfig.value, existing.value),
      ))
      .returning({ id: appConfig.id });
    return updated.length === 1;
  }

  private async releasePipelineLease(token: string): Promise<void> {
    const [existing] = await this.db
      .select({ value: appConfig.value })
      .from(appConfig)
      .where(eq(appConfig.key, PIPELINE_RUN_LEASE_KEY));
    const lease = existing?.value as { token?: unknown } | undefined;
    if (lease?.token !== token || !existing) return;
    await this.db
      .update(appConfig)
      .set({ value: { token, expiresAt: new Date(0).toISOString() } })
      .where(and(
        eq(appConfig.key, PIPELINE_RUN_LEASE_KEY),
        eq(appConfig.value, existing.value),
      ));
  }

  /** Log all remaining stages from `from` (1-indexed) as skipped/empty. */
  private logEmptyStages(from: number): void {
    const msgs: Record<number, string> = {
      2: '[2/12] scheduled_fetch: skipped, ok=0, fail=0, bytes=0',
      3: '[3/12] parse: skipped, ok=0, fail=0, items=0',
      4: '[4/12] normalize: skipped, passed=0, dropped=0',
      5: '[5/12] url_dedup: skipped, passed=0, deduped=0',
      6: '[6/12] trace: skipped, needed=0, ok=0, fail=0',
      7: '[7/12] classify: skipped, ok=0, degraded=0',
      8: '[8/12] cluster: skipped, 0 articles',
      9: '[9/12] rule_score: skipped, ok=0, fail=0',
      10: '[10/12] ai_score: skipped, ai=0, degraded=0',
      11: '[11/12] quality_gate: skipped, passed=0',
      12: '[12/12] publish_outputs: skipped, published=0, digest=ensured',
    };
    for (let i = from; i <= 12; i++) {
      if (msgs[i]) this.logger.log(msgs[i]);
    }
  }

  private async executeFullPipeline(): Promise<void> {
    this.logger.log(`Pipeline started [${PIPELINE_STAGE_ORDER.length} stages]`);
    const today = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Shanghai',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date());
    const concurrency = await this.getBoundedConfig('fetch_concurrency', 3, 1, MAX_FETCH_CONCURRENCY);
    const retryCount = await this.getBoundedConfig('fetch_retry_count', 3, 1, MAX_FETCH_RETRIES);
    const fetchTimeoutMs = await this.getBoundedConfig('fetch_timeout_ms', 15_000, MIN_FETCH_TIMEOUT_MS, MAX_FETCH_TIMEOUT_MS);
    const fetchMaxBodyBytes = await this.getBoundedConfig('fetch_max_body_bytes', 5 * 1024 * 1024, MIN_FETCH_BODY_BYTES, MAX_FETCH_BODY_BYTES);
    const aiDailyLimit = await this.getConfig('ai_daily_limit', 500);

    // ── Stage 1/12: source_ingest ──
    const sources = await this.db
      .select()
      .from(feedSource)
      .where(
        and(
          eq(feedSource.enabled, true),
          or(isNull(feedSource.nextFetchAt), lte(feedSource.nextFetchAt, new Date())),
        ),
      );
    if (sources.length === 0) {
      this.logger.log('[1/12] source_ingest: 0 eligible sources');
      this.logEmptyStages(2);
      await this.ensureDigest(today);
      return;
    }
    this.logger.log(`[1/12] source_ingest: ${sources.length} eligible sources (enabled and not cooling down)`);

    // ── Stage 2/12: scheduled_fetch ──
    const rawResponses: RawFetchResponse[] = [];
    let fetchOk = 0, fetchFail = 0, fetchBytesTotal = 0;
    const stageErrors: string[] = [];
    await this.processBatch(sources, concurrency, async (source) => {
      let raw: Awaited<ReturnType<typeof fetchRawContent>> | null = null;
      for (let attempt = 1; attempt <= retryCount; attempt++) {
        try {
          raw = await fetchRawContent(source.url, { timeoutMs: fetchTimeoutMs, maxBytes: fetchMaxBodyBytes });
          break;
        } catch (error: unknown) {
          const errMsg = error instanceof Error ? error.message : String(error);
          this.logger.warn(`Fetch attempt ${attempt}/${retryCount} for "${source.name}": ${errMsg}`);
          if (attempt === retryCount) {
            try {
              await this.feedSourceService.updateFetchStats(source.id, false, errMsg);
            } catch (statsError: unknown) {
              const statsMsg = statsError instanceof Error ? statsError.message : String(statsError);
              stageErrors.push(`stats(${source.name}): ${statsMsg}`);
              this.logger.error(`Fetch stats failed for "${source.name}": ${statsMsg}`);
            }
            fetchFail++;
            return;
          }
          const retryAfter = error instanceof FetchHttpError ? error.retryAfterMs : null;
          const exponential = 1000 * Math.pow(2, attempt - 1);
          const jitter = Math.floor(Math.random() * Math.max(250, exponential * 0.25));
          await this.sleep(Math.min(60_000, retryAfter ?? (exponential + jitter)));
        }
      }
      if (raw) {
        try {
          await this.feedSourceService.updateFetchStats(source.id, true);
        } catch (statsError: unknown) {
          const statsMsg = statsError instanceof Error ? statsError.message : String(statsError);
          stageErrors.push(`stats(${source.name}): ${statsMsg}`);
          this.logger.error(`Fetch stats failed for "${source.name}": ${statsMsg}`);
        }
        fetchOk++;
        fetchBytesTotal += raw.byteLength;
        rawResponses.push({
          feedSourceId: source.id, feedType: source.feedType, url: source.url,
          finalUrl: raw.finalUrl, contentType: raw.contentType,
          sourceName: source.name, sourceTier: source.tier,
          sourceCategoryId: source.sourceCategoryId,
          originPolicy: source.originPolicy,
          rawContent: raw.content, byteLength: raw.byteLength, httpStatus: raw.httpStatus,
        });
      } else { fetchFail++; }
    });
    this.logger.log(`[2/12] scheduled_fetch: ok=${fetchOk}, fail=${fetchFail}, bytes=${fetchBytesTotal}`);
    if (stageErrors.length > 0) {
      throw new Error(`scheduled_fetch errors: ${stageErrors.slice(0, 5).join('; ')}`);
    }

    if (rawResponses.length === 0) {
      this.logEmptyStages(3);
      await this.ensureDigest(today);
      return;
    }

    // ── Stage 3/12: parse ──
    type ParsedBatch = { items: Array<{ title: string; url: string; canonicalUrl?: string; publishedAt: Date | null; content: string; rawContent: string }>; feedSourceId: string; sourceName: string; sourceTier: string; sourceCategoryId: string | null; originPolicy: string | null; parserType?: string; finalUrl?: string; contentType?: string; httpStatus?: number; inputCount: number; parsedCount: number; skippedCount: number; warnings: string[]; };
    const allParsedItems: ParsedBatch[] = [];
    let parseOk = 0, parseFail = 0;
    for (const resp of rawResponses) {
      const result = await parseRawContent(resp.feedType, resp.rawContent, resp.url, {
        finalUrl: resp.finalUrl,
        contentType: resp.contentType,
        httpStatus: resp.httpStatus,
      });
      if (result.error || result.items.length === 0) {
        parseFail++;
        this.logger.warn(`Parse failed for "${resp.sourceName}" (${result.provenance?.parserType || resp.feedType}, ${result.provenance?.finalUrl || resp.finalUrl}): ${result.error || 'No items in feed'}`);
      } else {
        parseOk++;
        allParsedItems.push({
          items: result.items, feedSourceId: resp.feedSourceId, sourceName: resp.sourceName,
          sourceTier: resp.sourceTier, sourceCategoryId: resp.sourceCategoryId, originPolicy: resp.originPolicy,
          parserType: result.provenance?.parserType, finalUrl: result.provenance?.finalUrl,
          contentType: result.provenance?.contentType, httpStatus: result.provenance?.httpStatus,
          inputCount: result.stats?.input ?? 0, parsedCount: result.stats?.parsed ?? result.items.length,
          skippedCount: result.stats?.skipped ?? 0, warnings: result.warnings ?? [],
        });
        if (result.warnings?.length) this.logger.warn(`Parse warnings for "${resp.sourceName}": ${result.warnings.join('; ')}`);
      }
    }
    this.logger.log(`[3/12] parse: ok=${parseOk}, fail=${parseFail}, items=${allParsedItems.reduce((s: number, b) => s + b.items.length, 0)}`);

    // ── Stage 4/12: normalize ──
    type NormItem = ReturnType<typeof normalizeItems>['items'][number];
    let allNormalized: NormItem[] = [];
    let normalizeDropped = 0;
    for (const batch of allParsedItems) {
      const result = normalizeItems(batch.items, { name: batch.sourceName, tier: batch.sourceTier, feedSourceId: batch.feedSourceId });
      allNormalized = allNormalized.concat(result.items);
      normalizeDropped += result.dropped;
    }
    this.logger.log(`[4/12] normalize: passed=${allNormalized.length}, dropped=${normalizeDropped}`);

    // ── Stage 5/12: url_dedup ──
    // Stage 4 supplies dedupUrl. Re-canonicalize it here so batch comparison,
    // persistence and later database filtering share one immutable identity.
    const sourceById = new Map(sources.map((source) => [source.id, source]));
    const normalizedForDedup = allNormalized.map((item) => {
      const dedupUrl = canonicalizeDedupUrl(item.dedupUrl);
      return {
        ...item,
        dedupUrl,
        contentHash: computeDedupHash(item.title, dedupUrl),
      };
    }).filter((item) => Boolean(item.dedupUrl));
    const dedupInput = normalizedForDedup.map((item, index) => ({
      id: String(index),
      url: item.dedupUrl,
      contentHash: item.contentHash,
      title: item.title,
      originPolicy: sourceById.get(item.feedSourceId)?.originPolicy,
      sourceTier: item.sourceTier,
      sourceName: item.sourceName,
      contentLength: item.content.length,
    }));
    // Pick the deterministic source/content winner before consulting the DB.
    const batchDedup = dedupBatch(dedupInput);
    const candidateUrls = batchDedup.passed.map((item) => item.url);
    // The 30-day window preserves the legacy URL/hash comparison while the
    // permanent dedup_url lookup protects new canonical rows across all runs.
    const recentArticles = await this.db
      .select({ url: article.url, dedupUrl: article.dedupUrl, contentHash: article.contentHash })
      .from(article)
      .where(or(
        sql`${article.collectedAt} > NOW() - INTERVAL '30 days'`,
        inArray(article.dedupUrl, candidateUrls),
      ));
    const existingHashes = new Set(recentArticles.map((row) => row.contentHash));
    const existingUrls = new Set(recentArticles.map((row) =>
      canonicalizeDedupUrl(row.dedupUrl || row.url)).filter(Boolean));
    const dbFiltered = filterAgainstExisting(batchDedup.passed, existingHashes, existingUrls);
    const totalDeduped = dbFiltered.deduped + batchDedup.deduped;
    const newItems = dbFiltered.passed
      .map((item) => normalizedForDedup[Number(item.id)])
      .filter((item): item is typeof normalizedForDedup[number] => Boolean(item));
    this.logger.log(`[5/12] url_dedup: passed=${newItems.length}, deduped=${totalDeduped}`);

    if (newItems.length === 0) {
      this.logEmptyStages(6);
      await this.ensureDigest(today);
      return;
    }

    // The permanent unique constraints make concurrent process races safe. A
    // conflict is logged below instead of silently treating an existing article
    // as a successful update.
    let allNewArticles: PipelineArticle[] = [];
    let insertConflicts = 0;
    for (const item of newItems) {
      const source = sourceById.get(item.feedSourceId);
      const originPolicy = getOriginPolicy({
        originPolicy: source?.originPolicy,
        tier: item.sourceTier,
        discoveryUrl: item.url,
        sourceUrl: source?.url,
        sourceName: item.sourceName,
        sourceCategoryId: source?.sourceCategoryId,
      });
      const inserted = await this.db.insert(article).values({
        title: item.title,
        url: item.url,
        originalUrl: item.originalUrl,
        canonicalUrl: item.canonicalUrl,
        dedupUrl: item.dedupUrl,
        contentHash: item.contentHash,
        scoringInput: buildScoringInput(item.title, item.content),
        sourceName: item.sourceName, feedSourceId: item.feedSourceId,
        publishedAt: item.publishedAt ?? new Date(), status: 'draft',
        originStatus: originPolicy,
        originEvidence: originPolicy === 'first_party' ? '文章由一手发布源直接采集' : '可信编辑采编内容，无需站外原文作为发布前提',
        originConfidence: originPolicy === 'first_party' ? 100 : originPolicy === 'editorial' ? 80 : null,
      }).onConflictDoNothing().returning({ id: article.id });
      if (inserted.length === 0) {
        insertConflicts++;
        this.logger.warn(`url_dedup insert conflict: ${item.dedupUrl}`);
        continue;
      }
      allNewArticles.push({
        id: inserted[0].id, title: item.title, url: item.url,
        dedupUrl: item.dedupUrl,
        content: item.content, rawContent: item.rawContent,
        feedSourceId: item.feedSourceId,
        sourceUrl: source?.url || '',
        sourceTier: item.sourceTier,
        sourceName: item.sourceName,
        sourceCategoryId: source?.sourceCategoryId ?? null,
        originPolicy,
        publishedAt: item.publishedAt,
      });
    }
    this.logger.log(`Inserted ${allNewArticles.length} new articles; concurrent conflicts=${insertConflicts}`);

    // ── Stage 6/12: trace ──
    let traceNeeded = 0, traceOk = 0, traceFail = 0;
    const traceFailIds = new Set<string>();
    for (const art of allNewArticles) {
      const originPolicy = getOriginPolicy({
        originPolicy: art.originPolicy,
        tier: art.sourceTier,
        discoveryUrl: art.url,
        sourceUrl: art.sourceUrl,
        sourceName: art.sourceName,
        sourceCategoryId: art.sourceCategoryId,
      });
      const needsTrace = originPolicy === 'aggregator';
      if (!needsTrace) continue;
      traceNeeded++;
      if (await this.traceOrigin(art)) { traceOk++; } else { traceFail++; traceFailIds.add(art.id); }
    }
    this.logger.log(`[6/12] trace: needed=${traceNeeded}, ok=${traceOk}, fail=${traceFail}`);

    // Content filtering is a post-processing role attached to the existing
    // classify boundary. Dropped/review items are removed from the active
    // batch so they cannot consume scoring quota or reach publish_outputs.
    let filterKept = 0;
    let filterRejected = 0;
    let filterReview = 0;
    const filterAuditKeys: string[] = [];
    const filterExcludedIds = new Set<string>();
    const filterReadyArticles: PipelineArticle[] = [];
    for (const art of allNewArticles) {
      const filterEnvelope = runContentFilter(
        {
          articleId: art.id,
          title: art.title,
          content: art.content,
          url: art.url,
          sourceName: art.sourceName,
          sourceTier: art.sourceTier,
          sourceCategoryId: art.sourceCategoryId,
          publishedAt: art.publishedAt?.toISOString() ?? null,
        },
      );
      const filterOutput = filterEnvelope.output;
      const filterAudit = JSON.stringify({
        role: filterEnvelope.role,
        contract_version: filterEnvelope.contractVersion,
        outcome: filterEnvelope.outcome,
        idempotency_key: filterEnvelope.idempotencyKey,
        reason_code: filterOutput.reasonCode,
        evidence: filterEnvelope.evidence,
        diagnostics: filterEnvelope.diagnostics,
      });
      filterAuditKeys.push(`${art.id}:${filterEnvelope.idempotencyKey}:${filterEnvelope.outcome}`);

      if (filterOutput.decision === 'reject' || filterEnvelope.outcome === 'rejected') {
        filterRejected++;
        filterExcludedIds.add(art.id);
        await this.db.update(article).set({
          status: 'blocked',
          aiDegradeReason: filterAudit,
        }).where(eq(article.id, art.id));
        continue;
      }
      if (filterOutput.decision === 'review' || filterEnvelope.outcome === 'review') {
        filterReview++;
        filterExcludedIds.add(art.id);
        await this.db.update(article).set({
          status: 'pending_review',
          aiDegradeReason: filterAudit,
        }).where(eq(article.id, art.id));
        await this.createReviewItem(art.id);
        continue;
      }
      filterKept++;
      filterReadyArticles.push(art);
    }
    allNewArticles = filterReadyArticles;
    this.logger.log(`[content_filter] keep=${filterKept}, reject=${filterRejected}, review=${filterReview}, audit_keys=${filterAuditKeys.slice(0, 20).join(',')}${filterAuditKeys.length > 20 ? ',...' : ''}`);

    // ── Stage 7/12: classify (topic classification only, no ruleBasedScore) ──
    let classOk = 0, classDegraded = 0;
    const classifyMap = new Map<string, string | null>();
    const classifyMetaMap = new Map<string, { status: string; ambiguous: boolean; candidates: unknown[]; degradeReason: string | null }>();
    for (const art of allNewArticles) {
      try {
        const source = sources.find((s) => s.id === art.feedSourceId);
        const tier = source?.tier ?? 'signal';
        const classResult = this.aiScoringService.classifyArticle(art.title, art.content, tier);
        classifyMap.set(art.id, classResult.primaryDirection);
        classifyMetaMap.set(art.id, {
          status: classResult.status,
          ambiguous: classResult.ambiguous,
          candidates: classResult.candidates,
          degradeReason: classResult.degradeReason,
        });
        const setStatus = traceFailIds.has(art.id) ? 'pending_review' : undefined;
        await this.db.update(article).set({
          primaryDirection: classResult.primaryDirection,
          aiProcessed: false,
          aiDegradeReason: JSON.stringify({
            classification_status: classResult.status,
            ambiguous: classResult.ambiguous,
            candidates: classResult.candidates,
            degrade_reason: classResult.degradeReason,
          }),
          ...(setStatus ? { status: setStatus } : {}),
        }).where(eq(article.id, art.id));
        if (traceFailIds.has(art.id)) await this.createReviewItem(art.id);
        classOk++;
      } catch (error: unknown) {
        const errMsg = error instanceof Error ? error.message : String(error);
        this.logger.warn(`Classification failed for "${art.title}": ${errMsg}`);
        classDegraded++;
        classifyMetaMap.set(art.id, {
          status: 'degraded', ambiguous: false, candidates: [], degradeReason: errMsg,
        });
        await this.db.update(article).set({
          primaryDirection: null,
          aiProcessed: false,
          aiDegradeReason: JSON.stringify({ classification_status: 'degraded', degrade_reason: errMsg }),
        }).where(eq(article.id, art.id));
        if (traceFailIds.has(art.id)) {
          await this.db.update(article).set({ status: 'pending_review' }).where(eq(article.id, art.id));
          await this.createReviewItem(art.id);
        }
      }
    }
    this.logger.log(`[7/12] classify: ok=${classOk}, degraded=${classDegraded}`);

    // ── Stage 8/12: cluster ──
    const clusterResult = await this.clusterArticles(allNewArticles);
    this.logger.log(`[8/12] cluster: ${allNewArticles.length} new, groups=${clusterResult.groups}, comparisons=${clusterResult.comparisons}${clusterResult.degraded ? ', degraded' : ''}`);

    // ── Stage 9/12: rule_score (call ruleBasedScoreArticle, persist 9 direction_scores) ──
    let ruleOk = 0, ruleFail = 0;
    for (const art of allNewArticles) {
      try {
        const source = sources.find((s) => s.id === art.feedSourceId);
        const tier = source?.tier ?? 'signal';
        const ruleResult = this.aiScoringService.ruleBasedScoreArticle(art.title, art.content, tier);
        await this.db.delete(directionScore).where(eq(directionScore.articleId, art.id));
        for (const dir of DIRECTIONS) {
          const ev = ruleResult.directionScores[dir];
          // Rule scoring is the safe fallback when the AI quota is exhausted.
          // Persist its text-grounded matches so the publish gate can audit the
          // same evidence instead of treating every fallback score as opaque.
          const evidence = ev?.evidenceByDimension
            ? Object.values(ev.evidenceByDimension).flat()
            : [];
          await this.db.insert(directionScore).values({
            articleId: art.id, direction: dir,
            dimensionScores: ev?.dimensionScores ?? {},
            evidence,
            totalScore: ev?.normalizedScore ?? 0,
          });
        }
        const classifyMeta = classifyMetaMap.get(art.id);
        const ruleDirection = classifyMeta?.ambiguous ? null : ruleResult.primaryDirection;
        await this.db.update(article).set({
          // Rule scoring may fill an unclassified topic, but must not silently
          // resolve a low-margin classification tie.
          primaryDirection: ruleDirection ?? classifyMap.get(art.id) ?? null,
          primaryScore: ruleResult.publishScore,
          summary: ruleResult.summary,
          aiDegradeReason: ruleResult.degradeReason ?? (classifyMeta ? JSON.stringify({
            classification_status: classifyMeta.status,
            ambiguous: classifyMeta.ambiguous,
            candidates: classifyMeta.candidates,
            degrade_reason: classifyMeta.degradeReason,
          }) : null),
        }).where(eq(article.id, art.id));
        ruleOk++;
      } catch (error: unknown) {
        const errMsg = error instanceof Error ? error.message : String(error);
        this.logger.warn(`Rule score failed for "${art.title}": ${errMsg}`);
        ruleFail++;
      }
    }
    this.logger.log(`[9/12] rule_score: ok=${ruleOk}, fail=${ruleFail}`);

    // ── Stage 10/12: ai_score (AI enhancement, fallback to rule) ──
    const aiPerSourceLimit = await this.getConfig('ai_per_source_limit', 30);
    let aiCount = await this.getAiCallCount(today);
    const tierMap = new Map<string, string>();
    for (const s of sources) tierMap.set(s.id, s.tier);

    // Quota accounting is keyed by immutable feedSourceId, never display name.
    const perSourceCount = new Map<string, number>();
    const todayAiArticles = await this.db
      .select({ feedSourceId: article.feedSourceId }).from(article)
      .where(and(
        eq(article.aiProcessed, true),
        sql`(${article.collectedAt} AT TIME ZONE 'Asia/Shanghai')::date = ${today}::date`,
      ));
    for (const row of todayAiArticles) {
      if (row.feedSourceId) perSourceCount.set(row.feedSourceId, (perSourceCount.get(row.feedSourceId) || 0) + 1);
    }

    const TIER_PRIORITY: Record<string, number> = { authoritative: 0, validation: 1, signal: 2 };
    const sortedForScoring = [...allNewArticles].sort((a, b) => {
      const pA = TIER_PRIORITY[tierMap.get(a.feedSourceId) ?? 'signal'] ?? 2;
      const pB = TIER_PRIORITY[tierMap.get(b.feedSourceId) ?? 'signal'] ?? 2;
      if (pA !== pB) return pA - pB;
      const cntA = perSourceCount.get(a.feedSourceId) || 0;
      const cntB = perSourceCount.get(b.feedSourceId) || 0;
      return cntA - cntB;
    });

    let aiUsed = 0, aiDegraded = 0;
    for (const art of sortedForScoring) {
      const source = sources.find((s) => s.id === art.feedSourceId);
      const tier = source?.tier ?? 'signal';
      const srcName = source?.name ?? 'unknown';
      const srcUsed = perSourceCount.get(art.feedSourceId) || 0;
      let result;
      let usedAi = false;

      const classifyMeta = classifyMetaMap.get(art.id);
      if (!shouldAttemptAiScoring(classifyMeta?.status)) {
        // A no-match/degraded topic has already failed the cheap, direction-
        // specific relevance pass. Keep its rule score for audit, but do not
        // spend a provider call or quota unit on unrelated feed noise.
        const reason = classifyMeta?.status === 'degraded'
          ? 'ai_skipped_classification_degraded'
          : 'ai_skipped_no_relevant_direction';
        result = { ...this.aiScoringService.ruleBasedScoreArticle(art.title, art.content, tier, reason) };
        aiDegraded++;
        await this.db.transaction(async (tx) => {
          await tx.delete(directionScore).where(eq(directionScore.articleId, art.id));
          for (const dir of DIRECTIONS) {
            const ev = result.directionScores[dir];
            await tx.insert(directionScore).values({
              articleId: art.id, direction: dir,
              dimensionScores: ev?.dimensionScores ?? {},
              evidence: Object.values(ev?.evidenceByDimension ?? {}).flat(),
              totalScore: ev?.normalizedScore ?? 0,
            });
          }
          await tx.update(article).set({
            primaryDirection: null,
            primaryScore: result.publishScore,
            summary: result.summary,
            aiProcessed: false,
            aiDegradeReason: reason,
            status: traceFailIds.has(art.id) ? 'pending_review' : 'draft',
          }).where(eq(article.id, art.id));
        });
        continue;
      }

      if (aiCount < aiDailyLimit && srcUsed < aiPerSourceLimit
        && await this.reserveAiQuota(today, aiDailyLimit, art.feedSourceId, aiPerSourceLimit)) {
        // Reserve before invoking the provider so concurrent runners cannot overspend quota.
        aiCount++;
        perSourceCount.set(art.feedSourceId, srcUsed + 1);
        try {
          result = await this.aiScoringService.scoreArticle(
            art.title,
            art.content,
            tier,
            buildScoringInput(art.title, art.content),
          );
          if (result.aiProcessed) usedAi = true;
          else aiDegraded++;
        } catch (outerError: unknown) {
          const errType = outerError instanceof Error ? outerError.constructor.name : typeof outerError;
          const errMsg = outerError instanceof Error ? outerError.message : String(outerError);
          result = { ...this.aiScoringService.ruleBasedScoreArticle(art.title, art.content, tier, `[${errType}] ${errMsg}`) };
          aiDegraded++;
        }
      } else {
        const reason = aiCount >= aiDailyLimit ? 'ai_daily_limit_reached' : `per_source_limit_reached(${srcName}:${srcUsed}/${aiPerSourceLimit})`;
        result = { ...this.aiScoringService.ruleBasedScoreArticle(art.title, art.content, tier, reason) };
        aiDegraded++;
      }

      // A failed origin trace must remain reviewable even when scoring degrades.
      const articleStatus = traceFailIds.has(art.id)
        ? 'pending_review'
        : (!result.primaryDirection || !result.aiProcessed) ? 'draft' : undefined;
      await this.db.transaction(async (tx) => {
        await tx.delete(directionScore).where(eq(directionScore.articleId, art.id));
        for (const dir of DIRECTIONS) {
          const ev = result.directionScores[dir];
          await tx.insert(directionScore).values({
            articleId: art.id, direction: dir,
            dimensionScores: ev?.dimensionScores ?? {},
            evidence: Object.values(ev?.evidenceByDimension ?? {}).flat(),
            totalScore: ev?.normalizedScore ?? 0,
          });
        }
        await tx.update(article).set({
          primaryDirection: result.primaryDirection,
          primaryScore: result.publishScore,
          summary: result.summary,
          aiProcessed: result.aiProcessed,
          aiDegradeReason: result.degradeReason,
          ...(articleStatus ? { status: articleStatus } : {}),
        }).where(eq(article.id, art.id));
      });

      if (usedAi) {
        aiUsed++;
      }
    }
    this.logger.log(`[10/12] ai_score: ai=${aiUsed}/${aiDailyLimit}, degraded=${aiDegraded}`);

    // Rescore pending with shared counters (fix #5, #6)
    const rescoreResult = await this.rescorePending({
      aiCount,
      perSourceCount,
      today,
      excludeIds: new Set([
        ...allNewArticles.map((art) => art.id),
        ...filterExcludedIds,
      ]),
    });
    this.logger.log(`Rescore pre-gate: ${rescoreResult.succeeded} ok, ${rescoreResult.failed} fail`);

    // ── Stage 11/12: quality_gate ──
    const publishThreshold = await this.getBoundedConfig('publish_threshold', 75, 0, 100);
    const minSuccessRate = await this.getBoundedConfig('source_min_success_rate', 30, 0, 100);
    const maxConsecFail = await this.getBoundedConfig('source_max_consecutive_failures', 5, 0, 1000);
    const autoApproveHours = await this.getBoundedConfig('auto_approve_hours', 24, 1, 24 * 30);
    const autoApproveThreshold = await this.getBoundedConfig('auto_approve_threshold', 60, 0, 100);

    const autoApproved = await this.db.execute(sql`
      UPDATE article SET status = 'draft'
      WHERE status = 'pending_review'
        AND collected_at < NOW() - (${autoApproveHours} || ' hours')::interval
        AND primary_direction IS NOT NULL
        AND (primary_score IS NOT NULL AND primary_score >= ${autoApproveThreshold})
        AND NOT EXISTS (
          SELECT 1 FROM review_item ri
          WHERE ri.article_id = article.id AND ri.status = 'pending'
        )
      RETURNING id
    `);
    const autoApprovedRows = autoApproved as unknown as { id: string }[];
    const autoApprovedIds = new Set(autoApprovedRows.map((r) => r.id));
    if (autoApprovedRows.length > 0) {
      this.logger.log(`Auto-approved ${autoApprovedRows.length} stuck pending_review`);
    }

    // Union: new articles + rescored + auto-approved (fix #6)
    const allArticleIdsSet = new Set<string>(allNewArticles.map((a) => a.id));
    for (const id of rescoreResult.rescoredIds) allArticleIdsSet.add(id);
    for (const id of autoApprovedIds) allArticleIdsSet.add(id);
    // Revalidate a bounded slice of already-published content on every run so a
    // dead source cannot remain on the front page forever.
    const publishedForRevalidation = await this.db
      .select({ id: article.id })
      .from(article)
      .where(eq(article.status, 'published'))
      .orderBy(sql`${article.updatedAt} ASC`)
      .limit(200);
    for (const row of publishedForRevalidation) allArticleIdsSet.add(row.id);
    const allArticleIds = [...allArticleIdsSet];

    let gateStale = 0, gateUnreliable = 0, gateDead = 0;
    const blockedAtGateIds = new Set<string>();
    const articlesForGate = await this.db
      .select({ id: article.id, title: article.title, url: article.url, status: article.status, publishedAt: article.publishedAt, feedSourceId: article.feedSourceId })
      .from(article).where(inArray(article.id, allArticleIds));
    const gateArticleMap = new Map(allNewArticles.map((a) => [a.id, a]));

    for (const artRow of articlesForGate) {
      const inNew = gateArticleMap.has(artRow.id);
      const inRescore = rescoreResult.rescoredIds.has(artRow.id);
      const inAutoApprove = autoApprovedIds.has(artRow.id);
      const inPublishedRevalidation = publishedForRevalidation.some((row) => row.id === artRow.id);
      if (!inNew && !inRescore && !inAutoApprove && !inPublishedRevalidation) continue;

      try {

      const checkUrl = await this.getFinalUrl(artRow.id);
      let blocked = false, blockReason = '', blockDetail = '';

      // Staleness applies to already-published revalidation only. A newly
      // collected item may legitimately reference an older announcement.
      if (inPublishedRevalidation && artRow.publishedAt) {
        const pubTime = artRow.publishedAt instanceof Date ? artRow.publishedAt.getTime() : new Date(artRow.publishedAt).getTime();
        if (pubTime < Date.now() - STALE_DAYS * 24 * 60 * 60 * 1000) {
          blocked = true; blockReason = 'content_stale';
          blockDetail = `Published > ${STALE_DAYS} days ago`; gateStale++;
        }
      }
      if (!blocked) {
        const [src] = await this.db
          .select({ totalFetches: feedSource.totalFetches, successFetches: feedSource.successFetches, consecutiveFailures: feedSource.consecutiveFailures })
          .from(feedSource).where(eq(feedSource.id, artRow.feedSourceId));
        if (src && src.totalFetches >= 3) {
          const rate = Math.round((src.successFetches / src.totalFetches) * 100);
          // Historical success rate should not reject a fresh article. Keep
          // the hard consecutive-failure circuit breaker for actively broken
          // sources, while allowing current content through link/quality gates.
          if (src.consecutiveFailures >= maxConsecFail) {
            blocked = true; blockReason = 'source_unreliable';
            blockDetail = `Rate ${rate}%, consec fail ${src.consecutiveFailures}`; gateUnreliable++;
          }
        }
      }
      if (!blocked) {
        const alive = await this.checkLinkAlive(checkUrl);
        if (alive.state !== 'alive') {
          blocked = true;
          blockReason = alive.state === 'dead' ? 'link_dead' : 'link_probe_review';
          blockDetail = alive.detail;
          gateDead++;
        }
      }
        if (blocked) {
          await this.blockArticle(artRow.id, blockReason, blockDetail);
          blockedAtGateIds.add(artRow.id);
        }
      } catch (error: unknown) {
        const detail = `quality_gate_exception: ${error instanceof Error ? error.message : String(error)}`;
        this.logger.error(`Quality gate failed for ${artRow.id}: ${detail}`);
        try { await this.blockArticle(artRow.id, 'gate_error', detail); } catch { /* isolate one broken row */ }
        blockedAtGateIds.add(artRow.id);
      }
    }

    const dedupPassed = await this.checkDuplicateGates(allNewArticles);
    const gateDup = allNewArticles.length - dedupPassed.length;
    const gatePassedIds = new Set(dedupPassed.map((art) => art.id));
    for (const id of allArticleIds) {
      if (!gateArticleMap.has(id) && !blockedAtGateIds.has(id)) gatePassedIds.add(id);
    }
    this.logger.log(`[11/12] quality_gate: passed=${gatePassedIds.size}, stale=${gateStale}, unreliable=${gateUnreliable}, dead=${gateDead}, dup=${gateDup}`);

    // ── Stage 12/12: publish_outputs ──
    const publishedCount = await this.executePublishGate([...gatePassedIds].map((id) => ({ id })), publishThreshold);
    await this.selectForFrontPage();
    await this.ensureDigest(today);
    this.logger.log(`[12/12] publish_outputs: published=${publishedCount}, digest=ensured (threshold=${publishThreshold})`);
    this.logger.log('Pipeline completed successfully');
  }

  // ─── Origin Tracing ───────────────────────────────────────

  private async traceOrigin(art: PipelineArticle): Promise<boolean> {
    try {
      const result = await traceOriginFromContent(art.url, art.rawContent, art.sourceUrl);
      if (result.status === 'verified_reference' && result.originalUrl) {
        await this.db.update(article).set({
          originalUrl: result.originalUrl,
          originStatus: 'verified_reference',
          originEvidence: `候选来源(${result.candidate?.type || 'unknown'}): ${result.reason}`,
          originConfidence: 70,
        }).where(eq(article.id, art.id));
        this.logger.log(`Traced "${art.title}" -> ${result.originalUrl}`);
        return true;
      }
      this.logger.warn(`Origin trace requires review for "${art.title}": ${result.reason}`);
      await this.db.update(article).set({
        originStatus: 'needs_review',
        originEvidence: `trace failed closed: ${result.reason}`,
        originConfidence: null,
      }).where(eq(article.id, art.id));
      return false;
    } catch (error: unknown) {
      this.logger.warn(`Origin tracing error for "${art.title}": ${error instanceof Error ? error.message : String(error)}`);
      await this.db.update(article).set({
        originStatus: 'needs_review',
        originEvidence: `trace exception: ${error instanceof Error ? error.message : String(error)}`,
        originConfidence: null,
      }).where(eq(article.id, art.id));
      return false;
    }
  }
  private async createReviewItem(articleId: string): Promise<void> {
    await this.db.insert(reviewItem).values({ articleId, status: 'pending' });
  }

  // ─── Duplicate Gates ──────────────────────────────────────

  private async checkDuplicateGates(articles: PipelineArticle[]): Promise<PipelineArticle[]> {
    if (articles.length === 0) return [];
    const blockedIds = new Set<string>();
    const recentArticles = await this.db
      .select({ id: article.id, title: article.title, url: article.url, dedupUrl: article.dedupUrl })
      .from(article).where(sql`${article.collectedAt} > NOW() - INTERVAL '30 days'`);
    const dbUrlMap = new Map<string, string>();
    const dbTitleMap = new Map<string, string>();
    for (const recent of recentArticles) {
      const nUrl = canonicalizeDedupUrl(recent.dedupUrl || recent.url);
      const nTitle = normalizeTitle(recent.title);
      if (!dbUrlMap.has(nUrl)) dbUrlMap.set(nUrl, recent.id);
      if (!dbTitleMap.has(nTitle)) dbTitleMap.set(nTitle, recent.id);
    }
    for (const art of articles) {
      if (blockedIds.has(art.id)) continue;
      const nUrl = art.dedupUrl;
      const nTitle = normalizeTitle(art.title);
      const dupUrlId = dbUrlMap.get(nUrl);
      if (dupUrlId && dupUrlId !== art.id) { await this.blockArticle(art.id, 'same_url', `URL matches article ${dupUrlId}`); blockedIds.add(art.id); continue; }
      const dupTitleId = dbTitleMap.get(nTitle);
      if (dupTitleId && dupTitleId !== art.id) { await this.blockArticle(art.id, 'same_title', `Title matches article ${dupTitleId}`); blockedIds.add(art.id); continue; }
    }
    const batchUrlMap = new Map<string, string>();
    const batchTitleMap = new Map<string, string>();
    for (const art of articles) {
      if (blockedIds.has(art.id)) continue;
      const nUrl = art.dedupUrl;
      const nTitle = normalizeTitle(art.title);
      const existUrl = batchUrlMap.get(nUrl);
      if (existUrl) { await this.blockArticle(art.id, 'same_batch_url', `Batch URL matches ${existUrl}`); blockedIds.add(art.id); continue; }
      batchUrlMap.set(nUrl, art.id);
      const existTitle = batchTitleMap.get(nTitle);
      if (existTitle) { await this.blockArticle(art.id, 'same_batch_title', `Batch title matches ${existTitle}`); blockedIds.add(art.id); continue; }
      batchTitleMap.set(nTitle, art.id);
    }
    return articles.filter((a) => !blockedIds.has(a.id));
  }

  private async getFinalUrl(articleId: string): Promise<string> {
    const [row] = await this.db.select({ url: article.url, originalUrl: article.originalUrl }).from(article).where(eq(article.id, articleId));
    if (!row) return '';
    return row.originalUrl || row.url;
  }

  private async checkLinkAlive(url: string): Promise<{ state: 'alive' | 'dead' | 'needs_review'; detail: string }> {
    if (!url) return { state: 'needs_review', detail: 'probe_invalid_url: empty' };
    const result = await probeSafeLink(url);
    if (result.state === 'alive' && result.status !== null && result.status >= 300 && result.status < 400) {
      return { state: 'needs_review', detail: `probe_redirect_anomaly:${result.status}` };
    }
    return { state: result.state, detail: result.detail };
  }

  private async blockArticle(articleId: string, reason: string, detail: string): Promise<void> {
    // The same active block is idempotent across retries and concurrent runners.
    await this.db.execute(sql`
      INSERT INTO quality_gate (article_id, reason, detail)
      VALUES (${articleId}::uuid, ${reason}, ${detail})
      ON CONFLICT (article_id, reason) DO UPDATE SET detail = EXCLUDED.detail, blocked_at = CURRENT_TIMESTAMP
    `);
    await this.db.update(article).set({ status: 'blocked' }).where(eq(article.id, articleId));
  }

  // ─── Event Clustering ─────────────────────────────────────
  private async clusterArticles(articles: PipelineArticle[]): Promise<{
    groups: number;
    comparisons: number;
    degraded: boolean;
  }> {
    if (articles.length === 0) return { groups: 0, comparisons: 0, degraded: false };

    let history: Array<{ id: string; title: string; url: string; clusterId: string | null }> = [];
    let degraded = false;
    try {
      history = await this.db
        .select({ id: article.id, title: article.title, url: article.url, clusterId: article.clusterId })
        .from(article)
        .where(and(
          isNotNull(article.clusterId),
          sql`COALESCE(${article.publishedAt}, ${article.collectedAt}) > NOW() - INTERVAL '${sql.raw(String(CLUSTER_WINDOW_HOURS))} hours'`,
        ))
        .limit(MAX_CLUSTER_HISTORY_ARTICLES);
    } catch (error: unknown) {
      // Cluster enrichment must never prevent scoring and publishing; a later run
      // can attach this batch once the database is available again.
      degraded = true;
      this.logger.error(`Cluster history query failed; using batch-only clustering: ${error instanceof Error ? error.message : String(error)}`);
    }

    const plan = planEventClusters([
      ...history.map((row) => ({ id: row.id, title: row.title, url: row.url, clusterId: row.clusterId, isNew: false })),
      ...articles.map((item) => ({ id: item.id, title: item.title, url: item.url, isNew: true })),
    ]);
    if (plan.comparisonBudgetExhausted) {
      degraded = true;
      this.logger.warn(`Cluster comparison budget reached after ${plan.comparisons} comparisons; remaining articles stay unclustered`);
    }

    try {
      for (const group of plan.groups) {
        const newIds = group.itemIds.filter((id) => articles.some((item) => item.id === id));
        if (newIds.length === 0) continue;
        await this.db.update(article).set({ clusterId: group.clusterId }).where(inArray(article.id, newIds));
      }
    } catch (error: unknown) {
      degraded = true;
      this.logger.error(`Cluster assignment failed; continuing pipeline: ${error instanceof Error ? error.message : String(error)}`);
    }
    return { groups: plan.groups.length, comparisons: plan.comparisons, degraded };
  }

  // ─── Front Page Diversity Selection ───────────────────────

  async selectForFrontPage(): Promise<void> {
    const limit = await this.getConfig('daily_front_page_limit', 20);
    const sourceCap = Math.max(2, Math.ceil(limit / 5));
    const directionCap = Math.max(2, Math.ceil(limit / 2));
    const DIRECTION_ORDER = ['model', 'agent', 'multimodal', 'coding', 'infrastructure', 'data_eval', 'safety_governance', 'applications', 'business_ecosystem'];
    const publishThreshold = await this.getConfig('publish_threshold', 75);
    const candidatesResult = await this.db.execute(sql`
      SELECT a.id, a.source_name, a.feed_source_id, a.cluster_id, a.primary_direction, a.primary_score,
             a.published_at, a.collected_at, fs.tier AS source_tier
      FROM article a
      LEFT JOIN feed_source fs ON fs.id = a.feed_source_id
      WHERE a.status = 'published' AND a.primary_score >= ${publishThreshold}
        AND (
          coalesce(a.published_at, a.collected_at) AT TIME ZONE 'Asia/Shanghai'
        )::date = (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Shanghai')::date
      ORDER BY a.primary_score DESC, coalesce(a.published_at, a.collected_at) DESC
    `);
    interface CandidateRow {
      id: string; source_name: string; feed_source_id: string | null; cluster_id: string | null;
      primary_direction: string | null; primary_score: number | null; published_at: Date | null;
      collected_at: Date; source_tier: string | null;
    }
    const rows = candidatesResult as unknown as CandidateRow[];
    const validRows = rows.filter((row) => normalizeDirection(row.primary_direction) !== null);
    const invalidRows = rows.filter((row) => normalizeDirection(row.primary_direction) === null);

    // One representative per event cluster. Cluster history is already attached to
    // rows by the clustering stage, so this also deduplicates across batches.
    const tierRank: Record<string, number> = { primary: 3, official: 3, secondary: 2, signal: 1 };
    const effectiveTime = (row: CandidateRow): number => {
      const value = row.published_at || row.collected_at;
      return value ? new Date(value).getTime() : 0;
    };
    const better = (left: CandidateRow, right: CandidateRow): CandidateRow => {
      const score = (left.primary_score ?? 0) - (right.primary_score ?? 0);
      if (score !== 0) return score > 0 ? left : right;
      const tier = (tierRank[left.source_tier || ''] || 0) - (tierRank[right.source_tier || ''] || 0);
      if (tier !== 0) return tier > 0 ? left : right;
      return effectiveTime(left) >= effectiveTime(right) ? left : right;
    };
    const representativeByCluster = new Map<string, CandidateRow>();
    for (const row of validRows) {
      const key = row.cluster_id || `article:${row.id}`;
      const existing = representativeByCluster.get(key);
      if (!existing) representativeByCluster.set(key, row);
      else representativeByCluster.set(key, better(existing, row));
    }
    const representatives = [...representativeByCluster.values()];
    const byDirection = new Map<string, CandidateRow[]>();
    for (const c of representatives) {
      const dir = normalizeDirection(c.primary_direction)!;
      if (!byDirection.has(dir)) byDirection.set(dir, []);
      byDirection.get(dir)!.push(c);
    }
    const selected: CandidateRow[] = [];
    const sourceCounts = new Map<string, number>();
    const directionCounts = new Map<string, number>();
    let changed = true;
    while (selected.length < limit && changed) {
      changed = false;
      for (const dir of DIRECTION_ORDER) {
        if (selected.length >= limit) break;
        const queue = byDirection.get(dir) || [];
        let picked = false;
        while (queue.length > 0 && !picked) {
          const c = queue.shift()!;
          const src = c.feed_source_id || 'unknown';
          if ((sourceCounts.get(src) || 0) >= sourceCap) continue;
          if ((directionCounts.get(dir) || 0) >= directionCap) break;
          selected.push(c); sourceCounts.set(src, (sourceCounts.get(src) || 0) + 1); directionCounts.set(dir, (directionCounts.get(dir) || 0) + 1);
          changed = true; picked = true;
        }
      }
    }
    for (const c of representatives) {
      if (selected.length >= limit) break;
      if (selected.some((s: CandidateRow) => s.id === c.id)) continue;
      const src = c.feed_source_id || 'unknown';
      const dir = normalizeDirection(c.primary_direction)!;
      if ((sourceCounts.get(src) || 0) >= sourceCap) continue;
      if ((directionCounts.get(dir) || 0) >= directionCap) continue;
      selected.push(c); sourceCounts.set(src, (sourceCounts.get(src) || 0) + 1); directionCounts.set(dir, (directionCounts.get(dir) || 0) + 1);
    }

    const selectedIds = new Set(selected.map((s) => s.id));
    const updates = representatives.map((c) => {
      if (selectedIds.has(c.id)) return { id: c.id, rank: 100 + selected.findIndex((s) => s.id === c.id), reason: null };
      const src = c.feed_source_id || 'unknown';
      const dir = normalizeDirection(c.primary_direction)!;
      const reason = (sourceCounts.get(src) || 0) >= sourceCap
        ? 'source_cap'
        : (directionCounts.get(dir) || 0) >= directionCap ? 'direction_cap' : 'limit_reached';
      return { id: c.id, rank: null, reason };
    });
    updates.push(...invalidRows.map((c) => ({ id: c.id, rank: null, reason: 'invalid_direction' })));

    // Reset and write the new version atomically; if any write fails, the previous
    // front-page selection remains intact.
    await this.db.transaction(async (tx) => {
      await tx.execute(sql`UPDATE article SET front_page_rank = NULL, exclude_reason = NULL WHERE front_page_rank IS NOT NULL OR exclude_reason IS NOT NULL`);
      for (const update of updates) {
        await tx.execute(sql`UPDATE article SET front_page_rank = ${update.rank}, exclude_reason = ${update.reason} WHERE id = ${update.id}`);
      }
    });
    this.logger.log(`Front page: selected ${selected.length}/${representatives.length} cluster representatives`);
  }

  // ─── Rescore Pending ──────────────────────────────────────

  async rescorePending(shared?: {
    aiCount: number;
    perSourceCount: Map<string, number>;
    today: string;
    excludeIds?: Set<string>;
  }): Promise<{ rescored: number; succeeded: number; failed: number; rescoredIds: Set<string> }> {
    const today = shared?.today ?? new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Shanghai',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date());
    const aiDailyLimit = await this.getConfig('ai_daily_limit', 500);
    const aiPerSourceLimit = await this.getConfig('ai_per_source_limit', 30);
    let aiCount: number;
    let perSourceCount: Map<string, number>;
    if (shared) {
      aiCount = shared.aiCount;
      perSourceCount = shared.perSourceCount;
    } else {
      aiCount = await this.getAiCallCount(today);
      perSourceCount = new Map<string, number>();
      const todayAi = await this.db.select({ feedSourceId: article.feedSourceId }).from(article)
        .where(and(eq(article.aiProcessed, true), sql`${article.collectedAt}::date = ${today}::date`));
      for (const row of todayAi) {
        if (row.feedSourceId) perSourceCount.set(row.feedSourceId, (perSourceCount.get(row.feedSourceId) || 0) + 1);
      }
    }

    const pendingArticles = await this.db
      .select({ id: article.id, title: article.title, sourceName: article.sourceName, feedSourceId: article.feedSourceId, scoringInput: article.scoringInput })
      .from(article)
      .where(and(
        eq(article.aiProcessed, false),
        // Backlog rescoring must not consume today's provider quota before
        // current-day articles have a chance to become publishable.
        sql`(${article.collectedAt} AT TIME ZONE 'Asia/Shanghai')::date = ${today}::date`,
      ));
    this.logger.log(`Rescore pending: ${pendingArticles.length} articles, ai=${aiCount}/${aiDailyLimit}`);

    const sourceTiers = new Map<string, string>();
    const allSources = await this.db.select().from(feedSource);
    for (const s of allSources) sourceTiers.set(s.id, s.tier);

    let rescored = 0, succeeded = 0, failed = 0;
    const rescoredIds = new Set<string>();
    for (const art of pendingArticles) {
      if (shared?.excludeIds?.has(art.id)) continue;
      const tier = sourceTiers.get(art.feedSourceId) ?? 'signal';
      const [fullArt] = await this.db.select().from(article).where(eq(article.id, art.id));
      if (!fullArt) continue;
      const scoringInput = fullArt.scoringInput;
      if (!scoringInput || scoringInput.trim().length < 12) {
        await this.db.update(article).set({
          aiProcessed: false,
          aiDegradeReason: 'missing_immutable_scoring_input',
        }).where(eq(article.id, art.id));
        failed++;
        continue;
      }

      // Rebuild the auditable rule fallback even when the AI quota or source
      // quota is exhausted. Existing drafts otherwise remain permanently
      // invisible because the next publish gate sees empty evidence rows.
      const srcUsed = perSourceCount.get(art.feedSourceId) || 0;
      if (srcUsed >= aiPerSourceLimit) {
        const ruleResult = this.aiScoringService.ruleBasedScoreArticle(
          art.title,
          scoringInput,
          tier,
          `per_source_limit_reached(${art.sourceName}:${srcUsed}/${aiPerSourceLimit})`,
        );
        await this.persistRuleFallback(art.id, ruleResult);
        rescored++;
        rescoredIds.add(art.id);
        continue;
      }
      if (!await this.reserveAiQuota(today, aiDailyLimit, art.feedSourceId, aiPerSourceLimit)) {
        const ruleResult = this.aiScoringService.ruleBasedScoreArticle(
          art.title,
          scoringInput,
          tier,
          'ai_daily_limit_reached',
        );
        await this.persistRuleFallback(art.id, ruleResult);
        rescored++;
        rescoredIds.add(art.id);
        continue;
      }
      aiCount++;
      perSourceCount.set(art.feedSourceId, srcUsed + 1);
      try {
        const result = await this.aiScoringService.scoreArticle(
          art.title,
          scoringInput,
          tier,
          scoringInput,
        );
        if (!result.aiProcessed) {
          const fallback = this.aiScoringService.ruleBasedScoreArticle(
            art.title,
            scoringInput,
            tier,
            result.degradeReason || 'ai_scoring_degraded',
          );
          await this.persistRuleFallback(art.id, fallback);
          failed++;
          rescored++;
          rescoredIds.add(art.id);
          continue;
        }
        // Keep the nine direction rows and article metadata atomic. A failed
        // insert/update leaves the previous scores intact and remains retryable.
        await this.db.transaction(async (tx) => {
          await tx.delete(directionScore).where(eq(directionScore.articleId, art.id));
          for (const dir of DIRECTIONS) {
            const ev = result.directionScores[dir];
            await tx.insert(directionScore).values({
              articleId: art.id, direction: dir,
              dimensionScores: ev?.dimensionScores ?? {},
              evidence: Object.values(ev?.evidenceByDimension ?? {}).flat(),
              totalScore: ev?.normalizedScore ?? 0,
            });
          }
          await tx.update(article).set({
            primaryDirection: result.primaryDirection,
            primaryScore: result.publishScore,
            summary: result.summary,
            aiProcessed: true,
            aiDegradeReason: null,
          }).where(eq(article.id, art.id));
        });
        rescored++;
        succeeded++;
        rescoredIds.add(art.id);
      } catch (error: unknown) {
        const errMsg = error instanceof Error ? error.message : String(error);
        this.logger.error(`Rescore failed for "${art.title}": ${errMsg}`);
        const fallback = this.aiScoringService.ruleBasedScoreArticle(
          art.title,
          scoringInput,
          tier,
          `rescore_failed: ${errMsg}`,
        );
        await this.persistRuleFallback(art.id, fallback);
        failed++;
        rescored++;
        rescoredIds.add(art.id);
      }
    }
    if (shared) shared.aiCount = aiCount;
    this.logger.log(`Rescore: ${rescored} rescored, ${succeeded} ok, ${failed} fail`);
    return { rescored, succeeded, failed, rescoredIds };
  }

  private async persistRuleFallback(
    articleId: string,
    result: ReturnType<AiScoringService['ruleBasedScoreArticle']>,
  ): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx.delete(directionScore).where(eq(directionScore.articleId, articleId));
      for (const dir of DIRECTIONS) {
        const ev = result.directionScores[dir];
        await tx.insert(directionScore).values({
          articleId,
          direction: dir,
          dimensionScores: ev?.dimensionScores ?? {},
          evidence: Object.values(ev?.evidenceByDimension ?? {}).flat(),
          totalScore: ev?.normalizedScore ?? 0,
        });
      }
      await tx.update(article).set({
        primaryDirection: result.primaryDirection,
        primaryScore: result.publishScore,
        summary: result.summary,
        aiProcessed: false,
        aiDegradeReason: result.degradeReason,
      }).where(eq(article.id, articleId));
    });
  }

  // ─── Publish Gate ─────────────────────────────────────────

  private async executePublishGate(articles: { id: string }[], publishThreshold: number): Promise<number> {
    if (articles.length === 0) return 0;
    const articleIds = articles.map((a) => a.id);
    const allArticles = await this.db
      .select({
        id: article.id,
        primaryDirection: article.primaryDirection,
        primaryScore: article.primaryScore,
        status: article.status,
        originStatus: article.originStatus,
        provenanceOverride: article.provenanceOverride,
        aiProcessed: article.aiProcessed,
      })
      .from(article).where(inArray(article.id, articleIds));
    // Built with the query builder on purpose: the hand-written variant expanded the
    // id list into `ANY($1, $2, ...::uuid[])`, which is not valid Postgres and made the
    // publish gate throw on every run with more than one article.
    const primaryDirScores = await this.db
      .select({
        articleId: directionScore.articleId,
        dimensionScores: directionScore.dimensionScores,
        evidence: directionScore.evidence,
      })
      .from(directionScore)
      .innerJoin(
        article,
        and(
          eq(directionScore.articleId, article.id),
          eq(directionScore.direction, article.primaryDirection),
        ),
      )
      .where(inArray(directionScore.articleId, articleIds));
    const scoreMap = new Map<string, {
      dimensionScores: Record<string, number>;
      evidence: ScoreEvidence[];
    }>();
    for (const row of primaryDirScores) {
      scoreMap.set(
        row.articleId,
        {
          dimensionScores: (row.dimensionScores as Record<string, number> | null) ?? {},
          evidence: Array.isArray(row.evidence) ? row.evidence as ScoreEvidence[] : [],
        },
      );
    }
    let publishedCount = 0;
    for (const art of allArticles) {
      const passes = canPublishArticle({
        primaryDirection: art.primaryDirection, primaryScore: art.primaryScore,
        status: art.status,
        dimensionScores: scoreMap.get(art.id)?.dimensionScores ?? null,
        evidence: scoreMap.get(art.id)?.evidence ?? null,
        publishThreshold,
        aiProcessed: art.aiProcessed,
        traceStatus: art.originStatus as 'first_party' | 'editorial' | 'verified_reference' | 'aggregator' | 'needs_review' | 'unknown' | null,
        provenanceOverride: art.provenanceOverride === true,
      });
      if (passes && art.status !== 'published') {
        await this.db.update(article).set({ status: 'published' }).where(eq(article.id, art.id));
        publishedCount++;
      } else if (!passes) {
        const updates: Record<string, unknown> = { frontPageRank: null };
        if (art.status === 'published' && art.primaryDirection !== null) updates.status = 'draft';
        await this.db.update(article).set(updates).where(eq(article.id, art.id));
      }
    }
    return publishedCount;
  }

  // ─── Config Helpers ───────────────────────────────────────

  private async getConfig(key: string, defaultValue: number): Promise<number> {
    const [config] = await this.db.select().from(appConfig).where(eq(appConfig.key, key));
    if (!config) return defaultValue;
    const value = typeof config.value === 'number'
      ? config.value
      : Number(String(config.value));
    return Number.isFinite(value) ? value : defaultValue;
  }
  private async getBoundedConfig(key: string, defaultValue: number, min: number, max: number): Promise<number> {
    const value = await this.getConfig(key, defaultValue);
    if (!Number.isFinite(value) || value < min || value > max) {
      this.logger.warn(`Invalid config ${key}=${String(value)}; using ${defaultValue}`);
      return defaultValue;
    }
    return Math.floor(value);
  }
  private async getAiCallCount(today: string): Promise<number> {
    const [config] = await this.db.select().from(appConfig).where(eq(appConfig.key, `ai_daily_count_${today}`));
    if (!config) return 0;
    return typeof config.value === 'number' ? config.value : parseInt(String(config.value), 10) || 0;
  }
  /** Atomically reserve a call before invoking the provider. Failed calls consume quota too. */
  private async reserveAiCall(today: string, limit: number): Promise<boolean> {
    const key = `ai_daily_count_${today}`;
    const rows = await this.db.execute(sql`
      INSERT INTO app_config (key, value, description)
      SELECT ${key}, '1'::jsonb, ${`AI calls on ${today}`}
      WHERE ${limit} > 0
      ON CONFLICT (key) DO UPDATE
        SET value = to_jsonb(COALESCE((app_config.value #>> '{}')::integer, 0) + 1)
        WHERE COALESCE((app_config.value #>> '{}')::integer, 0) < ${limit}
      RETURNING value
    `);
    return (rows as unknown as unknown[]).length > 0;
  }

  /** Atomically reserve both the global daily and feed-source budgets. */
  private async reserveAiQuota(
    today: string,
    dailyLimit: number,
    feedSourceId: string,
    sourceLimit: number,
  ): Promise<boolean> {
    if (dailyLimit <= 0 || sourceLimit <= 0) return false;
    const dailyKey = `ai_daily_count_${today}`;
    const sourceKey = `ai_source_count_${today}_${feedSourceId}`;
    const quotaRejected = new Error('ai_quota_rejected');
    try {
      await this.db.transaction(async (tx) => {
        const dailyRows = await tx.execute(sql`
          INSERT INTO app_config (key, value, description)
          VALUES (${dailyKey}, '1'::jsonb, ${`AI calls on ${today}`})
          ON CONFLICT (key) DO UPDATE
            SET value = to_jsonb(COALESCE((app_config.value #>> '{}')::integer, 0) + 1)
            WHERE COALESCE((app_config.value #>> '{}')::integer, 0) < ${dailyLimit}
          RETURNING value
        `);
        if ((dailyRows as unknown as unknown[]).length === 0) throw quotaRejected;

        const sourceRows = await tx.execute(sql`
          INSERT INTO app_config (key, value, description)
          VALUES (${sourceKey}, '1'::jsonb, ${`AI calls for source ${feedSourceId} on ${today}`})
          ON CONFLICT (key) DO UPDATE
            SET value = to_jsonb(COALESCE((app_config.value #>> '{}')::integer, 0) + 1)
            WHERE COALESCE((app_config.value #>> '{}')::integer, 0) < ${sourceLimit}
          RETURNING value
        `);
        if ((sourceRows as unknown as unknown[]).length === 0) throw quotaRejected;
      });
      return true;
    } catch (error: unknown) {
      if (error === quotaRejected || (error instanceof Error && error.message === quotaRejected.message)) return false;
      throw error;
    }
  }

  private async ensureDigest(today: string): Promise<void> {
    try {
      const digest = await this.digestService.generateDigest(today);
      this.logger.log(`Digest generated/refreshed for ${today}: ${digest.articleCount} items`);
    } catch (error: unknown) {
      const errMsg = error instanceof Error ? error.message : String(error);
      this.logger.error(`Failed to generate digest: ${errMsg}`);
    }
  }

  private async processBatch<T>(items: T[], batchSize: number, fn: (item: T) => Promise<void>): Promise<void> {
    if (items.length === 0) return;
    const workerCount = Math.min(Math.max(1, Math.floor(batchSize)), items.length);
    let nextIndex = 0;
    const errors: unknown[] = [];
    const worker = async (): Promise<void> => {
      while (true) {
        const index = nextIndex++;
        if (index >= items.length) return;
        try {
          await fn(items[index]);
        } catch (error: unknown) {
          errors.push(error);
        }
      }
    };
    await Promise.all(Array.from({ length: workerCount }, () => worker()));
    if (errors.length > 0) throw errors[0];
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
