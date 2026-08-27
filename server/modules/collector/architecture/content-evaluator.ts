export type EvaluationDimension = 'relevance' | 'novelty' | 'credibility' | 'impact' | 'verifiability';

export type EvaluationReviewReason =
  | 'missing_filter_result' | 'filter_snapshot_mismatch' | 'filter_rejected'
  | 'filter_requires_review' | 'stale_content' | 'insufficient_evidence'
  | 'negated_claim' | 'rumor_or_hearsay' | 'future_or_planned'
  | 'marketing_language' | 'low_relevance' | 'low_credibility'
  | 'low_verifiability' | 'low_overall';

export interface EvaluationSourceSnapshot {
  articleId: string;
  title: string;
  content: string;
  url: string;
  sourceName: string | null;
  sourceTier: string | null;
  sourceCategoryId: string | null;
  publishedAt: string | null;
}

export interface EvaluationFilterOutput {
  decision: 'candidate' | 'reject' | 'review';
  reasonCode: string;
  aiSignals: string[];
  normalizedTitle: string;
  normalizedContent: string;
  sourceUrl: string;
}

export interface EvaluationEvidence {
  dimension: EvaluationDimension;
  quote: string;
  span: { start: number; end: number };
  sourceField: 'title' | 'content';
  source: string;
  sourceName: string | null;
  date: string | null;
}

export interface ContentEvaluationOutput {
  dimensions: Record<EvaluationDimension, number>;
  overall: number;
  score: number;
  decision: 'pass' | 'review' | 'reject';
  publishEligible: boolean;
  reviewReasons: EvaluationReviewReason[];
  evidence: EvaluationEvidence[];
}

export interface ContentEvaluationComputation {
  output: ContentEvaluationOutput;
  evidence: EvaluationEvidence[];
  diagnostics: Array<{ code: string; message: string; recoverable: boolean }>;
}

const DIMENSIONS: readonly EvaluationDimension[] = [
  'relevance', 'novelty', 'credibility', 'impact', 'verifiability',
];
const AI_SIGNAL = /\b(?:artificial intelligence|generative ai|machine learning|large language model|language model|foundation model|LLM|GPT|Claude|Gemini|Llama|Qwen|DeepSeek|Mistral|Gemma|Kimi|AI agents?|multimodal|model training|model inference|transformer)\b|人工智能|生成式\s*AI|机器学习|深度学习|大模型|语言模型|基础模型|智能体|多智能体|多模态|模型训练|模型推理|神经网络/i;
const NOVELTY = /\b(?:launch(?:es|ed)?|release[ds]?|introduc(?:e[ds]?|ing)|debut(?:s|ed)?|open[- ]?source[ds]?|new|novel|first)\b|发布|推出|上线|开源|首次|首个|新型|新方法/i;
const IMPACT = /\b(?:available|deploy(?:ed|ment)?|adopt(?:ed|ion)?|production|users?|customers?|developers?|api|benchmark|accuracy|performance|latency|throughput|funding|acquisition|regulation|policy)\b|可用|部署|落地|采用|用户|开发者|接口|基准|性能|准确率|延迟|吞吐|融资|收购|政策|监管/i;
const DETAIL = /\b\d+(?:\.\d+)?\s*(?:%|x|ms|s|seconds?|minutes?|hours?|days?|users?|tokens?|parameters?|billion|million|GB|TB)?\b|\b(?:benchmark|dataset|methodology|evaluation|results?|study|paper|report|api)\b|数据集|方法|评测|基准|结果|论文|报告|接口/i;
const NEGATION = /\b(?:not|no|never|cannot|can't|failed to|fails? to|did not|does not|won't|without)\b|并未|未能|没有|不会|无法|否认|失败|未达到/i;
const RUMOR = /\b(?:rumou?r|alleged(?:ly)?|unconfirmed|sources? say|people familiar|may have|could have)\b|传闻|据传|传言|消息人士|尚未证实|未经证实|或已|可能已/i;
const FUTURE = /\b(?:will|plans? to|aims? to|intends? to|expected to|upcoming|roadmap|would|could|may)\b|将于|将在|计划|拟于|预计划|有望|未来|将会|拟将/i;
const MARKETING = /\b(?:revolutionary|groundbreaking|game[- ]changing|world[- ]class|industry[- ]leading|best[- ]in[- ]class|unmatched|unparalleled|ultimate|most powerful)\b|革命性|颠覆性|全球领先|行业领先|遥遥领先|最强|震撼|重磅|划时代/i;

function match(pattern: RegExp, text: string): boolean {
  pattern.lastIndex = 0;
  return pattern.test(text);
}
function clamp(value: number): number {
  return Math.max(0, Math.min(20, Math.round(value)));
}
interface Excerpt { quote: string; sourceField: 'title' | 'content'; start: number; end: number; }
function excerpts(snapshot: EvaluationSourceSnapshot): Excerpt[] {
  const result: Excerpt[] = [];
  for (const [sourceField, source] of [['title', snapshot.title], ['content', snapshot.content]] as const) {
    const pattern = /[^\u3002\uFF01\uFF1F!?\n]+(?:[\u3002\uFF01\uFF1F!?]+|$)/g;
    let found: RegExpExecArray | null;
    while ((found = pattern.exec(source)) !== null) {
      const raw = found[0];
      const quote = raw.trim().slice(0, 320);
      if (!quote) continue;
      const start = found.index + raw.length - raw.trimStart().length;
      result.push({ quote, sourceField, start, end: start + quote.length });
    }
  }
  return result;
}
function pick(list: readonly Excerpt[], patterns: readonly RegExp[]): Excerpt | null {
  for (const pattern of patterns) {
    const selected = list.find((item) => match(pattern, item.quote));
    if (selected) return selected;
  }
  return list.find((item) => item.sourceField === 'content') || list[0] || null;
}
function credibility(snapshot: EvaluationSourceSnapshot): number {
  const tier = snapshot.sourceTier || '';
  let score = /authoritative|official|primary|validation|top|high|tier[\s_-]?[01]/i.test(tier)
    ? 17 : /unverified|unknown|low|tier[\s_-]?[34]/i.test(tier) ? 6 : 10;
  if (/^(?:research_papers|official_release|evaluation_data|policy_safety_governance)$/.test(snapshot.sourceCategoryId || '')) score += 1;
  if (snapshot.sourceName) score += 1;
  if (/^https:\/\//i.test(snapshot.url)) score += 1;
  if (snapshot.publishedAt && !Number.isNaN(new Date(snapshot.publishedAt).getTime())) score += 1;
  return clamp(score);
}

export function computeContentEvaluation(snapshot: EvaluationSourceSnapshot, filter?: EvaluationFilterOutput): ContentEvaluationComputation {
  const text = snapshot.title + '\n' + snapshot.content;
  const sourceExcerpts = excerpts(snapshot);
  const bodyExcerpts = sourceExcerpts.filter((item) => item.sourceField === 'content');
  const reasons: EvaluationReviewReason[] = [];
  const diagnostics: ContentEvaluationComputation['diagnostics'] = [];
  const addReason = (reason: EvaluationReviewReason) => { if (!reasons.includes(reason)) reasons.push(reason); };
  const hasNegation = match(NEGATION, text);
  const hasRumor = match(RUMOR, text);
  const hasFuture = match(FUTURE, text);
  const hasMarketing = match(MARKETING, text);
  const hasNovelty = match(NOVELTY, text);
  const hasImpact = match(IMPACT, text);
  const hasDetail = match(DETAIL, text);
  const normalize = (value: string) => value.normalize('NFKC').replace(/\s+/g, ' ').trim();
  const filterMatches = !!filter && filter.normalizedTitle === normalize(snapshot.title)
    && filter.normalizedContent === normalize(snapshot.content) && filter.sourceUrl === snapshot.url;
  if (!filter) addReason('missing_filter_result');
  else if (!filterMatches) addReason('filter_snapshot_mismatch');
  if (filter?.decision === 'reject') addReason('filter_rejected');
  if (filter?.decision === 'review') addReason('filter_requires_review');
  if (filter?.reasonCode === 'stale_content') addReason('stale_content');
  if (hasNegation) addReason('negated_claim');
  if (hasRumor) addReason('rumor_or_hearsay');
  if (hasFuture) addReason('future_or_planned');
  if (hasMarketing) addReason('marketing_language');

  const signalCount = filter?.aiSignals.length || (match(AI_SIGNAL, text) ? 1 : 0);
  let relevance = (filter?.decision === 'candidate' && filterMatches ? 14 : filter?.decision === 'review' ? 9 : 2) + Math.min(6, signalCount * 2);
  if (filter?.reasonCode === 'non_ai') relevance = 0;
  let novelty = hasNovelty ? 17 : filter?.decision === 'candidate' ? 9 : 4;
  if (filter?.reasonCode === 'stale_content') novelty = Math.min(novelty, 5);
  let impact = hasImpact ? 13 : 6;
  if (hasDetail) impact += 3;
  let cred = credibility(snapshot);
  let verifiability = 4 + (snapshot.sourceName ? 2 : 0) + (/^https:\/\//i.test(snapshot.url) ? 2 : 0);
  if (snapshot.publishedAt && !Number.isNaN(new Date(snapshot.publishedAt).getTime())) verifiability += 2;
  if (hasDetail) verifiability += 4;
  if (hasNovelty || hasImpact) verifiability += 3;
  if (bodyExcerpts.length >= 2) verifiability += 2;
  if (/authoritative|official|primary|validation|top|high|tier[\s_-]?[01]/i.test(snapshot.sourceTier || '')) verifiability += 2;
  const lower = (amount: number, dimension: 'novelty' | 'impact' | 'cred' | 'verifiability') => {
    if (dimension === 'novelty') novelty -= amount;
    if (dimension === 'impact') impact -= amount;
    if (dimension === 'cred') cred -= amount;
    if (dimension === 'verifiability') verifiability -= amount;
  };
  if (hasNegation) { lower(3, 'novelty'); lower(5, 'impact'); lower(2, 'verifiability'); }
  if (hasRumor) { lower(4, 'novelty'); lower(7, 'cred'); lower(4, 'impact'); lower(7, 'verifiability'); }
  if (hasFuture) { lower(4, 'novelty'); lower(5, 'impact'); lower(3, 'verifiability'); }
  if (hasMarketing) { lower(2, 'novelty'); lower(3, 'cred'); lower(3, 'impact'); lower(3, 'verifiability'); }
  // A single source sentence can still be auditable when it contains a
  // concrete metric/method; do not equate sentence count with evidence.
  const insufficient = snapshot.content.length < 80 || !hasDetail;
  if (insufficient) {
    addReason('insufficient_evidence');
    verifiability = Math.min(verifiability, 8);
    diagnostics.push({ code: 'insufficient_evidence', message: '原文缺少足够的可核验细节，内容评估降级为人工复核。', recoverable: true });
  }
  const dimensions: Record<EvaluationDimension, number> = {
    relevance: clamp(relevance), novelty: clamp(novelty), credibility: clamp(cred),
    impact: clamp(impact), verifiability: clamp(verifiability),
  };
  const overall = DIMENSIONS.reduce((sum, dimension) => sum + dimensions[dimension], 0);
  if (dimensions.relevance < 12) addReason('low_relevance');
  if (dimensions.credibility < 10) addReason('low_credibility');
  if (dimensions.verifiability < 12) addReason('low_verifiability');
  if (overall < 70) addReason('low_overall');
  const blocking = hasNegation || hasRumor || hasFuture || hasMarketing;
  const publishEligible = !!filter && filterMatches && filter.decision === 'candidate' && !insufficient && !blocking
    && overall >= 70 && dimensions.relevance >= 12 && dimensions.credibility >= 10 && dimensions.verifiability >= 12;
  const decision = publishEligible ? 'pass' : filter?.decision === 'reject' ? 'reject' : 'review';
  const selectors: Record<EvaluationDimension, readonly RegExp[]> = {
    relevance: [AI_SIGNAL], novelty: [NOVELTY], credibility: [DETAIL, NOVELTY],
    impact: [IMPACT, DETAIL], verifiability: [DETAIL, IMPACT],
  };
  const evaluationEvidence = DIMENSIONS.flatMap((dimension) => {
    const excerpt = pick(sourceExcerpts, selectors[dimension]);
    return excerpt ? [{ dimension, quote: excerpt.quote, span: { start: excerpt.start, end: excerpt.end },
      sourceField: excerpt.sourceField, source: snapshot.url, sourceName: snapshot.sourceName, date: snapshot.publishedAt }] : [];
  });
  return { output: { dimensions, overall, score: overall, decision, publishEligible, reviewReasons: reasons, evidence: evaluationEvidence },
    evidence: evaluationEvidence, diagnostics };
}
