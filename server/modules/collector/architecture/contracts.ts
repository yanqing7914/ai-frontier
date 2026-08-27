import * as crypto from 'crypto';
import { computeContentEvaluation } from './content-evaluator';
import type { ContentEvaluationOutput as EvaluatorContentEvaluationOutput, EvaluationFilterOutput, EvaluationSourceSnapshot } from './content-evaluator';
export type { EvaluationDimension, EvaluationEvidence, EvaluationReviewReason } from './content-evaluator';

/** The twelve observable stages are intentionally duplicated as a local type.
 * Keeping this module dependency-free prevents a contract import from pulling
 * the Nest collector (and its database side effects) into pure unit tests.
 */
export const CONTRACT_PIPELINE_STAGES = [
  'source_ingest', 'scheduled_fetch', 'parse', 'normalize', 'url_dedup', 'trace',
  'classify', 'cluster', 'rule_score', 'ai_score', 'quality_gate', 'publish_outputs',
] as const;

export type ContractPipelineStage = typeof CONTRACT_PIPELINE_STAGES[number];

export const POST_PROCESSING_ROLES = [
  'content_filter',
  'content_evaluator',
  'chinese_processor',
  'body_organizer',
  'event_recognizer',
  'semantic_clusterer',
  'event_reviewer',
  'featured_explainer',
] as const;

export type PostProcessingRole = typeof POST_PROCESSING_ROLES[number];
export type ContractOutcome = 'accepted' | 'rejected' | 'review' | 'degraded' | 'skipped';
export type FailurePolicy = 'fail_closed' | 'fail_to_review' | 'preserve_input';
export type EvidenceCertainty = 'fact' | 'announced' | 'planned' | 'claimed' | 'rumor';

/** A stable source snapshot. Every downstream role must read this snapshot,
 * rather than a generated summary, so quotes remain auditable after retries.
 */
export interface ContractArticleInput {
  articleId: string;
  title: string;
  content: string;
  url: string;
  sourceName?: string | null;
  sourceTier?: string | null;
  sourceCategoryId?: string | null;
  contentHash?: string | null;
  scoringInput?: string | null;
  clusterId?: string | null;
  publishedAt?: string | null;
}

export interface ContractSourceSnapshot {
  articleId: string;
  title: string;
  content: string;
  url: string;
  contentHash: string;
  sourceName: string | null;
  sourceTier: string | null;
  sourceCategoryId: string | null;
  publishedAt: string | null;
}

export interface ContractEvidence {
  evidenceId: string;
  sourceField: 'title' | 'content' | 'url';
  quote: string;
  subject: string;
  predicate: string;
  object: string;
  certainty: EvidenceCertainty;
  confidence: number;
  fields: Record<string, unknown>;
}

export interface ContractDiagnostic {
  code: string;
  message: string;
  role: PostProcessingRole;
  recoverable: boolean;
}

export interface ContractEnvelope<TOutput> {
  contractVersion: '1.0';
  role: PostProcessingRole;
  stage: ContractPipelineStage;
  articleId: string;
  idempotencyKey: string;
  input: ContractSourceSnapshot;
  outcome: ContractOutcome;
  output: TOutput;
  evidence: ContractEvidence[];
  diagnostics: ContractDiagnostic[];
}

export interface RoleContract {
  role: PostProcessingRole;
  label: string;
  stage: ContractPipelineStage;
  dependsOn: PostProcessingRole[];
  failurePolicy: FailurePolicy;
  input: string;
  output: string;
  evidenceRequired: boolean;
  idempotencyScope: 'article_content_hash' | 'article_cluster_hash';
}

/** Mapping to the existing 12-step pipeline. Several roles share a step; no
 * new stage is introduced and the current GitHub/Weibo source paths are not
 * involved in this contract layer.
 */
export const ROLE_CONTRACTS: Readonly<Record<PostProcessingRole, RoleContract>> = {
  content_filter: {
    role: 'content_filter', label: '内容筛选', stage: 'classify', dependsOn: [],
    failurePolicy: 'fail_closed', input: 'ContractArticleInput', output: 'ContentFilterOutput',
    evidenceRequired: true, idempotencyScope: 'article_content_hash',
  },
  content_evaluator: {
    role: 'content_evaluator', label: '内容评估', stage: 'rule_score', dependsOn: ['content_filter'],
    failurePolicy: 'fail_to_review', input: 'ContractArticleInput + ContentFilterOutput', output: 'ContentEvaluationOutput',
    evidenceRequired: true, idempotencyScope: 'article_content_hash',
  },
  chinese_processor: {
    role: 'chinese_processor', label: '中文加工', stage: 'ai_score', dependsOn: ['content_evaluator'],
    failurePolicy: 'preserve_input', input: 'ContractArticleInput + ContentEvaluationOutput', output: 'ChineseProcessingOutput',
    evidenceRequired: true, idempotencyScope: 'article_content_hash',
  },
  body_organizer: {
    role: 'body_organizer', label: '正文整理', stage: 'normalize', dependsOn: ['content_filter'],
    failurePolicy: 'preserve_input', input: 'ContractArticleInput + ContentFilterOutput', output: 'BodyOrganizationOutput',
    evidenceRequired: false, idempotencyScope: 'article_content_hash',
  },
  event_recognizer: {
    role: 'event_recognizer', label: '事件识别', stage: 'cluster', dependsOn: ['content_evaluator'],
    failurePolicy: 'fail_to_review', input: 'ContractArticleInput + ContentEvaluationOutput', output: 'EventRecognitionOutput',
    evidenceRequired: true, idempotencyScope: 'article_content_hash',
  },
  semantic_clusterer: {
    role: 'semantic_clusterer', label: '语义聚类', stage: 'cluster', dependsOn: ['event_recognizer'],
    failurePolicy: 'fail_to_review', input: 'ContractArticleInput + EventRecognitionOutput', output: 'SemanticClusteringOutput',
    evidenceRequired: true, idempotencyScope: 'article_cluster_hash',
  },
  event_reviewer: {
    role: 'event_reviewer', label: '事件复核', stage: 'quality_gate', dependsOn: ['event_recognizer', 'semantic_clusterer'],
    failurePolicy: 'fail_to_review', input: 'ContractArticleInput + EventRecognitionOutput + SemanticClusteringOutput', output: 'EventReviewOutput',
    evidenceRequired: true, idempotencyScope: 'article_cluster_hash',
  },
  featured_explainer: {
    role: 'featured_explainer', label: '精选说明', stage: 'publish_outputs', dependsOn: ['content_evaluator', 'event_reviewer'],
    failurePolicy: 'fail_to_review', input: 'ContractArticleInput + ContentEvaluationOutput + EventReviewOutput', output: 'FeaturedExplanationOutput',
    evidenceRequired: true, idempotencyScope: 'article_cluster_hash',
  },
};

export function getRoleContract(role: PostProcessingRole): RoleContract {
  return ROLE_CONTRACTS[role];
}

export function isPostProcessingRole(value: string): value is PostProcessingRole {
  return (POST_PROCESSING_ROLES as readonly string[]).includes(value);
}

function canonicalString(value: unknown): string {
  if (value === null || value === undefined) return '';
  return String(value).normalize('NFKC').replace(/\s+/g, ' ').trim();
}

/** Preserve source spacing/punctuation for evidence quotes. */
function sourceString(value: unknown): string {
  if (value === null || value === undefined) return '';
  return String(value).trim();
}

function digest(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

/** Build the one immutable source object shared by all role invocations. */
export function buildSourceSnapshot(input: ContractArticleInput): ContractSourceSnapshot {
  const title = sourceString(input.title);
  const content = sourceString(input.content);
  const url = sourceString(input.url);
  const contentHash = canonicalString(input.contentHash)
    || digest(`${canonicalString(title)}\n${canonicalString(url)}\n${canonicalString(content)}`);
  return {
    articleId: canonicalString(input.articleId), title, content, url, contentHash,
    sourceName: input.sourceName ? canonicalString(input.sourceName) : null,
    sourceTier: input.sourceTier ? canonicalString(input.sourceTier) : null,
    sourceCategoryId: input.sourceCategoryId ? canonicalString(input.sourceCategoryId) : null,
    publishedAt: input.publishedAt ? canonicalString(input.publishedAt) : null,
  };
}

/** Idempotency is deterministic across runs and independent of wall-clock time.
 * Cluster roles include cluster identity, while article roles only depend on
 * the immutable content hash.
 */
export function computeRoleIdempotencyKey(
  role: PostProcessingRole,
  input: ContractArticleInput | ContractSourceSnapshot,
  clusterKey?: string | null,
  processingScope?: string | null,
): string {
  const contract = getRoleContract(role);
  const snapshot = 'contentHash' in input ? input : buildSourceSnapshot(input);
  const scope = contract.idempotencyScope === 'article_cluster_hash'
    ? canonicalString(clusterKey) || canonicalString((input as ContractArticleInput).clusterId)
    : '';
  return `pp_${role}_v1_${digest(`${role}\n${snapshot.articleId}\n${snapshot.contentHash}\n${scope}\n${canonicalString(processingScope)}`).slice(0, 32)}`;
}

function evidenceId(role: PostProcessingRole, snapshot: ContractSourceSnapshot, quote: string): string {
  return `ev_${digest(`${role}\n${snapshot.articleId}\n${quote}`).slice(0, 20)}`;
}

function makeEvidence(
  role: PostProcessingRole,
  snapshot: ContractSourceSnapshot,
  quote: string,
  fields: Record<string, unknown> = {},
  certainty: EvidenceCertainty = 'fact',
): ContractEvidence | null {
  const cleanQuote = sourceString(quote);
  if (!cleanQuote) return null;
  const sourceField: ContractEvidence['sourceField'] = snapshot.title.includes(cleanQuote)
    ? 'title' : snapshot.content.includes(cleanQuote) ? 'content' : 'url';
  if (sourceField === 'url' && !snapshot.url.includes(cleanQuote)) return null;
  return {
    evidenceId: evidenceId(role, snapshot, cleanQuote), sourceField, quote: cleanQuote,
    subject: snapshot.sourceName || snapshot.articleId, predicate: 'contains_fact', object: cleanQuote,
    certainty, confidence: certainty === 'fact' ? 1 : 0.6, fields,
  };
}

export function validateContractEvidence(
  snapshot: ContractSourceSnapshot,
  evidence: readonly ContractEvidence[],
): ContractDiagnostic[] {
  const diagnostics: ContractDiagnostic[] = [];
  const seen = new Set<string>();
  for (const item of evidence) {
    if (!item.quote || seen.has(item.evidenceId)) {
      diagnostics.push({ code: 'invalid_evidence', message: 'Evidence must have a unique id and non-empty quote', role: 'content_evaluator', recoverable: false });
      continue;
    }
    seen.add(item.evidenceId);
    const source = item.sourceField === 'title' ? snapshot.title
      : item.sourceField === 'url' ? snapshot.url : snapshot.content;
    if (!source.includes(item.quote)) {
      diagnostics.push({ code: 'ungrounded_quote', message: `Quote is not present in ${item.sourceField}`, role: 'content_evaluator', recoverable: false });
    }
    if (!Number.isFinite(item.confidence) || item.confidence < 0 || item.confidence > 1) {
      diagnostics.push({ code: 'invalid_confidence', message: 'Evidence confidence must be between 0 and 1', role: 'content_evaluator', recoverable: false });
    }
  }
  return diagnostics;
}

export interface ContractProcessor<TInput, TOutput> {
  (input: TInput): { output: TOutput; outcome?: ContractOutcome; evidence?: ContractEvidence[]; diagnostics?: ContractDiagnostic[] };
}

/** Uniform orchestration wrapper. It is intentionally synchronous/pure; an
 * async provider can be adapted outside this module and still persist this
 * envelope atomically using the generated idempotency key.
 */
export function runRoleContract<TOutput>(
  role: PostProcessingRole,
  input: ContractArticleInput,
  processor: ContractProcessor<ContractSourceSnapshot, TOutput>,
  fallbackOutput: TOutput,
  processingScope?: string | null,
): ContractEnvelope<TOutput> {
  const contract = getRoleContract(role);
  const snapshot = buildSourceSnapshot(input);
  const idempotencyKey = computeRoleIdempotencyKey(role, snapshot, input.clusterId, processingScope);
  try {
    const result = processor(snapshot);
    const evidence = result.evidence || [];
    const diagnostics = [
      ...(result.diagnostics || []),
      ...validateContractEvidence(snapshot, evidence).map((diagnostic) => ({ ...diagnostic, role })),
    ];
    if (contract.evidenceRequired && evidence.length === 0) {
      diagnostics.push({
        code: 'missing_evidence',
        message: 'This role requires at least one source-grounded evidence item',
        role,
        recoverable: true,
      });
    }
    const invalidEvidence = diagnostics.some((diagnostic) =>
      diagnostic.code === 'ungrounded_quote'
      || diagnostic.code === 'invalid_evidence'
      || diagnostic.code === 'invalid_confidence');
    const missingEvidence = diagnostics.some((diagnostic) => diagnostic.code === 'missing_evidence');
    const evidenceFailureOutcome: ContractOutcome = contract.failurePolicy === 'fail_closed'
      ? 'rejected' : 'review';
    return {
      contractVersion: '1.0', role, stage: contract.stage, articleId: snapshot.articleId,
      idempotencyKey, input: snapshot,
      outcome: invalidEvidence || missingEvidence ? evidenceFailureOutcome : (result.outcome || 'accepted'),
      output: result.output, evidence, diagnostics,
    };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    const outcome: ContractOutcome = contract.failurePolicy === 'fail_closed' ? 'rejected'
      : contract.failurePolicy === 'fail_to_review' ? 'review' : 'degraded';
    return {
      contractVersion: '1.0', role, stage: contract.stage, articleId: snapshot.articleId,
      idempotencyKey, input: snapshot, outcome, output: fallbackOutput, evidence: [],
      diagnostics: [{ code: 'processor_error', message, role, recoverable: true }],
    };
  }
}

export interface ContentFilterOutput {
  decision: 'candidate' | 'reject' | 'review';
  reasonCode:
    | 'eligible_ai_content'
    | 'missing_title'
    | 'empty_body'
    | 'spam'
    | 'non_ai'
    | 'too_short'
    | 'stale_content';
  reason: string;
  quote: string | null;
  sourceName: string | null;
  sourceUrl: string;
  publishedAt: string | null;
  ageDays: number | null;
  aiSignals: string[];
  normalizedTitle: string;
  normalizedContent: string;
}

export interface ContentFilterOptions {
  /** Required by callers that need freshness decisions to be reproducible. */
  asOf?: string | Date;
  staleAfterDays?: number;
  minimumBodyLength?: number;
}

export interface ContentFilterResult {
  output: ContentFilterOutput;
  outcome: ContractOutcome;
  evidence: ContractEvidence[];
  diagnostics?: ContractDiagnostic[];
}

const AI_SIGNAL_PATTERNS: Array<[string, RegExp]> = [
  ['artificial_intelligence', /\bartificial intelligence\b|人工智能/i],
  ['generative_ai', /\bgenerative ai\b|生成式\s*AI/i],
  ['machine_learning', /\bmachine learning\b|机器学习|深度学习/i],
  ['language_model', /\b(?:large language model|language model|foundation model|LLM)\b|大模型|语言模型|基础模型/i],
  ['named_model', /\b(?:GPT|Claude|Gemini|Llama|Qwen|DeepSeek|Mistral|Gemma|Kimi)[-\s]?\w*/i],
  ['ai_agent', /\bAI agents?\b|智能体|多智能体|agentic/i],
  ['multimodal', /\bmultimodal\b|多模态|文生图|文生视频/i],
  ['ai_workload', /\b(?:model training|model inference|inference serving|neural network|transformer)\b|模型训练|模型推理|神经网络/i],
];

const SPAM_PATTERNS: Array<[string, RegExp]> = [
  ['gambling_or_adult', /casino|博彩|赌博|成人内容|成人视频|色情/i],
  ['fraud_or_promotion', /刷单|代开发票|免费领取|加(?:微信|QQ)|联系客服.{0,12}(?:购买|下单)|guaranteed\s+(?:profit|income)/i],
  ['seo_or_navigation', /^(?:home|menu|login|sign up|subscribe|cookie policy|首页|登录|注册|订阅|隐私政策|导航)[\s|·»›-]*$/i],
];

function boundedQuote(value: string, maxLength = 280): string {
  return value.trim().slice(0, maxLength);
}

function findSentence(text: string, pattern: RegExp): string | null {
  for (const sentence of text.split(/[。！？!?\n]+/).map((item) => item.trim()).filter(Boolean)) {
    pattern.lastIndex = 0;
    if (pattern.test(sentence)) return boundedQuote(sentence);
  }
  return null;
}

function filterAgeDays(publishedAt: string | null, asOf: Date): number | null {
  if (!publishedAt) return null;
  const published = new Date(publishedAt);
  if (Number.isNaN(published.getTime())) return null;
  return Math.max(0, Math.floor((asOf.getTime() - published.getTime()) / 86_400_000));
}

function makeFilterOutput(
  snapshot: ContractSourceSnapshot,
  values: Pick<ContentFilterOutput, 'decision' | 'reasonCode' | 'reason' | 'quote' | 'ageDays' | 'aiSignals'>,
): ContentFilterOutput {
  return {
    ...values,
    sourceName: snapshot.sourceName,
    sourceUrl: snapshot.url,
    publishedAt: snapshot.publishedAt,
    normalizedTitle: canonicalString(snapshot.title),
    normalizedContent: canonicalString(snapshot.content),
  };
}

export function filterContent(
  snapshot: ContractSourceSnapshot,
  options: ContentFilterOptions = {},
): ContentFilterResult {
  const asOf = options.asOf instanceof Date ? options.asOf : new Date(options.asOf || Date.now());
  if (Number.isNaN(asOf.getTime())) throw new Error('Invalid content-filter asOf date');
  const staleAfterDays = Math.max(1, Math.floor(options.staleAfterDays ?? 365));
  const minimumBodyLength = Math.max(1, Math.floor(options.minimumBodyLength ?? 40));
  const combined = `${snapshot.title}\n${snapshot.content}`;
  const ageDays = filterAgeDays(snapshot.publishedAt, asOf);
  const signals = AI_SIGNAL_PATTERNS
    .filter(([, pattern]) => { pattern.lastIndex = 0; return pattern.test(combined); })
    .map(([name]) => name);

  let output: ContentFilterOutput;
  let evidenceQuote: string | null;
  if (!snapshot.title) {
    evidenceQuote = boundedQuote(snapshot.content || snapshot.url);
    output = makeFilterOutput(snapshot, {
      decision: 'reject', reasonCode: 'missing_title', reason: '标题为空，无法确认内容主题。',
      quote: evidenceQuote || null, ageDays, aiSignals: signals,
    });
  } else if (!snapshot.content || !snapshot.content.replace(/<[^>]*>|&nbsp;/gi, '').trim()) {
    evidenceQuote = boundedQuote(snapshot.title || snapshot.url);
    output = makeFilterOutput(snapshot, {
      decision: 'reject', reasonCode: 'empty_body', reason: '正文为空或仅包含空白标记。',
      quote: evidenceQuote || null, ageDays, aiSignals: signals,
    });
  } else {
    const spam = SPAM_PATTERNS.find(([, pattern]) => {
      pattern.lastIndex = 0;
      return pattern.test(snapshot.content) || pattern.test(snapshot.title);
    });
    if (spam) {
      evidenceQuote = findSentence(combined, spam[1]) || boundedQuote(snapshot.content);
      output = makeFilterOutput(snapshot, {
        decision: 'reject', reasonCode: 'spam', reason: `命中垃圾内容信号：${spam[0]}。`,
        quote: evidenceQuote, ageDays, aiSignals: signals,
      });
    } else if (signals.length === 0) {
      evidenceQuote = boundedQuote(snapshot.content.split(/[。！？!?\n]+/).find((item) => item.trim()) || snapshot.title);
      output = makeFilterOutput(snapshot, {
        decision: 'reject', reasonCode: 'non_ai', reason: '标题和正文未发现明确的 AI 主题信号。',
        quote: evidenceQuote, ageDays, aiSignals: [],
      });
    } else if (ageDays !== null && ageDays > staleAfterDays) {
      const signalPattern = AI_SIGNAL_PATTERNS.find(([name]) => signals.includes(name))?.[1];
      evidenceQuote = signalPattern ? findSentence(combined, signalPattern) : boundedQuote(snapshot.title);
      output = makeFilterOutput(snapshot, {
        decision: 'review', reasonCode: 'stale_content',
        reason: `内容距筛选基准日 ${ageDays} 天，超过 ${staleAfterDays} 天阈值。`,
        quote: evidenceQuote || boundedQuote(snapshot.title), ageDays, aiSignals: signals,
      });
    } else if (snapshot.content.length < minimumBodyLength) {
      evidenceQuote = boundedQuote(snapshot.content);
      output = makeFilterOutput(snapshot, {
        decision: 'review', reasonCode: 'too_short', reason: '正文过短，AI 相关性存在但上下文不足。',
        quote: evidenceQuote, ageDays, aiSignals: signals,
      });
    } else {
      const signalPattern = AI_SIGNAL_PATTERNS.find(([name]) => signals.includes(name))?.[1];
      evidenceQuote = signalPattern ? findSentence(combined, signalPattern) : boundedQuote(snapshot.title);
      output = makeFilterOutput(snapshot, {
        decision: 'candidate', reasonCode: 'eligible_ai_content', reason: '正文完整且包含明确 AI 主题信号。',
        quote: evidenceQuote || boundedQuote(snapshot.title), ageDays, aiSignals: signals,
      });
    }
  }

  const evidence = output.quote
    ? makeEvidence('content_filter', snapshot, output.quote, {
      decision: output.decision,
      reasonCode: output.reasonCode,
      reason: output.reason,
      sourceName: output.sourceName,
      sourceUrl: output.sourceUrl,
      publishedAt: output.publishedAt,
      ageDays: output.ageDays,
      aiSignals: output.aiSignals,
    })
    : null;
  const outcome: ContractOutcome = output.decision === 'candidate' ? 'accepted'
    : output.decision === 'review' ? 'review' : 'rejected';
  return { output, outcome, evidence: evidence ? [evidence] : [] };
}

export function runContentFilter(
  input: ContractArticleInput,
  options: ContentFilterOptions = {},
): ContractEnvelope<ContentFilterOutput> {
  const asOf = options.asOf instanceof Date ? options.asOf : new Date(options.asOf || Date.now());
  if (Number.isNaN(asOf.getTime())) {
    // Let runRoleContract apply the content_filter fail-closed policy.
    return runRoleContract('content_filter', input, () => {
      throw new Error('Invalid content-filter asOf date');
    }, makeFilterOutput(buildSourceSnapshot(input), {
      decision: 'reject', reasonCode: 'empty_body', reason: '筛选器失败，拒绝进入后续流程。',
      quote: null, ageDays: null, aiSignals: [],
    }), 'invalid-date');
  }
  const staleAfterDays = Math.max(1, Math.floor(options.staleAfterDays ?? 365));
  const scope = [asOf.toISOString().slice(0, 10), staleAfterDays, input.sourceName || '', input.url].join('|');
  const fallback = makeFilterOutput(buildSourceSnapshot(input), {
    decision: 'reject', reasonCode: 'empty_body', reason: '筛选器失败，拒绝进入后续流程。',
    quote: null, ageDays: null, aiSignals: [],
  });
  return runRoleContract(
    'content_filter', input, (snapshot) => filterContent(snapshot, { ...options, asOf }), fallback, scope,
  );
}

export interface ContentEvaluationOutput {
  score: number;
  overall: number;
  dimensions: {
    relevance: number;
    novelty: number;
    credibility: number;
    impact: number;
    verifiability: number;
  };
  decision: 'pass' | 'review' | 'reject';
  publishEligible: boolean;
  reviewReasons: string[];
  evidence: Array<{
    dimension: 'relevance' | 'novelty' | 'credibility' | 'impact' | 'verifiability';
    quote: string;
    span: { start: number; end: number };
    sourceField: 'title' | 'content';
    source: string;
    sourceName: string | null;
    date: string | null;
  }>;
}

const CONTENT_AI_TOPIC_RE = /\bartificial intelligence\b|\bgenerative ai\b|\bmachine learning\b|\b(?:large|foundation|language) model\b|\bllm\b|\b(?:gpt|claude|gemini|llama|qwen|deepseek|mistral|gemma|kimi)[-_ ]?\w*|\bai agent\b|\bmultimodal\b|\b(?:model training|model inference|neural network|transformer)\b|人工智能|生成式\s*AI|机器学习|深度学习|大模型|语言模型|基础模型|智能体|多智能体|多模态|模型训练|模型推理|神经网络/i;
const CONTENT_ACTION_RE = /\brelease(?:d|s)?\b|\blaunch(?:ed|es)?\b|\bpublish(?:ed|es)?\b|\bannounce(?:d|s)?\b|\bdeploy(?:ed|s|ment)?\b|\btrain(?:ed|s|ing)?\b|\bbenchmark(?:ed|s)?\b|\bstud(?:y|ied|ies)\b|\bfund(?:ed|ing|s)?\b|\bacqui(?:re|red|res|sition)\b|\bopen[- ]source\b|发布|推出|上线|部署|训练|评测|测试|研究|融资|收购|并购|开源|签署|合作|宣布/i;
const CONTENT_SUBJECT_RE = /\b(?:openai|anthropic|google|microsoft|meta|nvidia|amazon|alibaba|baidu|tencent|bytedance|mistral|deepseek|hugging\s*face|[A-Z][A-Za-z0-9_-]{2,})\b|公司|团队|研究机构|实验室|厂商|模型|系统|产品|平台|项目|医院|车企|客户/i;
const CONTENT_OBJECT_RE = /\b(?:gpt|claude|gemini|llama|qwen|deepseek|mistral|gemma|kimi)[-_ ]?\w*\b|\b(?:api|sdk|dataset|benchmark|leaderboard|model|agent|platform|product|service|chip|gpu|paper|report|framework)\b|模型|智能体|平台|产品|服务|数据集|基准|排行榜|芯片|GPU|论文|报告|框架|助手/i;
const CONTENT_TIME_RE = /\b20\d{2}(?:[-/.]\d{1,2}(?:[-/.]\d{1,2})?)?\b|\b(?:today|yesterday|this week|this month|in \d{4}|q[1-4])\b|\d{1,2}月(?:\d{1,2}日)?|今年|本周|本月|昨日|今日|截至|目前|最新/i;
const CONTENT_NUMBER_RE = /\b\d+(?:\.\d+)?\s*(?:%|percent|ms|s|秒|分钟|小时|万|亿|million|billion|tokens?|users?|customers?|件|个|家)?\b|[$€¥]\s*\d[\d,.]*|\d[\d,.]*\s*(?:美元|人民币|元)/i;
const CONTENT_ATTRIBUTION_RE = /according to|reported by|said|told|confirmed by|数据显示|据|报道|消息人士|官方|公告|研究显示|报告显示|来源/i;
const CONTENT_NOVELTY_RE = /\bnew(?:ly)?\b|\bfirst\b|\bversion\s*\d|\bv\d+(?:\.\d+)+\b|\bbreakthrough\b|\bstate[- ]of[- ]the[- ]art\b|首次|新发布|新版本|升级|突破|里程碑|刷新纪录|达到新高/i;
const CONTENT_IMPACT_RE = /\b(?:adopt(?:ed|ion)?|deploy(?:ed|ment)?|production|enterprise|customer|user|revenue|cost|latency|throughput|accuracy|efficiency|roi|market)\b|采用|部署|生产|上线|客户|用户|营收|成本|延迟|吞吐|准确率|效率|收益|市场|影响/i;
const CONTENT_UNCERTAINTY_RE = /\b(?:rumou?r(?:ed)?|alleged(?:ly)?|reportedly|may|might|could|plans?\s+to|intend(?:s|ed)?\s+to|will|expected\s+to|unconfirmed|pending)\b|传闻|据称|据报道|可能|或将|计划|拟|预计|意图|尚未|待定|未证实|将于/i;
const CONTENT_NEGATION_RE = /\b(?:not|no|never|without|failed|did not|hasn't|haven't|doesn't|isn't)\b|没有|未|并未|尚无|不具备|无法|失败|否认/i;
const CONTENT_MARKETING_RE = /\b(?:revolutionary|game[- ]changer|best[- ]in[- ]class|world[- ]leading|unprecedented|groundbreaking|industry[- ]first)\b|革命性|颠覆性|世界领先|最佳|无与伦比|行业第一|划时代|震撼/i;
const TRUSTED_SOURCE_TIERS = new Set(['authoritative', 'validation', 'top', 'high']);

function contentSentences(snapshot: ContractSourceSnapshot): string[] {
  return `${snapshot.title}\n${snapshot.content}`
    .split(/[。！？!?\n]+/)
    .map((part) => part.trim())
    .filter(Boolean);
}

function hasPattern(text: string, pattern: RegExp): boolean {
  pattern.lastIndex = 0;
  return pattern.test(text);
}

function contentFactSignals(snapshot: ContractSourceSnapshot): {
  text: string;
  topic: boolean;
  action: boolean;
  subject: boolean;
  object: boolean;
  time: boolean;
  number: boolean;
  attribution: boolean;
  event: boolean;
  uncertainty: boolean;
  negation: boolean;
  marketing: boolean;
} {
  const text = `${snapshot.title}\n${snapshot.content}`;
  const topic = hasPattern(text, CONTENT_AI_TOPIC_RE);
  const action = hasPattern(text, CONTENT_ACTION_RE);
  const subject = hasPattern(text, CONTENT_SUBJECT_RE);
  const object = hasPattern(text, CONTENT_OBJECT_RE);
  const time = hasPattern(text, CONTENT_TIME_RE) || Boolean(snapshot.publishedAt);
  const number = hasPattern(text, CONTENT_NUMBER_RE);
  const attribution = Boolean(snapshot.sourceName) && hasPattern(text, CONTENT_ATTRIBUTION_RE);
  const event = topic && action && object;
  const uncertainty = hasPattern(text, CONTENT_UNCERTAINTY_RE);
  const negation = hasPattern(text, CONTENT_NEGATION_RE);
  const marketing = hasPattern(text, CONTENT_MARKETING_RE);
  return { text, topic, action, subject, object, time, number, attribution, event, uncertainty, negation, marketing };
}

function evaluationReviewReasons(
  snapshot: ContractSourceSnapshot,
  signals: ReturnType<typeof contentFactSignals>,
  dimensions: ContentEvaluationOutput['dimensions'],
): string[] {
  const reasons: string[] = [];
  if (!signals.topic) reasons.push('missing_ai_topic_signal');
  if (!signals.event) reasons.push('missing_ai_action_or_object');
  if (!signals.subject || !signals.action || !signals.object || !signals.time) reasons.push('incomplete_fact_tuple');
  if (!signals.number && !signals.attribution && !signals.event) reasons.push('weak_verifiability_signal');
  if (!snapshot.url || !/^https?:\/\//i.test(snapshot.url)) reasons.push('missing_http_source_url');
  if (!TRUSTED_SOURCE_TIERS.has((snapshot.sourceTier || '').toLowerCase())) reasons.push('source_tier_not_allowlisted');
  if (!snapshot.sourceName) reasons.push('missing_source_attribution');
  if (signals.uncertainty) reasons.push('uncertain_or_future_claim');
  if (signals.negation) reasons.push('negative_or_failed_claim');
  if (signals.marketing && !signals.number && !signals.attribution) reasons.push('marketing_language_without_fact');
  if (dimensions.novelty === 0) reasons.push('no_novelty_signal');
  if (dimensions.impact === 0) reasons.push('no_impact_signal');
  return [...new Set(reasons)];
}

function evaluationQuote(snapshot: ContractSourceSnapshot, signals: ReturnType<typeof contentFactSignals>): string {
  const sentences = contentSentences(snapshot);
  const factual = sentences.find((sentence) => hasPattern(sentence, CONTENT_AI_TOPIC_RE)
    && hasPattern(sentence, CONTENT_ACTION_RE)
    && !hasPattern(sentence, CONTENT_UNCERTAINTY_RE)
    && !hasPattern(sentence, CONTENT_NEGATION_RE));
  return boundedQuote(factual || sentences.find((sentence) => hasPattern(sentence, CONTENT_NUMBER_RE)) || sentences[0] || snapshot.url);
}

export function evaluateContent(
  snapshot: ContractSourceSnapshot,
  filter?: ContentFilterOutput,
): { output: ContentEvaluationOutput; evidence: ContractEvidence[]; diagnostics: ContractDiagnostic[]; outcome: ContractOutcome } {
  const computed = computeContentEvaluation(
    snapshot as EvaluationSourceSnapshot,
    filter as EvaluationFilterOutput | undefined,
  );
  const evidenceById = new Map<string, ContractEvidence>();
  computed.evidence.flatMap((item) => {
    const contractEvidence = makeEvidence('content_evaluator', snapshot, item.quote, {
      dimension: item.dimension,
      span: item.span,
      source: item.source,
      sourceName: item.sourceName,
      date: item.date,
      score: computed.output.dimensions[item.dimension],
      overall: computed.output.overall,
    });
    if (contractEvidence) evidenceById.set(contractEvidence.evidenceId, contractEvidence);
    return [];
  });
  const evidence = [...evidenceById.values()];
  const diagnostics = computed.diagnostics.map((item) => ({ ...item, role: 'content_evaluator' as const }));
  return {
    output: computed.output,
    evidence,
    diagnostics,
    outcome: computed.output.decision === 'pass' ? 'accepted'
      : computed.output.decision === 'reject' ? 'rejected' : 'review',
  };
}

export function runContentEvaluation(
  input: ContractArticleInput,
  filter: ContentFilterOutput,
): ContractEnvelope<ContentEvaluationOutput> {
  const fallback: ContentEvaluationOutput = {
    dimensions: { relevance: 0, novelty: 0, credibility: 0, impact: 0, verifiability: 0 },
    overall: 0,
    score: 0,
    decision: 'review',
    publishEligible: false,
    reviewReasons: ['insufficient_evidence'],
    evidence: [],
  };
  const scope = `${filter.decision}|${filter.reasonCode}|${filter.normalizedTitle}|${filter.normalizedContent}`;
  return runRoleContract('content_evaluator', input, (source) => evaluateContent(source, filter), fallback, scope);
}

export interface ChineseProcessingOutput {
  language: 'zh' | 'mixed' | 'non_zh';
  title: string;
  summary: string;
  changed: boolean;
}

export function processChinese(snapshot: ContractSourceSnapshot): ChineseProcessingOutput {
  const text = `${snapshot.title} ${snapshot.content}`;
  const han = (text.match(/[\u3400-\u9fff]/g) || []).length;
  const latin = (text.match(/[A-Za-z]/g) || []).length;
  const language = han > 0 && latin > 0 ? 'mixed' : han > 0 ? 'zh' : 'non_zh';
  const summary = snapshot.content.replace(/\s+/g, ' ').trim().slice(0, 200);
  return { language, title: snapshot.title, summary, changed: summary !== snapshot.content };
}

export interface BodyOrganizationOutput {
  paragraphs: string[];
  paragraphCount: number;
  truncated: boolean;
}

export function organizeBody(snapshot: ContractSourceSnapshot): BodyOrganizationOutput {
  const paragraphs = snapshot.content.split(/\n{2,}|(?<=[。！？!?])\s+(?=[\u3400-\u9fffA-Za-z])/).map((part) => part.trim()).filter(Boolean);
  const bounded = paragraphs.slice(0, 80);
  return { paragraphs: bounded, paragraphCount: bounded.length, truncated: paragraphs.length > bounded.length };
}

export type EventType = 'release' | 'funding' | 'acquisition' | 'benchmark' | 'policy' | 'research' | 'partnership' | 'other';

export interface EventRecognitionOutput {
  eventType: EventType;
  entities: string[];
  eventKey: string;
  confidence: number;
}

const EVENT_PATTERNS: Array<[EventType, RegExp]> = [
  ['release', /release|launch|上线|发布|推出|开源/i],
  ['funding', /funding|series\s*[a-f]|融资|估值|投资/i],
  ['acquisition', /acqui(?:re|sition)|并购|收购/i],
  ['benchmark', /benchmark|leaderboard|mmlu|swe[-_ ]?bench|评测|基准/i],
  ['policy', /policy|regulation|governance|政策|监管|治理/i],
  ['partnership', /partnership|partner|contract|合作|签约|合同/i],
  ['research', /paper|study|研究|论文|报告/i],
];

const ENTITY_RE = /OpenAI|Anthropic|Google|Microsoft|Meta|NVIDIA|Amazon|阿里|腾讯|百度|字节|英伟达|谷歌|微软|苹果|[A-Z][A-Za-z0-9_-]{2,}/g;

export function recognizeEvent(snapshot: ContractSourceSnapshot): { output: EventRecognitionOutput; evidence: ContractEvidence[] } {
  const text = `${snapshot.title}\n${snapshot.content}`;
  const match = EVENT_PATTERNS.find(([, pattern]) => pattern.test(text));
  const eventType = match?.[0] || 'other';
  const entities = [...new Set(text.match(ENTITY_RE) || [])].slice(0, 12);
  const eventKey = digest(`${eventType}\n${entities.sort().join('|')}\n${snapshot.title}`).slice(0, 24);
  const quote = snapshot.title || snapshot.content.slice(0, 120);
  const evidence = makeEvidence('event_recognizer', snapshot, quote, { eventType, entities });
  return { output: { eventType, entities, eventKey, confidence: match ? 0.75 : 0.25 }, evidence: evidence ? [evidence] : [] };
}

export interface SemanticClusteringOutput {
  clusterKey: string;
  anchorTerms: string[];
  confidence: number;
  comparable: boolean;
}

export function clusterSemantics(
  snapshot: ContractSourceSnapshot,
  event: EventRecognitionOutput,
): SemanticClusteringOutput {
  const terms = [...new Set(`${snapshot.title} ${event.entities.join(' ')}`.toLocaleLowerCase('en-US').match(/[\p{L}\p{N}][\p{L}\p{N}_-]*/gu) || [])]
    .filter((term) => term.length >= 2).sort().slice(0, 12);
  const clusterKey = `evt_${digest(`${event.eventType}\n${terms.join('|')}`).slice(0, 24)}`;
  return { clusterKey, anchorTerms: terms, confidence: terms.length >= 2 ? 0.7 : 0.35, comparable: terms.length >= 2 };
}

export interface EventReviewOutput {
  decision: 'approve' | 'review' | 'reject';
  reasonCode: 'consistent' | 'weak_signal' | 'conflicting_signal' | 'missing_event';
  clusterKey: string | null;
}

export function reviewEvent(
  event: EventRecognitionOutput,
  cluster: SemanticClusteringOutput,
): EventReviewOutput {
  if (event.eventType === 'other') return { decision: 'review', reasonCode: 'missing_event', clusterKey: cluster.clusterKey };
  if (!cluster.comparable || event.confidence < 0.5) return { decision: 'review', reasonCode: 'weak_signal', clusterKey: cluster.clusterKey };
  return { decision: 'approve', reasonCode: 'consistent', clusterKey: cluster.clusterKey };
}

export interface FeaturedExplanationOutput {
  featured: boolean;
  explanation: string;
  score: number;
  direction: string | null;
}

export function explainFeatured(
  snapshot: ContractSourceSnapshot,
  evaluation: ContentEvaluationOutput,
  review: EventReviewOutput,
  direction: string | null = null,
): { output: FeaturedExplanationOutput; evidence: ContractEvidence[] } {
  const featured = evaluation.decision === 'pass' && review.decision === 'approve';
  const explanation = featured
    ? `来源${snapshot.sourceName ? `「${snapshot.sourceName}」` : ''}，内容完整度${evaluation.score}分，事件证据已复核。`
    : '未满足精选条件，保留在工作台供人工复核。';
  const evidence = makeEvidence('featured_explainer', snapshot, snapshot.title, { score: evaluation.score, review: review.decision });
  return { output: { featured, explanation, score: evaluation.score, direction }, evidence: evidence ? [evidence] : [] };
}
