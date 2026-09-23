import * as crypto from 'crypto';

export const CLUSTER_WINDOW_HOURS = 72;
export const MAX_CLUSTER_HISTORY_ARTICLES = 1_200;
const MAX_CLUSTER_CANDIDATES_PER_ARTICLE = 80;
const MAX_CLUSTER_CANDIDATE_BUCKET = 50;
const MAX_CLUSTER_COMPARISONS = 20_000;

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
