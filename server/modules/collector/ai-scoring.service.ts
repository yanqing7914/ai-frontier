import { Injectable, Inject, Logger } from '@nestjs/common';
import { CapabilityService } from '@lark-apaas/fullstack-nestjs-core';
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
  getDirectionScoringPolicy,
  type Direction,
  type DirectionMeta,
} from '@shared/directions';
import type { DimensionScores } from '@shared/api.interface';

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
          /outperform|surpass|achieve|state.of.the.art|sota/i,
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
          /multi[- ]?step|complex\s+task|end[- ]?to[- ]?end/i,
          /(?:plan|reason|execute).{0,20}(?:autonom|independ)/i,
        ],
        ['task', 'autonomous', 'planning', '任务', '自主', '规划'],
      ),
      tool_call: mk(
        [
          /function\s+call|tool[- ]?(?:use|call)|mcp|a2a/i,
          /(?:api|browser|terminal|database).{0,10}(?:tool|access)/i,
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
          /multi[- ]?agent|workflow|orchestrat|coordinat/i,
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
          /production|enterprise|deploy|reliab|guardrail/i,
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
          /code\s+generat|copilot|autocomplet|code\s+assist/i,
          /(?:function|class|module).{0,10}(?:generat|complet|suggest)/i,
        ],
        ['code generation', 'coding', '代码生成', '编程'],
      ),
      repo_understanding: mk(
        [
          /repo|repository|codebase|cross[- ]?file|project[- ]?(?:level|wide)/i,
          /(?:understand|analyz|index).{0,10}(?:code|repo)/i,
        ],
        ['repository', 'codebase', '仓库', '代码库', '理解'],
      ),
      engineering: mk(
        [
          /(?:refactor|debug|fix|test|migrate|deploy).{0,10}(?:code|bug|issue)/i,
          /(?:ci|cd|pipeline|build).{0,10}(?:automat|integrat)/i,
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
  ) {}

  async scoreArticle(
    title: string,
    content: string,
    sourceTier: string,
  ): Promise<ArticleScoringResult> {
    try {
      return await this.llmScore(title, content, sourceTier);
    } catch (error: unknown) {
      const errType =
        error instanceof Error ? error.constructor.name : typeof error;
      const errMsg = error instanceof Error ? error.message : String(error);
      const errStack =
        error instanceof Error && error.stack ? error.stack.slice(0, 500) : '';
      const degradeReason = `[${errType}] ${errMsg}${errStack ? '\n' + errStack : ''}`;
      this.logger.warn(
        JSON.stringify({
          message: `AI scoring failed for "${title}", falling back to rule-based`,
          pluginInstanceId: SCORING_PLUGIN_INSTANCE_ID,
          actionKey: SCORING_ACTION_KEY,
          outputMode: 'unary',
          inputKeys: ['article_text'],
          error: degradeReason,
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
  ): { primaryDirection: Direction | null; evidence: string[] } {
    const text = `${title}\n${content}`;
    const evidence: string[] = [];
    const directionScores = {} as Record<Direction, DirectionEvidence>;

    for (const dir of DIRECTIONS) {
      directionScores[dir.id] = this.scoreDirectionEvidence(
        dir,
        text,
        sourceTier,
      );
      if (directionScores[dir.id].hasClearEvidence) {
        evidence.push(dir.id);
      }
    }

    const { primaryDirection } = this.identifyPrimary(directionScores);
    return { primaryDirection, evidence };
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
  ): Promise<ArticleScoringResult> {
    const contentExcerpt =
      content.length > 3000 ? content.slice(0, 3000) : content;
    const articleText = [
      `标题：${title}`,
      `来源层级：${sourceTier}`,
      `内容：${contentExcerpt}`,
    ].join('\n');

    const input: AiArticleScoringOneInput = { article_text: articleText };
    const pluginCall = this.capabilityService.load(SCORING_PLUGIN_INSTANCE_ID);
    const raw = await pluginCall.call(SCORING_ACTION_KEY, input);
    const rawResult = raw as AiArticleScoringOneOutput;

    if (!rawResult || typeof rawResult.summary !== 'string') {
      throw new Error('Invalid AI response: missing summary');
    }

    const text = `${title}\n${content}`;
    const directionScores = {} as Record<Direction, DirectionEvidence>;
    const aiScores = (rawResult.scores ?? {}) as AiDirectionScores;
    if (!this.hasUsableAiScores(aiScores)) {
      throw new Error('Invalid AI response: missing usable direction scores');
    }

    for (const dir of DIRECTIONS) {
      const directScores = aiScores[dir.id];
      const legacyDir = this.findLegacyForDirection(dir.id);
      const legacyScores = legacyDir ? aiScores[legacyDir] : null;
      const llmScores = directScores ?? legacyScores;

      if (llmScores && typeof llmScores === 'object') {
        const ruleEvidence = this.scoreDirectionEvidence(dir, text, sourceTier);
        if (directScores) {
          const llmEvidence = this.mapDirectionLlmToEvidence(dir, llmScores);
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
            hasClearEvidence:
              legacyEvidence.hasClearEvidence || ruleEvidence.hasClearEvidence,
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
      summary: rawResult.summary,
      directionScores,
      primaryDirection,
      primaryScore,
      publishScore,
      coreEvidencePassed,
      aiProcessed: true,
      degradeReason: null,
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
    let coreEvidenceCount = 0;
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
      if (policy.coreDimensions.includes(dim) && score >= DIMENSION_FULL) {
        coreEvidenceCount++;
      }
    }

    const hasClearEvidence =
      coreEvidenceCount >= policy.minCoreEvidence &&
      evidenceCount >= policy.minEvidenceDimensions;
    const normalizedScore =
      maxRaw > 0 ? Math.round((rawSum / maxRaw) * MAX_DIRECTION_SCORE) : 0;

    const cappedScore = !hasClearEvidence || evidenceCount < 2
      ? Math.min(normalizedScore, policy.maxWithoutCoreEvidence)
      : normalizedScore;

    return { normalizedScore: cappedScore, hasClearEvidence, dimensionScores };
  }

  private detectEvidence(text: string, patterns: EvidencePatterns): number {
    for (const re of patterns.strong) {
      if (re.test(text)) return DIMENSION_FULL;
    }
    const lower = text.toLowerCase();
    const weakMatches = patterns.weak.filter((kw) => lower.includes(kw)).length;
    if (weakMatches >= 2) return DIMENSION_HALF;
    return 0;
  }

  private mapDirectionLlmToEvidence(
    dir: DirectionMeta,
    llmScores: Record<string, unknown>,
  ): DirectionEvidence {
    const dimensionScores: DimensionScores = {};
    const policy = getDirectionScoringPolicy(dir.id);
    let rawSum = 0;
    let maxRaw = 0;

    for (const dimension of dir.dimensions) {
      const value = this.clampDirectionScore(llmScores[dimension]);
      dimensionScores[dimension] = value;
      const weight = policy.weights[dimension] ?? 1;
      rawSum += value * weight;
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

    const hasClearEvidence = rawSum >= DIMENSION_FULL * 2;
    const maxRaw = oldDimKeys.length * DIMENSION_FULL;
    const normalizedScore = Math.round((rawSum / maxRaw) * MAX_DIRECTION_SCORE);

    return { normalizedScore, hasClearEvidence, dimensionScores: dims };
  }

  private clampLlmScore(value: unknown): number {
    if (typeof value !== 'number' || Number.isNaN(value)) return 0;
    return Math.max(0, Math.min(20, Math.round(value)));
  }

  private clampDirectionScore(value: unknown): number {
    if (typeof value !== 'number' || Number.isNaN(value)) return 0;
    return Math.max(
      0,
      Math.min(DIMENSION_FULL, Math.round(value * 2) / 2),
    );
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
    const merged: DimensionScores = { ...rule.dimensionScores };
    for (const [k, v] of Object.entries(llm.dimensionScores)) {
      merged[k] = Math.max(merged[k] ?? 0, v);
    }

    const policy = getDirectionScoringPolicy(dir.id);
    const maxRaw = dir.dimensions.reduce(
      (sum, dimension) => sum + DIMENSION_FULL * (policy.weights[dimension] ?? 1),
      0,
    );
    let rawSum = 0;
    for (const dim of dir.dimensions) {
      rawSum += (merged[dim] ?? 0) * (policy.weights[dim] ?? 1);
    }
    const hasClearEvidence = this.hasSufficientDirectionEvidence(merged, dir.id);
    const normalizedScore =
      maxRaw > 0 ? Math.round((rawSum / maxRaw) * MAX_DIRECTION_SCORE) : 0;
    const cappedScore = !hasClearEvidence
      ? Math.min(normalizedScore, policy.maxWithoutCoreEvidence)
      : normalizedScore;

    return {
      normalizedScore: cappedScore,
      hasClearEvidence,
      dimensionScores: merged,
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
      (sum, dimension) => sum + DIMENSION_FULL * (policy.weights[dimension] ?? 1),
      0,
    );
    let rawSum = 0;
    for (const dim of dir.dimensions) {
      rawSum += (merged[dim] ?? 0) * (policy.weights[dim] ?? 1);
    }
    const hasClearEvidence = this.hasSufficientDirectionEvidence(
      merged,
      'data_eval',
    );
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
    const policy = getDirectionScoringPolicy(direction);
    const coreEvidenceCount = policy.coreDimensions.filter(
      (dimension) => (dimensionScores[dimension] ?? 0) >= DIMENSION_FULL,
    ).length;
    const evidenceCount = Object.values(dimensionScores).filter(
      (value) => value > 0,
    ).length;
    return coreEvidenceCount >= policy.minCoreEvidence
      && evidenceCount >= policy.minEvidenceDimensions;
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
    const sourceCredibility = Math.min(10, Math.round(
      (SOURCE_TIER_POINTS[sourceTier] ?? 8) / 2,
    ));
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
    if (sentences.length === 0) return title;
    const excerpt = sentences.slice(0, 2).join('。').trim();
    return excerpt.length > 200 ? `${excerpt.slice(0, 200)}...` : excerpt;
  }
}
