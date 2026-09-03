import { Injectable, Inject, Logger, Optional } from '@nestjs/common';
import { CapabilityService } from '@lark-apaas/fullstack-nestjs-core';
import {
  createAgentGateway,
  createAgentRegistry,
  type AgentGateway,
  type AgentInvocationOptions,
} from './agents';
import type { AgentRegistry } from './agents';

export const AGENT_REGISTRY_TOKEN = 'COLLECTOR_AGENT_REGISTRY';
export const AGENT_INVOCATION_OPTIONS_TOKEN =
  'COLLECTOR_AGENT_INVOCATION_OPTIONS';
export const AGENT_GATEWAY_TOKEN = 'COLLECTOR_AGENT_GATEWAY';
import type {
  AiArticleScoringOneInput,
  AiArticleScoringOneOutput,
} from '@shared/plugin-types';
import {
  DIRECTIONS,
  ALL_DIRECTION_IDS,
  LEGACY_DIRECTION_MAP,
  MAX_DIRECTION_SCORE,
  DIMENSION_FULL,
  DIMENSION_HALF,
  getDirectionEvidenceRequirement,
  getDirectionScoringPolicy,
  hasSufficientDirectionEvidence,
  type Direction,
  type DirectionMeta,
} from '@shared/directions';
import type {
  DimensionScores,
  EvidenceCertainty,
  ScoreEvidence,
} from '@shared/api.interface';

const SCORING_PLUGIN_INSTANCE_ID = 'ai_article_scoring_1';
const SCORING_ACTION_KEY = 'textToJson';

type AiPluginDirection =
  | 'agent'
  | 'model'
  | 'coding'
  | 'multi'
  | 'eval'
  | 'infra'
  | 'data'
  | 'security';

type AiDirectionScores = Partial<
  Record<Direction | AiPluginDirection, Record<string, unknown>>
>;

/** A text-grounded fact proposed by the AI scorer for one dimension. */
export type ScoringEvidence = ScoreEvidence;

const AI_PLUGIN_TO_NEW: Record<AiPluginDirection, Direction> = {
  model: 'model',
  agent: 'agent',
  coding: 'coding',
  multi: 'multimodal',
  eval: 'data_eval',
  infra: 'infrastructure',
  data: 'data_eval',
  security: 'safety_governance',
};

export interface DirectionEvidence {
  normalizedScore: number;
  hasClearEvidence: boolean;
  dimensionScores: DimensionScores;
  evidenceByDimension?: Record<string, ScoringEvidence[]>;
}

export interface ClassificationCandidate {
  direction: Direction;
  score: number;
  eligible: boolean;
  dimensionScores: DimensionScores;
  matchedDimensions: string[];
  evidence: string[];
}

export interface ArticleClassificationResult {
  primaryDirection: Direction | null;
  /** Directions with a complete, direction-specific editorial story. */
  evidence: string[];
  candidates: ClassificationCandidate[];
  ambiguous: boolean;
  status: 'classified' | 'ambiguous' | 'no_match' | 'degraded';
  degradeReason: string | null;
}

interface GenericQualityScore {
  sourceCredibility: number;
  verifiability: number;
  completeness: number;
  impactSignal: number;
  total: number;
}

export interface ArticleScoringResult {
  summary: string;
  directionScores: Record<Direction, DirectionEvidence>;
  primaryDirection: Direction | null;
  primaryScore: number;
  publishScore: number;
  coreEvidencePassed: boolean;
  aiProcessed: boolean;
  degradeReason: string | null;
}

/** Build the immutable, text-grounded input sent to the scoring provider. */
export function buildScoringInput(title: string, content: string): string {
  // Preserve punctuation and spacing inside the source body: evidence quotes
  // must remain byte-for-byte traceable after a rescore.
  const normalizedTitle = String(title || '').trim();
  const normalizedContent = String(content || '').trim();
  return [`标题：${normalizedTitle}`, `正文：${normalizedContent}`].join('\n');
}

const SOURCE_TIER_POINTS: Record<string, number> = {
  authoritative: 20,
  top: 20,
  validation: 15,
  high: 15,
  // Keep the configured publish threshold reachable for verified signal feeds
  // when the article has strong direction evidence.
  signal: 10,
  medium: 10,
  low: 3,
};

const NUMBER_RE = /\d[\d,.]*%|\$[\d,.]+[BMKbmk]?|\d{2,}/;
const ORG_NAMES = [
  'openai',
  'anthropic',
  'google',
  'meta',
  'microsoft',
  'nvidia',
  'apple',
  'amazon',
  'hugging face',
  'mistral',
  'deepseek',
  'alibaba',
  'baidu',
  'tencent',
  'bytedance',
  'vercel',
  'langchain',
  'cohere',
];

interface EvidencePatterns {
  strong: RegExp[];
  weak: string[];
}

function buildDirectionPatterns(): Record<
  Direction,
  Record<string, EvidencePatterns>
> {
  const num = NUMBER_RE;
  const orgRe =
    /openai|anthropic|google|meta|microsoft|nvidia|apple|amazon|mistral|deepseek|alibaba|baidu|tencent|vercel|langchain/i;
  const versionRe = /v?\d+\.\d+|version\s*\d|release\s*\d/i;
  const percentRe = /\d+(\.\d+)?%/;
  const benchmarkRe =
    /benchmark|leaderboard|mmlu|humaneval|swe[-_]bench|arena|elo|sota|state.of.the.art/i;
  const releaseRe =
    /launch|release|announce|publish|open.source|available| debut/i;
  const productRe = /product|platform|service|api|sdk|tool|feature/i;

  const mk = (strong: RegExp[], weak: string[]): EvidencePatterns => ({
    strong,
    weak,
  });

  return {
    model: {
      entity: mk(
        [
          /(?:gpt|claude|gemini|llama|qwen|deepseek|mistral|phi|gemma)[-_ ]?\d/i,
          /(?:通义千问|豆包|文心一言|智谱(?:清言|GLM)|混元|盘古|百川|讯飞星火|Kimi)[-_ ]?\d*/i,
          versionRe,
        ],
        [
          'model',
          'llm',
          'foundation model',
          'language model',
          '大模型',
          '语言模型',
        ],
      ),
      capability: mk(
        [
          percentRe,
          /outperform|surpass|achieve|state.of.the.art|sota|(?:准确率|性能|得分|胜率|提升|超过).{0,16}\d+(?:%|分)?/i,
          benchmarkRe,
        ],
        ['capability', 'ability', '能力', '性能', 'improvement', '提升'],
      ),
      availability: mk(
        [
          /(?:api|sdk|download|access).{0,20}(?:now|today|available)/i,
          /\$?\d+.*per.{0,10}(?:token|month|request)/i,
        ],
        ['available', 'open source', 'api', 'download', '可用', '开放'],
      ),
      performance: mk(
        [benchmarkRe, /accuracy.{0,10}\d+/, /(?:score|rating|elo).{0,10}\d+/i],
        ['benchmark', 'accuracy', 'performance', '准确率', '得分'],
      ),
      cost: mk(
        [
          /\$[\d,.]+/,
          /(?:cost|price|cheaper|faster).{0,15}\d+/i,
          /token.{0,10}(?:per|\/)/i,
        ],
        ['cost', 'price', 'cheaper', '成本', '价格', 'efficiency'],
      ),
      ecosystem: mk(
        [
          /integrat|plugin|extension|compatib/i,
          /pytorch|tensorflow|huggingface|onnx/i,
        ],
        ['ecosystem', 'compatible', 'integration', '生态', '兼容', '集成'],
      ),
      adoption: mk(
        [
          /\d+.{0,10}(?:user|developer|company|enterprise)/i,
          /adopt|deploy|production|usage/i,
        ],
        ['adoption', 'usage', 'popular', 'widely', '采用', '使用'],
      ),
    },
    agent: {
      task_boundary: mk(
        [
          /multi[- ]?step|complex\s+task|end[- ]?to[- ]?end|多步骤|端到端|自主执行|任务规划/i,
          /(?:plan|reason|execute).{0,20}(?:autonom|independ)|(?:规划|执行).{0,12}(?:自主|独立)/i,
        ],
        ['task', 'autonomous', 'planning', '任务', '自主', '规划'],
      ),
      tool_call: mk(
        [
          /function\s+call|tool[- ]?(?:use|call)|mcp|a2a|函数调用|工具调用|调用工具/i,
          /(?:api|browser|terminal|database).{0,10}(?:tool|access)|(?:浏览器|终端|数据库).{0,10}(?:访问|调用)/i,
        ],
        ['tool', 'function calling', '工具', '调用', 'api'],
      ),
      protocol: mk(
        [
          /mcp|a2a|agent[- ]?to[- ]?agent|protocol|standard/i,
          /interoperab|compatib.{0,15}agent/i,
        ],
        ['protocol', 'mcp', 'standard', '协议', '标准', '互操作'],
      ),
      orchestration: mk(
        [
          /multi[- ]?agent|workflow|orchestrat|coordinat|多智能体|工作流编排|协同/i,
          /(?:agent|node).{0,10}(?:graph|chain|pipeline)/i,
        ],
        ['multi-agent', 'orchestration', 'workflow', '编排', '工作流'],
      ),
      observability: mk(
        [
          /trace|logging|monitor|observ|debug|audit/i,
          /(?:step|action).{0,10}(?:log|record|track)/i,
        ],
        ['observability', 'monitor', 'trace', '可观测', '监控', '追踪'],
      ),
      production: mk(
        [
          /production|enterprise|deploy|reliab|guardrail|正式上线|已上线|生产环境/i,
          /(?:human|operator).{0,10}(?:loop|override|review)/i,
        ],
        ['production', 'enterprise', 'reliable', '生产', '企业', '可靠'],
      ),
      benchmark: mk(
        [benchmarkRe, /success.{0,10}(?:rate|ratio).{0,10}\d+/i],
        ['benchmark', 'evaluation', 'test', '评测', '测试'],
      ),
      workflow: mk(
        [
          /enterprise|business.{0,10}(?:process|workflow)|crm|erp/i,
          /(?:automat|integrat).{0,15}(?:workflow|process)/i,
          /(?:企业|业务).{0,10}(?:流程|工作流)|(?:自动化|集成).{0,15}(?:工作流|流程)/,
        ],
        ['workflow', 'enterprise', 'business', '企业工作流', '自动化'],
      ),
    },
    multimodal: {
      modality_coverage: mk(
        [
          /text[- ]?(?:to|and)[- ]?(?:image|video|audio|3d)|image[- ]?(?:to|and)[- ]?(?:text|video)/i,
          /(?:vision|audio|speech|video|image).{0,10}(?:input|output|process)/i,
        ],
        ['multimodal', 'multi-modal', '多模态', 'vision', 'audio'],
      ),
      io_capability: mk(
        [
          /(?:input|accept).{0,15}(?:image|video|audio|pdf|document)/i,
          /(?:output|generat).{0,15}(?:image|video|audio|3d)/i,
        ],
        ['input', 'output', 'generation', 'understanding', '输入', '输出'],
      ),
      quality: mk(
        [
          benchmarkRe,
          /(?:quality|fidelity|realism).{0,10}(?:score|rating|high)/i,
        ],
        ['quality', 'fidelity', 'realism', '质量', '逼真'],
      ),
      realtime: mk(
        [
          /real[- ]?time|streaming|live|latency.{0,10}\d+/i,
          /(?:interactive|conversational).{0,10}(?:voice|video)/i,
        ],
        ['real-time', 'realtime', 'streaming', '实时', '流式'],
      ),
      editing: mk(
        [
          /edit|manipulat|inpaint|control|modify.{0,10}(?:image|video|audio)/i,
          /(?:fine[- ]?grained|precise).{0,10}control/i,
        ],
        ['editing', 'control', 'manipulation', '编辑', '控制'],
      ),
      '3d_world': mk(
        [
          /3[- ]?d|world\s+model|spatial|point\s+cloud|mesh|nerf|gaussian/i,
          /(?:scene|environment).{0,10}(?:understand|generat|reconstruct)/i,
        ],
        ['3d', 'world model', 'spatial', '三维', '世界模型'],
      ),
      safety_copyright: mk(
        [
          /(?:copyright|watermark|nsfw|deepfake).{0,10}(?:detect|filter|prevent)/i,
          /bias.{0,10}(?:audio|image|video)/i,
        ],
        ['copyright', 'safety', 'watermark', '版权', '安全'],
      ),
      product: mk(
        [
          productRe,
          /(?:app|application|feature).{0,15}(?:launch|release|available)/i,
        ],
        ['product', 'application', 'feature', '产品', '应用'],
      ),
    },
    coding: {
      code_gen: mk(
        [
          /code\s+generat|copilot|autocomplet|code\s+assist|代码生成|代码补全|编程助手/i,
          /(?:function|class|module).{0,10}(?:generat|complet|suggest)/i,
        ],
        ['code generation', 'coding', '代码生成', '编程'],
      ),
      repo_understanding: mk(
        [
          /repo|repository|codebase|cross[- ]?file|project[- ]?(?:level|wide)|代码库|仓库理解/i,
          /(?:understand|analyz|index).{0,10}(?:code|repo)|(?:理解|分析).{0,10}(?:代码库|仓库)/i,
        ],
        ['repository', 'codebase', '仓库', '代码库', '理解'],
      ),
      engineering: mk(
        [
          /(?:refactor|debug|fix|test|migrate|deploy).{0,10}(?:code|bug|issue)|(?:重构|调试|修复|迁移|部署).{0,10}(?:代码|缺陷|工程)/i,
          /(?:ci|cd|pipeline|build).{0,10}(?:automat|integrat)|(?:自动|完成).{0,10}(?:修复|重构|测试|部署)/i,
        ],
        ['engineering', 'debug', 'refactor', '工程', '调试', '重构'],
      ),
      ide_integration: mk(
        [
          /(?:vscode|vim|neovim|jetbrains|terminal|cli).{0,10}(?:plugin|extension|integrat)/i,
          /ide|editor|inline.{0,10}(?:suggest|complet)/i,
        ],
        ['ide', 'editor', 'terminal', '编辑器', '终端', '集成'],
      ),
      delivery: mk(
        [
          /(?:pass|accuracy|correct).{0,10}\d+/,
          /(?:bug|defect|error).{0,10}(?:rate|reduc|fix)/i,
        ],
        ['delivery', 'quality', 'correct', '质量', '准确'],
      ),
      benchmark: mk(
        [
          /swe[-_]bench|humaneval|mbpp|code[- ]?arena|livecode/i,
          /(?:pass|solve).{0,10}(?:rate|ratio).{0,10}\d+/i,
        ],
        ['benchmark', 'evaluation', 'test', '评测'],
      ),
      cost_speed: mk(
        [
          /\$[\d,.]+/,
          /(?:token|latency|speed).{0,10}(?:per|\/|ms|sec)/i,
          /(?:faster|cheaper|efficient).{0,10}\d+/i,
        ],
        ['cost', 'speed', 'latency', '成本', '速度'],
      ),
      security: mk(
        [
          /(?:vulnerability|injection|xss|csrf|secret).{0,10}(?:detect|prevent|scan)/i,
          /(?:permission|sandbox|isolat).{0,10}(?:code|exec)/i,
        ],
        ['security', 'vulnerability', '安全', '漏洞', '权限'],
      ),
    },
    infrastructure: {
      hardware: mk(
        [
          /gpu|tpu|npu|asic|chip|silicon|h100|a100|b200|gb200|mi300/i,
          /(?:nvidia|amd|intel|qualcomm|tsmc|samsung).{0,10}(?:gpu|chip|accelerat)/i,
        ],
        ['hardware', 'gpu', 'chip', '硬件', '芯片', '加速器'],
      ),
      training: mk(
        [
          /train.{0,10}(?:cluster|infra|framework|pipeline)/i,
          /(?:distributed|parallel).{0,10}(?:train|comput)/i,
        ],
        ['training', 'train', '训练', '分布式'],
      ),
      performance: mk(
        [/throughput|latency|token.{0,5}per.{0,5}sec|tflops|benchmark/i, num],
        ['performance', 'throughput', 'latency', '性能', '吞吐', '延迟'],
      ),
      cost: mk(
        [
          /\$[\d,.]+/,
          /(?:cost|price|cheaper|saving).{0,15}\d+/i,
          /(?:energy|power|watt).{0,10}(?:efficien|reduc)/i,
        ],
        ['cost', 'price', 'efficiency', '成本', '效率'],
      ),
      software_stack: mk(
        [
          /pytorch|tensorflow|jax|triton|vllm|tensorrt|cuda|onnx/i,
          /(?:framework|compiler|runtime).{0,10}(?:optim|accelerat)/i,
        ],
        ['software', 'framework', 'stack', '软件栈', '框架'],
      ),
      cloud: mk(
        [
          /aws|azure|gcp|cloud.{0,10}(?:comput|service|deploy)/i,
          /(?:data.?center|server|cluster).{0,10}(?:scale|expand|launch)/i,
        ],
        ['cloud', 'data center', 'server', '云', '数据中心'],
      ),
      edge: mk(
        [
          /edge|mobile|on[- ]?device|embedded|iot|qualcomm|apple.{0,5}silicon/i,
          /(?:local|on[- ]?prem).{0,10}(?:infer|deploy|run)/i,
        ],
        ['edge', 'mobile', 'on-device', '端侧', '边缘'],
      ),
      ops: mk(
        [
          /monitor|observ|reliab|uptime|sla|auto[- ]?scal/i,
          /(?:kubernetes|docker|container).{0,10}(?:deploy|manage|orchestr)/i,
        ],
        ['ops', 'reliability', 'uptime', '运维', '可靠性'],
      ),
    },
    data_eval: {
      data_asset: mk(
        [
          /dataset|corpus|benchmark.{0,10}(?:release|publish|open)/i,
          /\d+[\s,]*(?:sample|record|entry|instance|example)/i,
        ],
        ['dataset', 'data', '数据集', '语料', 'benchmark'],
      ),
      coverage: mk(
        [
          /(?:language|domain|task|category).{0,10}(?:cover|support|include)/i,
          /(?:multilingual|cross[- ]?domain|diverse)/i,
        ],
        ['coverage', 'diverse', 'comprehensive', '覆盖', '多样性'],
      ),
      methodology: mk(
        [
          /metric|methodology|evaluation.{0,10}(?:framework|protocol|approach)/i,
          /(?:novel|new|proposed).{0,10}(?:metric|measure|method)/i,
        ],
        ['methodology', 'metric', 'evaluation', '方法', '指标'],
      ),
      reproducibility: mk(
        [
          /reproducib|open[- ]?source|code.{0,10}available|replicat/i,
          /(?:license|cc[- ]?by|mit|apache).{0,10}(?:data|code)/i,
        ],
        ['reproducible', 'open source', '可复现', '开源'],
      ),
      performance: mk(
        [benchmarkRe, /leaderboard|ranking|comparison/i],
        ['performance', 'leaderboard', 'ranking', '性能', '排行'],
      ),
      quality: mk(
        [
          /(?:annotat|label|curat|clean|filter).{0,10}(?:quality|process|human)/i,
          /(?:noise|bias|error).{0,10}(?:rate|reduc|detect)/i,
        ],
        ['quality', 'annotation', 'curation', '质量', '标注'],
      ),
      governance: mk(
        [
          /(?:license|governance|consent|privacy).{0,10}(?:data|dataset|collect)/i,
          /(?:pir|gdpr|cc[- ]?by|ethical).{0,10}(?:review|approv|complian)/i,
        ],
        ['governance', 'license', 'privacy', '治理', '许可'],
      ),
      decision_value: mk(
        [
          /(?:inform|guide|support).{0,10}(?:decision|policy|strategy)/i,
          /(?:insight|finding|recommendation).{0,10}(?:action|implement)/i,
        ],
        ['decision', 'insight', 'recommendation', '决策', '洞察'],
      ),
    },
    safety_governance: {
      risk_type: mk(
        [
          /(?:jailbreak|prompt.injection|red.team|adversarial|attack|misuse)/i,
          /(?:hallucinat|bias|toxic|misinfo|deepfake).{0,10}(?:risk|threat|concern)/i,
          /(?:privacy|copyright|intellectual.property).{0,16}(?:risk|threat|concern|dispute|issue)/i,
          /(?:提示注入|越狱|幻觉|偏见|隐私|版权).{0,16}(?:风险|威胁|争议|问题)/,
        ],
        ['risk', 'threat', 'vulnerability', '风险', '威胁'],
      ),
      controls: mk(
        [
          /guardrail|filter|safeguard|mitigat|defense|protect/i,
          /(?:rlhf|constitutional|alignment).{0,10}(?:train|technique|method)/i,
        ],
        ['control', 'safeguard', 'mitigation', '控制', '防护'],
      ),
      verification: mk(
        [
          /(?:test|audit|eval|assess).{0,10}(?:safety|risk|vulnerability)/i,
          /(?:red.team|penetration|adversarial).{0,10}(?:test|eval)/i,
        ],
        ['verification', 'audit', 'test', '验证', '审计'],
      ),
      privacy: mk(
        [
          /(?:privacy|pii|personal.data|anonymiz|de[- ]?identif)/i,
          /(?:federat|differential.privacy|encrypt).{0,10}(?:learn|train|process)/i,
        ],
        ['privacy', 'personal data', '隐私', '个人信息'],
      ),
      copyright: mk(
        [
          /(?:copyright|intellectual.property|dmca|fair.use|training.data).{0,10}(?:issue|concern|dispute|license)/i,
          /(?:scrape|crawl|ingest).{0,10}(?:legal|ethical|consent)/i,
        ],
        ['copyright', 'intellectual property', '版权', '知识产权'],
      ),
      regulation: mk(
        [
          /(?:eu.ai.act|executive.order|regulation|legislat|bill|law|policy)/i,
          /(?:china|us|eu|uk).{0,10}(?:ai|regulation|policy|law)/i,
        ],
        ['regulation', 'policy', 'law', '法规', '政策'],
      ),
      framework: mk(
        [
          /(?:governance|framework|standard|guideline|principle).{0,10}(?:ai|establish|propos|adopt)/i,
          /(?:responsible|ethical|trustworthy).{0,10}(?:ai|framework|practice)/i,
        ],
        ['framework', 'governance', 'standard', '框架', '治理'],
      ),
      deployment_impact: mk(
        [
          /(?:incident|breach|harm|damage|lawsuit|fine).{0,10}(?:report|case|example)/i,
          /(?:real.world|production).{0,10}(?:impact|consequence|effect)/i,
        ],
        ['impact', 'incident', 'consequence', '影响', '事件'],
      ),
    },
    applications: {
      industry: mk(
        [
          /(?:healthcare|finance|education|manufacturing|automotive|retail|legal|energy)/i,
          /(?:hospital|bank|school|factory|enterprise).{0,10}(?:use|adopt|deploy)/i,
        ],
        ['industry', 'vertical', '行业', '领域', 'vertical'],
      ),
      business_problem: mk(
        [
          /(?:problem|challenge|pain.point|use.case).{0,10}(?:solv|address|tackl)/i,
          /(?:automat|optimiz|improv|reduc).{0,15}(?:process|cost|time|effort)/i,
          /(?:robotaxi|autonomous.driving|logistics).{0,30}(?:automat|service|deploy)/i,
          /(?:自动驾驶|机器人出租车|物流).{0,30}(?:自动化|服务|部署|落地)/,
        ],
        ['problem', 'solution', 'challenge', '问题', '解决方案'],
      ),
      launch_status: mk(
        [
          /(?:launch|release|live|production|ga|shipping|available).{0,10}(?:now|today|version)/i,
          /(?:production[- ]ready|deployed|deployment|上线|量产)/i,
          /(?:pilot|beta|preview|early.access).{0,10}(?:start|begin|open)/i,
        ],
        ['launch', 'production', 'live', '上线', '发布'],
      ),
      scale: mk(
        [
          /\d+.{0,10}(?:user|customer|company|enterprise|organization)/i,
          /(?:million|billion|thousand).{0,10}(?:user|request|transaction)/i,
        ],
        ['scale', 'user', 'customer', '规模', '用户'],
      ),
      roi: mk(
        [
          /(?:roi|revenue|saving|efficiency|productivity).{0,10}(?:\d+%|increase|decrease|improve)/i,
          /(?:cost|time|effort).{0,10}(?:reduc|sav|cut).{0,10}\d+/i,
        ],
        ['roi', 'revenue', 'saving', '投资回报', '效率'],
      ),
      workflow_change: mk(
        [
          /workflow|process.{0,10}(?:transform|change|redesign|automat)/i,
          /(?:human|employee|worker).{0,10}(?:role|task|job|workflow)/i,
        ],
        ['workflow', 'transformation', 'automate', '工作流', '变革'],
      ),
      replicability: mk(
        [
          /(?:replicat|reproducib|template|playbook|best.practice)/i,
          /(?:case.study|reference|success.story).{0,10}(?:other|similar|adopt)/i,
        ],
        ['replicable', 'template', 'best practice', '可复制', '模板'],
      ),
      risk_responsibility: mk(
        [
          /(?:liability|accountability|responsibility|compliance|insurance)/i,
          /(?:risk|failure|error).{0,10}(?:manage|mitigat|handle)/i,
        ],
        ['risk', 'responsibility', 'compliance', '风险', '责任'],
      ),
    },
    business_ecosystem: {
      business_fact: mk(
        [
          /\$[\d,.]+\s*(?:million|billion|mn|bn)?/,
          /(?:fund|rais|acquir|ipo|revenue|valuation|merger)/i,
        ],
        ['funding', 'revenue', 'acquisition', '融资', '营收', '收购'],
      ),
      entity_market: mk(
        [
          orgRe,
          /(?:market|industry).{0,10}(?:leader|dominant|share|position)/i,
          /(?:startup|unicorn|enterprise).{0,10}(?:name|company)/i,
        ],
        ['company', 'startup', 'enterprise', '公司', '企业'],
      ),
      strategy: mk(
        [
          /(?:strateg|pivot|partnership|alliance|joint.venture|expand)/i,
          /(?:acqui|merger|spin.off|divest)/i,
        ],
        ['strategy', 'partnership', 'expansion', '战略', '合作'],
      ),
      business_model: mk(
        [
          /(?:subscription|saas|freemium|license|marketplace|platform).{0,10}(?:model|revenue|pricing)/i,
          /(?:monetiz|pricing|tier|plan).{0,10}(?:change|update|launch)/i,
        ],
        ['business model', 'monetization', 'pricing', '商业模式', '定价'],
      ),
      market_landscape: mk(
        [
          /(?:market.share|competitive|landscape|ecosystem).{0,10}(?:analyz|report|change)/i,
          /(?:trend|growth|decline).{0,10}\d+/i,
        ],
        ['market', 'competition', 'landscape', '市场', '竞争'],
      ),
      open_source: mk(
        [
          /github.{0,10}(?:star|fork|contributor|repository)/i,
          /(?:open.source|community).{0,10}(?:contribut|grow|maintain)/i,
        ],
        ['open source', 'community', 'contributor', '开源', '社区'],
      ),
      talent: mk(
        [
          /(?:hire|hiring|recruit|talent|layoff|resign|appoint|ceo|cto)/i,
          /(?:team|researcher|engineer).{0,10}(?:join|leave|grow|expand)/i,
        ],
        ['talent', 'hiring', 'team', '人才', '招聘', '团队'],
      ),
      signal: mk(
        [
          /(?:ipo|acquisition|funding|series.[a-f]|seed|valuation).{0,10}(?:announc|report|confirm)/i,
          /(?:partner|invest|deal|contract).{0,10}(?:sign|close|announc)/i,
        ],
        ['signal', 'deal', 'investment', '信号', '交易'],
      ),
    },
  };
}

const DIRECTION_PATTERNS = buildDirectionPatterns();

@Injectable()
export class AiScoringService {
  private readonly logger = new Logger(AiScoringService.name);

  constructor(
    @Inject(CapabilityService)
    private readonly capabilityService: CapabilityService,
    /** Registry is injected by the host after an operator verifies the agent. */
    @Optional()
    @Inject(AGENT_REGISTRY_TOKEN)
    private readonly agentRegistry: AgentRegistry = createAgentRegistry(),
    @Optional()
    @Inject(AGENT_INVOCATION_OPTIONS_TOKEN)
    agentInvocationOptionsInput?: AgentInvocationOptions,
    @Optional()
    @Inject(AGENT_GATEWAY_TOKEN)
    agentGateway?: AgentGateway,
  ) {
    // Keep direct unit construction compatible while production Nest wiring
    // supplies one shared gateway instance through the module token.
    this.agentInvocationOptions = agentInvocationOptionsInput ?? {};
    const gatewayOptions: AgentInvocationOptions =
      agentInvocationOptionsInput !== undefined
        ? this.agentInvocationOptions
        : {
            ...this.agentInvocationOptions,
            adapters: {
              ...(this.agentInvocationOptions.adapters || {}),
              miaoda:
                capabilityService as unknown as AgentInvocationOptions['miaoda'],
            },
          };
    this.agentGateway =
      agentGateway ?? createAgentGateway(agentRegistry, gatewayOptions);
  }

  private readonly agentInvocationOptions: AgentInvocationOptions;
  private readonly agentGateway: AgentGateway;

  async scoreArticle(
    title: string,
    content: string,
    sourceTier: string,
    immutableScoringInput?: string,
  ): Promise<ArticleScoringResult> {
    try {
      return await this.llmScore(
        title,
        content,
        sourceTier,
        immutableScoringInput,
      );
    } catch (error: unknown) {
      const errType =
        error instanceof Error ? error.constructor.name : typeof error;
      const degradeReason = `provider_error:${errType}`;
      this.logger.warn(
        JSON.stringify({
          message: `AI scoring failed for "${title}", falling back to rule-based`,
          pluginInstanceId: SCORING_PLUGIN_INSTANCE_ID,
          actionKey: SCORING_ACTION_KEY,
          outputMode: 'unary',
          inputKeys: ['article_text'],
          errorCode: 'AI_PROVIDER_CALL_FAILED',
        }),
      );
      return this.ruleBasedScoreArticle(
        title,
        content,
        sourceTier,
        degradeReason,
      );
    }
  }

  classifyArticle(
    title: string,
    content: string,
    sourceTier: string,
  ): ArticleClassificationResult {
    try {
      const text = `${title}\n${content}`;
      const candidates: ClassificationCandidate[] = DIRECTIONS.map((dir) => {
        const scored = this.scoreDirectionEvidence(dir, text, sourceTier);
        const eligible = this.hasSufficientDirectionEvidence(
          scored.dimensionScores,
          dir.id,
        );
        return {
          direction: dir.id,
          score: scored.normalizedScore,
          eligible,
          dimensionScores: scored.dimensionScores,
          matchedDimensions: Object.entries(scored.dimensionScores)
            .filter(([, value]) => value >= DIMENSION_FULL)
            .map(([dimension]) => dimension),
          evidence: this.collectClassificationEvidence(text, dir),
        };
      }).filter((candidate) => candidate.score > 0);

      const eligible = candidates
        .filter((candidate) => candidate.eligible)
        .sort((a, b) => b.score - a.score);
      const evidence = eligible.map((candidate) => candidate.direction);
      const top = eligible[0];
      const runnerUp = eligible[1];
      const margin = top && runnerUp ? top.score - runnerUp.score : Infinity;
      const ambiguous = Boolean(top && runnerUp && margin <= 3);

      return {
        primaryDirection: top && !ambiguous ? top.direction : null,
        evidence,
        candidates,
        ambiguous,
        status: ambiguous ? 'ambiguous' : top ? 'classified' : 'no_match',
        degradeReason: null,
      };
    } catch (error: unknown) {
      const reason =
        error instanceof Error
          ? `${error.name}: ${error.message}`
          : String(error);
      this.logger.warn(`Classification degraded for "${title}": ${reason}`);
      return {
        primaryDirection: null,
        evidence: [],
        candidates: [],
        ambiguous: false,
        status: 'degraded',
        degradeReason: reason,
      };
    }
  }

  ruleBasedScoreArticle(
    title: string,
    content: string,
    sourceTier: string,
    degradeReason: string | null = null,
  ): ArticleScoringResult {
    const text = `${title}\n${content}`;
    const directionScores = {} as Record<Direction, DirectionEvidence>;

    for (const dir of DIRECTIONS) {
      directionScores[dir.id] = this.scoreDirectionEvidence(
        dir,
        text,
        sourceTier,
      );
    }

    const { primaryDirection, primaryScore } =
      this.identifyPrimary(directionScores);
    const qualityScore = this.computeGenericQualityScore(text, sourceTier);
    const publishScore = this.computePublishScore(primaryScore, qualityScore);
    const summary = this.generateRuleSummary(title, content);

    const coreEvidencePassed =
      primaryDirection !== null &&
      (directionScores[primaryDirection]?.hasClearEvidence ?? false);

    return {
      summary,
      directionScores,
      primaryDirection,
      primaryScore,
      publishScore,
      coreEvidencePassed,
      aiProcessed: false,
      degradeReason,
    };
  }

  private async llmScore(
    title: string,
    content: string,
    sourceTier: string,
    immutableScoringInput?: string,
  ): Promise<ArticleScoringResult> {
    // Rescoring must use the exact persisted source text. Do not replace it
    // with a summary/title excerpt, otherwise later evidence cannot be traced.
    const articleText = immutableScoringInput?.trim()
      ? immutableScoringInput
      : `${buildScoringInput(title, content)}\n来源层级：${sourceTier}`;

    const input: AiArticleScoringOneInput = { article_text: articleText };
    const invocation = await this.agentGateway.invoke('content_evaluator', {
      input,
    });
    if (invocation.ok !== true) {
      const code = 'code' in invocation ? invocation.code : 'unknown';
      throw new Error(`AI scoring gateway blocked: ${code}`);
    }
    const raw = invocation.output as AiArticleScoringOneOutput;
    const rawResult = raw as AiArticleScoringOneOutput;

    if (!rawResult || typeof rawResult.summary !== 'string') {
      throw new Error('Invalid AI response: missing summary');
    }

    const text = articleText;
    const evidenceByDirection = this.validateAiEvidence(
      rawResult.evidence,
      text,
    );
    const directionScores = {} as Record<Direction, DirectionEvidence>;
    const aiScores = (rawResult.scores ?? {}) as AiDirectionScores;
    if (!this.hasUsableAiScores(aiScores)) {
      throw new Error('Invalid AI response: missing usable direction scores');
    }

    const validatedSummary = this.validateAiSummary(
      rawResult.summary,
      title,
      articleText,
    );
    if (!validatedSummary) {
      throw new Error(
        'Invalid AI response: summary is empty, ungrounded, or exceeds 200 characters',
      );
    }

    const completeAiEvidence = this.hasCompleteAiEvidence(
      aiScores,
      evidenceByDirection,
    );

    for (const dir of DIRECTIONS) {
      const directScores = aiScores[dir.id];
      const legacyDir = this.findLegacyForDirection(dir.id);
      const legacyScores = legacyDir ? aiScores[legacyDir] : null;
      const llmScores = directScores ?? legacyScores;

      if (llmScores && typeof llmScores === 'object') {
        const ruleEvidence = this.scoreDirectionEvidence(dir, text, sourceTier);
        if (directScores) {
          const llmEvidence = this.mapDirectionLlmToEvidence(
            dir,
            llmScores,
            evidenceByDirection[dir.id],
          );
          directionScores[dir.id] = this.combineEvidence(
            llmEvidence,
            ruleEvidence,
            dir,
            sourceTier,
          );
        } else {
          const legacyEvidence = this.mapLegacyLlmToEvidence(llmScores);
          directionScores[dir.id] = {
            normalizedScore: Math.max(
              legacyEvidence.normalizedScore,
              ruleEvidence.normalizedScore,
            ),
            // Score-only legacy responses have no quote to validate. Keep the
            // values for compatibility, but never let them pass a direction
            // gate or become an automatically publishable primary.
            hasClearEvidence: false,
            dimensionScores: {
              ...ruleEvidence.dimensionScores,
              ...legacyEvidence.dimensionScores,
            },
          };
        }
      } else {
        directionScores[dir.id] = this.scoreDirectionEvidence(
          dir,
          text,
          sourceTier,
        );
      }
    }

    if (directionScores['data_eval']) {
      const evalLegacy = aiScores.eval;
      const dataLegacy = aiScores.data;
      if (!aiScores.data_eval && evalLegacy && dataLegacy) {
        const evalEv = this.mapLegacyLlmToEvidence(evalLegacy);
        const dataEv = this.mapLegacyLlmToEvidence(dataLegacy);
        const ruleEv = this.scoreDirectionEvidence(
          DIRECTIONS.find((d) => d.id === 'data_eval')!,
          text,
          sourceTier,
        );
        directionScores['data_eval'] = this.mergeDataEval(
          evalEv,
          dataEv,
          ruleEv,
        );
      }
    }

    const { primaryDirection, primaryScore } =
      this.identifyPrimary(directionScores);
    const qualityScore = this.computeGenericQualityScore(text, sourceTier);
    const publishScore = this.computePublishScore(primaryScore, qualityScore);

    this.logger.log(
      `AI scoring completed for "${title}", primary=${primaryDirection}(${primaryScore}), publish=${publishScore}`,
    );

    const coreEvidencePassed =
      primaryDirection !== null &&
      (directionScores[primaryDirection]?.hasClearEvidence ?? false);

    return {
      summary: validatedSummary,
      directionScores,
      primaryDirection,
      primaryScore,
      publishScore,
      coreEvidencePassed,
      // Keep valid partial evidence for human review, but only mark the AI
      // pass complete when every proposed non-zero score has its own chain.
      aiProcessed: completeAiEvidence,
      degradeReason: completeAiEvidence
        ? null
        : 'incomplete text-grounded evidence chain',
    };
  }

  private scoreDirectionEvidence(
    dir: DirectionMeta,
    text: string,
    sourceTier: string,
  ): DirectionEvidence {
    const patterns = DIRECTION_PATTERNS[dir.id];
    if (!patterns) {
      return {
        normalizedScore: 0,
        hasClearEvidence: false,
        dimensionScores: {},
      };
    }

    const dimensionScores: DimensionScores = {};
    const policy = getDirectionScoringPolicy(dir.id);
    let rawSum = 0;
    let maxRaw = 0;
    let evidenceCount = 0;

    for (const dim of dir.dimensions) {
      const p = patterns[dim];
      if (!p) {
        dimensionScores[dim] = 0;
        continue;
      }
      const score = this.detectEvidence(text, p);
      dimensionScores[dim] = score;
      const weight = policy.weights[dim] ?? 1;
      rawSum += score * weight;
      maxRaw += DIMENSION_FULL * weight;
      if (score > 0) evidenceCount++;
    }

    // Rules keep the pipeline useful when the AI quota is exhausted. The
    // collector separately marks that result as a draft, so regex-only scores
    // cannot pass the publication gate.
    // Classification and publication use the same direction-specific gate;
    // the policy's legacy coreDimensions list is display metadata only.
    const hasClearEvidence = this.hasSufficientDirectionEvidence(
      dimensionScores,
      dir.id,
    );
    const normalizedScore =
      maxRaw > 0 ? Math.round((rawSum / maxRaw) * MAX_DIRECTION_SCORE) : 0;

    const cappedScore =
      !hasClearEvidence || evidenceCount < 2
        ? Math.min(normalizedScore, policy.maxWithoutCoreEvidence)
        : normalizedScore;

    // Keep the rule fallback auditable. The publication gate requires a direct
    // quote for every full-score dimension; without this, quota exhaustion
    // turns every otherwise valid rule result into an invisible draft.
    const evidenceByDimension: Record<string, ScoringEvidence[]> = {};
    const sentences = text
      .split(/[。！？!?\n]+/)
      .map((sentence) => sentence.trim())
      .filter(Boolean);
    for (const dim of dir.dimensions) {
      if ((dimensionScores[dim] ?? 0) < DIMENSION_FULL) continue;
      const dimensionPatterns = patterns[dim];
      const quote = sentences.find(
        (sentence) =>
          !this.hasNegatedOrUncertainContext(sentence) &&
          dimensionPatterns?.strong.some((re) => {
            re.lastIndex = 0;
            return re.test(sentence);
          }),
      );
      if (!quote) continue;
      evidenceByDimension[dim] = [
        {
          direction: dir.id,
          dimension: dim,
          score: DIMENSION_FULL,
          quote,
          subject: dir.name,
          predicate: 'contains rule evidence',
          object: dim,
          certainty: 'fact',
          status: 'rule_verified',
          fields: { source: 'rule', matcher: 'direction_pattern' },
        },
      ];
    }

    return {
      normalizedScore: cappedScore,
      hasClearEvidence,
      dimensionScores,
      evidenceByDimension,
    };
  }

  private detectEvidence(text: string, patterns: EvidencePatterns): number {
    // Evaluate sentence-sized claims so a keyword in an unrelated paragraph
    // cannot complete a direction. Negated, planned, and rumored claims are
    // retained as review hints but never count as strong evidence.
    const sentences = text
      .split(/[。！？!?\n]+/)
      .map((sentence) => sentence.trim())
      .filter(Boolean);
    for (const sentence of sentences) {
      if (this.hasNegatedOrUncertainContext(sentence)) continue;
      if (patterns.strong.some((re) => re.test(sentence)))
        return DIMENSION_FULL;
    }
    const weakMatches = new Set<string>();
    for (const sentence of sentences) {
      if (this.hasNegatedOrUncertainContext(sentence)) continue;
      const lower = sentence.toLowerCase();
      for (const keyword of patterns.weak) {
        if (lower.includes(keyword.toLowerCase())) weakMatches.add(keyword);
      }
    }
    if (weakMatches.size >= 2) return DIMENSION_HALF;
    return 0;
  }

  private collectClassificationEvidence(
    text: string,
    dir: DirectionMeta,
  ): string[] {
    const patterns = DIRECTION_PATTERNS[dir.id];
    return text
      .split(/[。！？!?\n]+/)
      .map((value) => value.trim())
      .filter(
        (sentence) =>
          sentence.length > 0 &&
          !this.hasNegatedOrUncertainContext(sentence) &&
          dir.dimensions.some((dimension) =>
            patterns[dimension]?.strong.some((re) => re.test(sentence)),
          ),
      )
      .slice(0, 3);
  }

  private validateAiEvidence(
    rawEvidence: unknown,
    articleText: string,
  ): Partial<Record<Direction, Record<string, ScoringEvidence[]>>> {
    const validated: Partial<
      Record<Direction, Record<string, ScoringEvidence[]>>
    > = {};
    if (!Array.isArray(rawEvidence)) return validated;

    for (const rawItem of rawEvidence.slice(0, 80)) {
      const item = this.validateEvidenceItem(rawItem, articleText);
      if (!item) continue;
      const byDimension = validated[item.direction] ?? {};
      const items = byDimension[item.dimension] ?? [];
      items.push(item);
      byDimension[item.dimension] = items;
      validated[item.direction] = byDimension;
    }
    return validated;
  }

  private validateAiSummary(
    summary: unknown,
    title: string,
    content: string,
  ): string | null {
    if (typeof summary !== 'string') return null;
    const value = summary.replace(/\s+/g, ' ').trim();
    if (value.length === 0 || value.length > 200 || /```|^\s*[<{[]/.test(value))
      return null;

    const source = `${title}\n${content}`.normalize('NFKC').toLowerCase();
    const hasChineseSource = /[\u3400-\u9fff]/.test(source);
    if (hasChineseSource && !/[\u3400-\u9fff]/.test(value)) return null;
    if (!hasChineseSource && !/[a-z]/i.test(value)) return null;

    // Require multiple literal anchors (or one quantitative anchor). This
    // rejects fluent hallucinations while allowing concise paraphrases.
    const sourceNumbers: string[] =
      source.match(/\b\d+(?:\.\d+)?%?|\$\d+(?:\.\d+)?/g) || [];
    const summaryNumbers: string[] =
      value.toLowerCase().match(/\b\d+(?:\.\d+)?%?|\$\d+(?:\.\d+)?/g) || [];
    if (summaryNumbers.some((number) => sourceNumbers.includes(number)))
      return value;

    const anchors = new Set<string>();
    for (const token of source.match(/[a-z][a-z0-9_-]{2,}/gi) || [])
      anchors.add(token.toLowerCase());
    for (const token of value.match(/[a-z][a-z0-9_-]{2,}/gi) || []) {
      if (anchors.has(token.toLowerCase()))
        anchors.add(`hit:${token.toLowerCase()}`);
    }
    const asciiHits = [...anchors].filter((token) =>
      token.startsWith('hit:'),
    ).length;

    const cjkNgrams = (text: string): Set<string> => {
      const output = new Set<string>();
      for (const run of text.match(/[\u3400-\u9fff]{2,}/g) || []) {
        const chars = [...run];
        for (const size of [2, 3]) {
          for (let index = 0; index <= chars.length - size; index++) {
            output.add(chars.slice(index, index + size).join(''));
          }
        }
      }
      return output;
    };
    const sourceNgrams = cjkNgrams(source);
    const cjkHits = [...cjkNgrams(value)].filter((gram) =>
      sourceNgrams.has(gram),
    ).length;
    return asciiHits + cjkHits >= 2 ? value : null;
  }

  private hasCompleteAiEvidence(
    scores: AiDirectionScores,
    evidenceByDirection: Partial<
      Record<Direction, Record<string, ScoringEvidence[]>>
    >,
  ): boolean {
    let hasAnyNonZero = false;
    for (const [rawDirection, rawValues] of Object.entries(scores)) {
      if (!rawValues || typeof rawValues !== 'object') continue;
      const direction = this.normalizeEvidenceDirection(rawDirection);
      if (!direction) continue;
      const verified = evidenceByDirection[direction] || {};
      for (const [dimension, rawValue] of Object.entries(
        rawValues as Record<string, unknown>,
      )) {
        const proposed = this.clampDirectionScore(rawValue);
        if (proposed === 0) continue;
        hasAnyNonZero = true;
        const evidence = verified[dimension] || [];
        // Planned, rumored, and pending claims remain traceable review
        // signals at 2.5. validateEvidenceItem has already capped them, so
        // they can never serve as a full-evidence proof of deployment.
        if (!evidence.some((item) => item.score >= proposed)) return false;
      }
    }
    // An all-zero, schema-valid response has no unsupported claim to publish.
    return (
      !hasAnyNonZero ||
      Object.values(evidenceByDirection).some(
        (value) => value && Object.keys(value).length > 0,
      )
    );
  }

  private validateEvidenceItem(
    rawItem: unknown,
    articleText: string,
  ): ScoringEvidence | null {
    if (!rawItem || typeof rawItem !== 'object') return null;
    const raw = rawItem as Record<string, unknown>;
    const direction = this.normalizeEvidenceDirection(raw.direction);
    if (!direction || typeof raw.dimension !== 'string') return null;

    const meta = DIRECTIONS.find((item) => item.id === direction);
    if (!meta || !meta.dimensions.includes(raw.dimension)) return null;

    const proposedScore = this.clampDirectionScore(raw.score);
    const quote = this.readEvidenceText(raw.quote, 280);
    const subject = this.readEvidenceText(raw.subject, 160);
    const predicate = this.readEvidenceText(raw.predicate, 160);
    const object = this.readEvidenceText(raw.object, 240);
    const certainty = this.readEvidenceCertainty(raw.certainty);
    const fields = this.readEvidenceFields(raw.fields);

    // Evidence must be literally traceable to the submitted article, not an
    // AI-generated paraphrase. A missing claim tuple cannot establish a fact.
    if (
      !proposedScore ||
      !quote ||
      !articleText.includes(quote) ||
      !subject ||
      !predicate ||
      !object ||
      !certainty ||
      !fields
    ) {
      return null;
    }

    const quoteIndex = articleText.indexOf(quote);
    const context = articleText.slice(
      Math.max(0, quoteIndex - 24),
      Math.min(articleText.length, quoteIndex + quote.length + 24),
    );
    const isUncertain =
      certainty === 'planned' ||
      certainty === 'claimed' ||
      certainty === 'rumor' ||
      this.hasNegatedOrUncertainContext(context);
    const hasClaimTupleInQuote = this.claimTupleMatchesQuote(
      quote,
      subject,
      predicate,
      object,
    );
    const score =
      proposedScore === DIMENSION_FULL &&
      (!hasClaimTupleInQuote ||
        !this.hasRequiredEvidenceFields(
          direction,
          raw.dimension,
          fields,
          quote,
        ) ||
        isUncertain)
        ? DIMENSION_HALF
        : proposedScore;

    return {
      direction,
      dimension: raw.dimension,
      score,
      quote,
      subject,
      predicate,
      object,
      certainty,
      status:
        typeof raw.status === 'string' ? raw.status.slice(0, 80) : undefined,
      fields,
    };
  }

  private normalizeEvidenceDirection(value: unknown): Direction | null {
    if (typeof value !== 'string') return null;
    if (ALL_DIRECTION_IDS.includes(value as Direction))
      return value as Direction;
    return LEGACY_DIRECTION_MAP[value] ?? null;
  }

  private readEvidenceText(value: unknown, maxLength: number): string | null {
    if (typeof value !== 'string') return null;
    const text = value.trim();
    return text.length > 0 && text.length <= maxLength ? text : null;
  }

  private readEvidenceCertainty(value: unknown): EvidenceCertainty | null {
    return value === 'fact' ||
      value === 'announced' ||
      value === 'planned' ||
      value === 'claimed' ||
      value === 'rumor'
      ? value
      : null;
  }

  private readEvidenceFields(value: unknown): Record<string, unknown> | null {
    if (!value || typeof value !== 'object' || Array.isArray(value))
      return null;
    const entries = Object.entries(value as Record<string, unknown>).filter(
      ([key, fieldValue]) =>
        key.length > 0 &&
        key.length <= 64 &&
        (typeof fieldValue === 'string' ||
          typeof fieldValue === 'number' ||
          typeof fieldValue === 'boolean' ||
          Array.isArray(fieldValue)),
    );
    return entries.length > 0 ? Object.fromEntries(entries) : null;
  }

  private hasNegatedOrUncertainContext(context: string): boolean {
    return /\b(?:not|no|without|never|failed|unavailable|rumored|rumour|pending|intent(?:s|ion)?|intend(?:s|ed)?|plans?\s+to|will|shall|may|might|could|preview|demo|not\s+deployed|to\s+be\s+deployed)\b|未|没有|尚未|待|等待|计划|拟|预计|(?<!已)将|意图|打算|传闻|据称|可能|预览|演示|尚未部署/i.test(
      context,
    );
  }

  private claimTupleMatchesQuote(
    quote: string,
    subject: string,
    predicate: string,
    object: string,
  ): boolean {
    const normalizedQuote = this.normalizeEvidenceText(quote);
    return [subject, predicate, object].every((value) => {
      const normalizedValue = this.normalizeEvidenceText(value);
      // Chinese single-character function words such as "为" are valid
      // predicates in a structured fact; do not reject their evidence solely
      // because an English-oriented minimum length would be two characters.
      return (
        normalizedValue.length >= 1 && normalizedQuote.includes(normalizedValue)
      );
    });
  }

  private normalizeEvidenceText(value: string): string {
    return value.toLowerCase().replace(/[\s\p{P}\p{S}]/gu, '');
  }

  private hasRequiredEvidenceFields(
    direction: Direction,
    dimension: string,
    fields: Record<string, unknown>,
    quote: string,
  ): boolean {
    const present = (...keys: string[]) =>
      keys.every((key) => {
        const value = fields[key];
        return value !== undefined && value !== null && value !== '';
      });
    const oneOf = (...keys: string[]) =>
      keys.some((key) => {
        const value = fields[key];
        return value !== undefined && value !== null && value !== '';
      });

    const requirement = getDirectionEvidenceRequirement(direction, dimension);
    if (!requirement || !present(...requirement.required)) {
      return false;
    }

    // Every required fact needs a literal source span. A direction can choose
    // one alternative supporting fact, but it must also be present in the
    // quote; a made-up metric, amount, version, or deployment scope cannot
    // complete a five-point score.
    if (
      !requirement.required.every((key) =>
        this.fieldValueMatchesQuote(key, fields[key], quote),
      )
    ) {
      return false;
    }
    if (
      requirement.oneOf &&
      (!oneOf(...requirement.oneOf) ||
        !requirement.oneOf.some(
          (key) =>
            fields[key] !== undefined &&
            fields[key] !== null &&
            fields[key] !== '' &&
            this.fieldValueMatchesQuote(key, fields[key], quote),
        ))
    ) {
      return false;
    }

    if (dimension === 'modality_coverage') {
      const modalities = fields.modalities;
      if (!Array.isArray(modalities) || new Set(modalities).size < 2)
        return false;
    }

    return true;
  }

  private fieldValueMatchesQuote(
    key: string,
    value: unknown,
    quote: string,
  ): boolean {
    if (Array.isArray(value)) {
      return (
        value.length > 0 &&
        value.every((item) => this.fieldValueMatchesQuote(key, item, quote))
      );
    }
    if (typeof value !== 'string' && typeof value !== 'number') return false;
    const rawValue = String(value).trim();
    if (!rawValue) return false;

    // Status values may be normalized for the database, while their source
    // text remains Chinese or a different product vocabulary.
    if (key === 'status') {
      const statusPatterns: Record<string, RegExp> = {
        deployed: /deploy|部署|上线|量产|投产|生产/,
        production: /production|生产|量产/,
        ga: /\bga\b|正式发布|全面上线/,
        pilot: /pilot|试点/,
        completed: /complete|完成/,
        signed: /sign|签署/,
      };
      const pattern = statusPatterns[rawValue.toLowerCase()];
      if (pattern?.test(quote)) return true;
    }

    // Preserve unit-only values such as "%" or "$" that are removed by
    // punctuation normalization but are still direct quantitative evidence.
    if (/^[^\p{L}\p{N}]+$/u.test(rawValue)) return quote.includes(rawValue);
    const normalizedValue = this.normalizeEvidenceText(rawValue);
    return (
      normalizedValue.length > 0 &&
      this.normalizeEvidenceText(quote).includes(normalizedValue)
    );
  }

  private scoreFromVerifiedEvidence(
    proposedScore: number,
    evidence: ScoringEvidence[],
  ): number {
    if (proposedScore === 0 || evidence.length === 0) return 0;
    const bestEvidence = Math.max(...evidence.map((item) => item.score));
    return Math.min(proposedScore, bestEvidence);
  }

  private mapDirectionLlmToEvidence(
    dir: DirectionMeta,
    llmScores: Record<string, unknown>,
    verifiedEvidence: Record<string, ScoringEvidence[]> = {},
  ): DirectionEvidence {
    const dimensionScores: DimensionScores = {};
    const policy = getDirectionScoringPolicy(dir.id);
    let rawSum = 0;
    let maxRaw = 0;

    for (const dimension of dir.dimensions) {
      const value = this.clampDirectionScore(llmScores[dimension]);
      const evidence = verifiedEvidence[dimension] ?? [];
      // AI scores are proposals. A non-zero value becomes effective only when
      // the response supplies a text-grounded evidence item for this dimension.
      const verifiedScore = this.scoreFromVerifiedEvidence(value, evidence);
      dimensionScores[dimension] = verifiedScore;
      const weight = policy.weights[dimension] ?? 1;
      rawSum += verifiedScore * weight;
      maxRaw += DIMENSION_FULL * weight;
    }

    const hasClearEvidence = this.hasSufficientDirectionEvidence(
      dimensionScores,
      dir.id,
    );
    const normalizedScore =
      maxRaw > 0 ? Math.round((rawSum / maxRaw) * MAX_DIRECTION_SCORE) : 0;

    return {
      normalizedScore: hasClearEvidence
        ? normalizedScore
        : Math.min(normalizedScore, policy.maxWithoutCoreEvidence),
      hasClearEvidence,
      dimensionScores,
      evidenceByDimension: verifiedEvidence,
    };
  }

  private mapLegacyLlmToEvidence(
    llmScores: Record<string, unknown>,
  ): DirectionEvidence {
    const dims: DimensionScores = {};
    const oldDimKeys = [
      'novelty',
      'depth',
      'impact',
      'authority',
      'timeliness',
    ];
    let rawSum = 0;

    for (const key of oldDimKeys) {
      const val = this.clampLlmScore(llmScores[key]);
      let mapped: number;
      if (val >= 14) mapped = DIMENSION_FULL;
      else if (val >= 7) mapped = DIMENSION_HALF;
      else mapped = 0;
      dims[key] = mapped;
      rawSum += mapped;
    }

    // Older score-only plugin responses cannot prove their own claims. Keep
    // their values for review compatibility, but never let them pass a gate.
    const hasClearEvidence = false;
    const maxRaw = oldDimKeys.length * DIMENSION_FULL;
    const normalizedScore = Math.round((rawSum / maxRaw) * MAX_DIRECTION_SCORE);

    return { normalizedScore, hasClearEvidence, dimensionScores: dims };
  }

  private clampLlmScore(value: unknown): number {
    if (typeof value !== 'number' || Number.isNaN(value)) return 0;
    return Math.max(0, Math.min(20, Math.round(value)));
  }

  private clampDirectionScore(value: unknown): number {
    if (typeof value !== 'number' || !Number.isFinite(value)) return 0;
    return value === 0 || value === DIMENSION_HALF || value === DIMENSION_FULL
      ? value
      : 0;
  }

  private hasUsableAiScores(scores: AiDirectionScores): boolean {
    const recognized = new Set<string>([
      ...ALL_DIRECTION_IDS,
      ...Object.keys(LEGACY_DIRECTION_MAP),
    ]);
    return Object.entries(scores).some(([direction, values]) => {
      if (!recognized.has(direction) || !values || typeof values !== 'object') {
        return false;
      }
      return Object.values(values as Record<string, unknown>).some(
        (value) => typeof value === 'number' && Number.isFinite(value),
      );
    });
  }

  private combineEvidence(
    llm: DirectionEvidence,
    rule: DirectionEvidence,
    dir: DirectionMeta,
    sourceTier: string,
  ): DirectionEvidence {
    const merged: DimensionScores = { ...llm.dimensionScores };
    for (const dimension of dir.dimensions) {
      // A regex hit may fill a missing AI assessment as a review signal, but
      // it cannot upgrade a verified AI score.
      if ((merged[dimension] ?? 0) === 0) {
        merged[dimension] = Math.min(
          rule.dimensionScores[dimension] ?? 0,
          DIMENSION_HALF,
        );
      }
    }

    const policy = getDirectionScoringPolicy(dir.id);
    const maxRaw = dir.dimensions.reduce(
      (sum, dimension) =>
        sum + DIMENSION_FULL * (policy.weights[dimension] ?? 1),
      0,
    );
    let rawSum = 0;
    for (const dim of dir.dimensions) {
      rawSum += (merged[dim] ?? 0) * (policy.weights[dim] ?? 1);
    }
    // A primary direction must be grounded in validated AI evidence. Rule
    // fallback values may broaden review information but cannot satisfy it.
    const hasClearEvidence = this.hasSufficientDirectionEvidence(
      llm.dimensionScores,
      dir.id,
    );
    const normalizedScore =
      maxRaw > 0 ? Math.round((rawSum / maxRaw) * MAX_DIRECTION_SCORE) : 0;
    const cappedScore = !hasClearEvidence
      ? Math.min(normalizedScore, policy.maxWithoutCoreEvidence)
      : normalizedScore;

    return {
      normalizedScore: cappedScore,
      hasClearEvidence,
      dimensionScores: merged,
      evidenceByDimension: llm.evidenceByDimension,
    };
  }

  private mergeDataEval(
    evalEv: DirectionEvidence,
    dataEv: DirectionEvidence,
    ruleEv: DirectionEvidence,
  ): DirectionEvidence {
    const merged: DimensionScores = { ...ruleEv.dimensionScores };
    for (const [k, v] of Object.entries(evalEv.dimensionScores)) {
      merged[k] = Math.max(merged[k] ?? 0, v);
    }
    for (const [k, v] of Object.entries(dataEv.dimensionScores)) {
      merged[k] = Math.max(merged[k] ?? 0, v);
    }
    const dir = DIRECTIONS.find((d) => d.id === 'data_eval')!;
    const policy = getDirectionScoringPolicy('data_eval');
    const maxRaw = dir.dimensions.reduce(
      (sum, dimension) =>
        sum + DIMENSION_FULL * (policy.weights[dimension] ?? 1),
      0,
    );
    let rawSum = 0;
    for (const dim of dir.dimensions) {
      rawSum += (merged[dim] ?? 0) * (policy.weights[dim] ?? 1);
    }
    // Legacy eval/data scores are retained for display only; without verified
    // evidence they must not satisfy the new data/evaluation gate.
    const hasClearEvidence = false;
    const normalizedScore = Math.max(
      evalEv.normalizedScore,
      dataEv.normalizedScore,
      ruleEv.normalizedScore,
      maxRaw > 0 ? Math.round((rawSum / maxRaw) * MAX_DIRECTION_SCORE) : 0,
    );
    const cappedScore = !hasClearEvidence
      ? Math.min(normalizedScore, policy.maxWithoutCoreEvidence)
      : normalizedScore;
    return {
      normalizedScore: cappedScore,
      hasClearEvidence,
      dimensionScores: merged,
    };
  }

  private identifyPrimary(scores: Record<Direction, DirectionEvidence>): {
    primaryDirection: Direction | null;
    primaryScore: number;
  } {
    let best: Direction | null = null;
    let bestScore = 0;

    for (const dir of ALL_DIRECTION_IDS) {
      const ev = scores[dir];
      // A direction is not primary unless one of its own core dimensions has
      // strong evidence. This prevents generic words such as "AI", "API", or
      // an organization name from turning unrelated articles into model news.
      if (ev && ev.hasClearEvidence && ev.normalizedScore > bestScore) {
        bestScore = ev.normalizedScore;
        best = dir;
      }
    }

    if (bestScore < 10) return { primaryDirection: null, primaryScore: 0 };
    return { primaryDirection: best, primaryScore: bestScore };
  }

  private hasSufficientDirectionEvidence(
    dimensionScores: DimensionScores,
    direction: Direction,
  ): boolean {
    return hasSufficientDirectionEvidence(direction, dimensionScores);
  }

  private computePublishScore(
    primaryScore: number,
    quality: GenericQualityScore,
  ): number {
    // Direction evidence supplies 80% of the final score. Source tier and
    // generic prose signals may improve publication confidence, not direction.
    return Math.round(Math.min(100, primaryScore * 2 + quality.total));
  }

  private computeGenericQualityScore(
    text: string,
    sourceTier: string,
  ): GenericQualityScore {
    const sourceCredibility = Math.min(
      10,
      Math.round((SOURCE_TIER_POINTS[sourceTier] ?? 8) / 2),
    );
    const verifiability = this.computeVerifiability(text);
    const completeness = Math.min(4, Math.floor(text.length / 1200));
    const impactSignal = this.computeImpact(text);
    return {
      sourceCredibility,
      verifiability,
      completeness,
      impactSignal,
      total: sourceCredibility + verifiability + completeness + impactSignal,
    };
  }

  private computeVerifiability(text: string): number {
    let points = 0;
    if (NUMBER_RE.test(text)) points += 4;
    if (ORG_NAMES.some((org) => text.toLowerCase().includes(org))) points += 3;
    const urlMatches = text.match(/https?:\/\/[^\s)]+/g);
    if (urlMatches && urlMatches.length > 0) points += 3;
    return Math.min(6, points);
  }

  private computeImpact(text: string): number {
    const lower = text.toLowerCase();
    const impactTerms = [
      'impact',
      'significant',
      'breakthrough',
      'revolutionary',
      'game-changer',
      'first',
      'record',
      '重大',
      '突破',
      '首次',
      '里程碑',
      'milestone',
      'industry-first',
    ];
    const matches = impactTerms.filter((t) => lower.includes(t)).length;
    return Math.min(4, matches * 2);
  }

  private findLegacyForDirection(dir: Direction): AiPluginDirection | null {
    for (const [legacy, mapped] of Object.entries(AI_PLUGIN_TO_NEW)) {
      if (mapped === dir) return legacy as AiPluginDirection;
    }
    return null;
  }

  private generateRuleSummary(title: string, content: string): string {
    const sentences = content
      .replace(/\n+/g, ' ')
      .split(/[。！？.!?]/)
      .filter((s: string) => s.trim().length > 10);
    if (sentences.length === 0) {
      const fallback = `${title || ''}`.trim();
      return fallback.slice(0, 200) || '原文未提供可用摘要';
    }
    const excerpt = sentences.slice(0, 2).join('。').trim();
    return excerpt.length > 200 ? `${excerpt.slice(0, 200)}...` : excerpt;
  }
}
