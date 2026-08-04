import { Injectable, Inject, Logger } from '@nestjs/common';
import { CapabilityService } from '@lark-apaas/fullstack-nestjs-core';
import type {
  AiArticleScoringOneInput,
  AiArticleScoringOneOutput,
} from '@shared/plugin-types';

type ScoringDirection =
  | 'model' | 'agent' | 'multimodal' | 'coding'
  | 'infrastructure' | 'data_eval' | 'safety_governance'
  | 'applications' | 'business_ecosystem';

type AiPluginDirection =
  | 'agent' | 'model' | 'coding' | 'multi'
  | 'eval' | 'infra' | 'data' | 'security';

interface DirectionScores {
  novelty: number;
  depth: number;
  impact: number;
  authority: number;
  timeliness: number;
}

type AllDirectionScores = Record<ScoringDirection, DirectionScores>;

/** AI 打分结果 */
export interface ArticleScoringResult {
  summary: string;
  scores: Record<string, DirectionScores>;
  aiProcessed: boolean;
  degradeReason: string | null;
}

const SCORING_PLUGIN_INSTANCE_ID = 'ai_article_scoring_1';
const SCORING_ACTION_KEY = 'textToJson';

const ALL_DIRECTIONS: ScoringDirection[] = [
  'model', 'agent', 'multimodal', 'coding',
  'infrastructure', 'data_eval', 'safety_governance',
  'applications', 'business_ecosystem',
];

const AI_PLUGIN_TO_NEW: Record<AiPluginDirection, ScoringDirection> = {
  model: 'model',
  agent: 'agent',
  coding: 'coding',
  multi: 'multimodal',
  eval: 'data_eval',
  infra: 'infrastructure',
  data: 'data_eval',
  security: 'safety_governance',
};

const EMPTY_DIRECTION_SCORES: DirectionScores = {
  novelty: 0,
  depth: 0,
  impact: 0,
  authority: 0,
  timeliness: 0,
};

/**
 * 各方向关键词映射，用于规则降级打分
 */
const DIRECTION_KEYWORDS: Record<ScoringDirection, string[]> = {
  model: [
    'llm', '大模型', 'gpt', 'claude', 'gemini', 'llama',
    'transformer', 'fine-tun', 'pretrain', 'pre-train',
    'foundation model', '语言模型', 'language model', 'scaling',
  ],
  agent: [
    'agent', 'agents', '智能体', 'autonomous', 'agentic',
    'tool use', 'tool-use', 'function calling', 'multi-agent',
    'planning', 'reasoning agent', 'agentic workflow',
  ],
  multimodal: [
    'multimodal', '多模态', 'vision', 'image', '视频',
    'audio', 'speech', '图文', 'visual', '图片理解',
    'image generation', '图像生成', '文生图', '图生图',
  ],
  coding: [
    'coding', 'code gen', 'copilot', '编程', '代码生成',
    'ide', 'developer tool', '代码补全', 'code completion',
    'debugging', 'refactor', '代码审查', 'code review',
  ],
  infrastructure: [
    'infrastructure', '基础设施', 'training cluster',
    '推理加速', 'inference', 'deployment', '部署',
    'gpu', 'tpu', '芯片', 'chip', '分布式', 'distributed',
    'kubernetes', 'serving', '推理框架',
  ],
  data_eval: [
    'benchmark', '评测', '评估', 'evaluation', 'leaderboard',
    '排行榜', 'mmlu', 'humaneval', '测试集', 'metric',
    'data', '数据集', 'dataset', '数据标注', 'annotation',
    '数据清洗', 'data pipeline', '数据治理', 'embedding',
  ],
  safety_governance: [
    'security', '安全', 'alignment', '对齐', 'red team',
    'jailbreak', '越狱', 'guardrail', '护栏', '隐私',
    'privacy', 'toxicity', '有害', '合规', 'compliance',
    'governance', '治理', 'policy', 'regulation',
  ],
  applications: [
    'application', '应用', 'product', '产品', 'enterprise',
    '企业', 'saas', 'workflow', 'integration', '集成',
    'platform', '平台', 'solution', '解决方案',
  ],
  business_ecosystem: [
    'funding', '融资', 'acquisition', '收购', 'ipo',
    'market', '市场', 'revenue', '营收', 'valuation',
    '估值', 'partnership', '合作', 'ecosystem', '生态',
  ],
};

/**
 * 来源层级权重，用于规则打分时调整权威性维度
 */
const SOURCE_TIER_AUTHORITY: Record<string, number> = {
  top: 16,
  high: 13,
  medium: 10,
  low: 6,
};

@Injectable()
export class AiScoringService {
  private readonly logger = new Logger(AiScoringService.name);

  constructor(
    @Inject(CapabilityService)
    private readonly capabilityService: CapabilityService,
  ) {}

  /**
   * 对文章进行 AI 打分，失败时降级为规则打分
   */
  async scoreArticle(
    title: string,
    content: string,
    sourceTier: string,
  ): Promise<ArticleScoringResult> {
    try {
      return await this.aiScore(title, content, sourceTier);
    } catch (error: unknown) {
      const errType = error instanceof Error ? error.constructor.name : typeof error;
      const errMsg = error instanceof Error ? error.message : String(error);
      const errStack = error instanceof Error && error.stack
        ? error.stack.slice(0, 500)
        : '';
      const degradeReason = `[${errType}] ${errMsg}${errStack ? '\n' + errStack : ''}`;
      this.logger.warn(
        `AI scoring failed for "${title}", falling back to rule-based: ${degradeReason}`,
      );
      const fallback = this.ruleBasedScore(title, content, sourceTier);
      return { ...fallback, degradeReason };
    }
  }

  /**
   * 调用 AI 插件进行打分
   */
  private async aiScore(
    title: string,
    content: string,
    sourceTier: string,
  ): Promise<ArticleScoringResult> {
    const contentExcerpt = content.length > 3000
      ? content.slice(0, 3000)
      : content;

    const articleText = [
      `标题：${title}`,
      `来源层级：${sourceTier}`,
      `内容：${contentExcerpt}`,
    ].join('\n');

    const input: AiArticleScoringOneInput = {
      article_text: articleText,
    };

    const pluginCall = this.capabilityService
      .load(SCORING_PLUGIN_INSTANCE_ID);
    const raw = await pluginCall.call(
      SCORING_ACTION_KEY,
      input,
    );
    const rawResult = raw as AiArticleScoringOneOutput;

    const result = this.parseAiResult(rawResult);

    this.logger.log(
      `AI scoring completed for "${title}", ` +
      `summary length: ${result.summary.length}`,
    );

    return result;
  }

  /**
   * 解析 AI 返回结果，校验并规范化字段
   */
  private parseAiResult(
    raw: AiArticleScoringOneOutput,
  ): ArticleScoringResult {
    if (!raw || typeof raw.summary !== 'string') {
      throw new Error('Invalid AI response: missing summary');
    }

    const scores: Partial<AllDirectionScores> = {};
    const mappedScores = new Map<ScoringDirection, DirectionScores>();

    const oldDirs: AiPluginDirection[] = [
      'agent', 'model', 'coding', 'multi',
      'eval', 'infra', 'data', 'security',
    ];
    for (const oldDir of oldDirs) {
      const rawDirScores: unknown = raw.scores?.[oldDir];
      const dirScores = rawDirScores as Record<string, unknown> | null | undefined;
      const newDir = AI_PLUGIN_TO_NEW[oldDir];
      if (dirScores && typeof dirScores === 'object') {
        const parsed: DirectionScores = {
          novelty: this.clampScore(dirScores.novelty),
          depth: this.clampScore(dirScores.depth),
          impact: this.clampScore(dirScores.impact),
          authority: this.clampScore(dirScores.authority),
          timeliness: this.clampScore(dirScores.timeliness),
        };
        if (newDir === 'data_eval' && mappedScores.has('data_eval')) {
          const existing = mappedScores.get('data_eval')!;
          mappedScores.set('data_eval', {
            novelty: Math.max(existing.novelty, parsed.novelty),
            depth: Math.max(existing.depth, parsed.depth),
            impact: Math.max(existing.impact, parsed.impact),
            authority: Math.max(existing.authority, parsed.authority),
            timeliness: Math.max(existing.timeliness, parsed.timeliness),
          });
        } else {
          mappedScores.set(newDir, parsed);
        }
      }
    }

    for (const dir of ALL_DIRECTIONS) {
      scores[dir] = mappedScores.get(dir) ?? { ...EMPTY_DIRECTION_SCORES };
    }

    return {
      summary: raw.summary,
      scores: scores as AllDirectionScores,
      aiProcessed: true,
      degradeReason: null,
    };
  }

  /**
   * 将分值限制在 0-20 区间
   */
  private clampScore(value: unknown): number {
    if (typeof value !== 'number' || Number.isNaN(value)) {
      return 0;
    }
    return Math.max(0, Math.min(20, Math.round(value)));
  }

  /**
   * 基于关键词的规则降级打分
   */
  ruleBasedScore(
    title: string,
    content: string,
    sourceTier?: string,
  ): ArticleScoringResult {
    const text = `${title} ${content}`.toLowerCase();
    const scores: Partial<AllDirectionScores> = {};
    const titleLower = title.toLowerCase();

    for (const dir of ALL_DIRECTIONS) {
      const keywords = DIRECTION_KEYWORDS[dir];
      const matchCount = keywords.filter(
        (kw: string) => text.includes(kw),
      ).length;
      const titleMatchCount = keywords.filter(
        (kw: string) => titleLower.includes(kw),
      ).length;

      if (matchCount === 0) {
        scores[dir] = { ...EMPTY_DIRECTION_SCORES };
        continue;
      }

      const relevance = Math.min(matchCount / keywords.length, 1);
      const titleBoost = Math.min(titleMatchCount * 2, 6);
      const baseScore = Math.round(relevance * 12 + titleBoost);
      const clampedBase = Math.min(baseScore, 18);

      const authorityBase = SOURCE_TIER_AUTHORITY[sourceTier ?? 'medium'] ?? 10;

      scores[dir] = {
        novelty: Math.min(clampedBase + 2, 20),
        depth: Math.min(clampedBase, 20),
        impact: Math.min(clampedBase + 1, 20),
        authority: Math.min(authorityBase, 20),
        timeliness: Math.min(clampedBase + 3, 20),
      };
    }

    const summary = this.generateRuleSummary(title, text);

    this.logger.log(
      `Rule-based scoring completed for "${title}"`,
    );

    return {
      summary,
      scores: scores as AllDirectionScores,
      aiProcessed: false,
      degradeReason: null,
    };
  }

  /**
   * 为规则打分生成简单摘要
   */
  private generateRuleSummary(title: string, text: string): string {
    const sentences = text
      .replace(/\n+/g, ' ')
      .split(/[。！？.!?]/)
      .filter((s: string) => s.trim().length > 10);

    if (sentences.length === 0) {
      return title;
    }

    const excerpt = sentences.slice(0, 2).join('。').trim();
    return excerpt.length > 200
      ? `${excerpt.slice(0, 200)}...`
      : excerpt;
  }
}
