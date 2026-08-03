import { Injectable, Inject, Logger } from '@nestjs/common';
import { CapabilityService } from '@lark-apaas/fullstack-nestjs-core';
import type {
  AiArticleScoringOneInput,
  AiArticleScoringOneOutput,
  AllDirectionScores,
  DirectionScores,
  ScoringDirection,
} from '@shared/plugin-types';

/** AI 打分结果 */
export interface ArticleScoringResult {
  summary: string;
  scores: Record<string, DirectionScores>;
  aiProcessed: boolean;
}

const SCORING_PLUGIN_INSTANCE_ID = 'ai_article_scoring_1';
const SCORING_ACTION_KEY = 'textToJson';

const ALL_DIRECTIONS: ScoringDirection[] = [
  'agent', 'model', 'coding', 'multi',
  'eval', 'infra', 'data', 'security',
];

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
  agent: [
    'agent', 'agents', '智能体', 'autonomous', 'agentic',
    'tool use', 'tool-use', 'function calling', 'multi-agent',
    'planning', 'reasoning agent', 'agentic workflow',
  ],
  model: [
    'llm', '大模型', 'gpt', 'claude', 'gemini', 'llama',
    'transformer', 'fine-tun', 'pretrain', 'pre-train',
    'foundation model', '语言模型', 'language model', 'scaling',
  ],
  coding: [
    'coding', 'code gen', 'copilot', '编程', '代码生成',
    'ide', 'developer tool', '代码补全', 'code completion',
    'debugging', 'refactor', '代码审查', 'code review',
  ],
  multi: [
    'multimodal', '多模态', 'vision', 'image', '视频',
    'audio', 'speech', '图文', 'visual', '图片理解',
    'image generation', '图像生成', '文生图', '图生图',
  ],
  eval: [
    'benchmark', '评测', '评估', 'evaluation', 'leaderboard',
    '排行榜', 'mmlu', 'humaneval', '测试集', 'metric',
    'scoring', 'rating', '对比测试',
  ],
  infra: [
    'infrastructure', '基础设施', 'training cluster',
    '推理加速', 'inference', 'deployment', '部署',
    'gpu', 'tpu', '芯片', 'chip', '分布式', 'distributed',
    'kubernetes', 'serving', '推理框架',
  ],
  data: [
    'data', '数据集', 'dataset', '数据标注', 'annotation',
    '数据清洗', 'data pipeline', '数据治理', 'data quality',
    '合成数据', 'synthetic data', '数据飞轮', 'embedding',
  ],
  security: [
    'security', '安全', 'alignment', '对齐', 'red team',
    'jailbreak', '越狱', 'guardrail', '护栏', '隐私',
    'privacy', 'toxicity', '有害', '合规', 'compliance',
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
      const errMsg = error instanceof Error
        ? error.message
        : String(error);
      this.logger.warn(
        `AI scoring failed for "${title}", falling back to rule-based: ${errMsg}`,
      );
      return this.ruleBasedScore(title, content, sourceTier);
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

    for (const dir of ALL_DIRECTIONS) {
      const dirScores = raw.scores?.[dir];
      if (dirScores && typeof dirScores === 'object') {
        scores[dir] = {
          novelty: this.clampScore(dirScores.novelty),
          depth: this.clampScore(dirScores.depth),
          impact: this.clampScore(dirScores.impact),
          authority: this.clampScore(dirScores.authority),
          timeliness: this.clampScore(dirScores.timeliness),
        };
      } else {
        scores[dir] = { ...EMPTY_DIRECTION_SCORES };
      }
    }

    return {
      summary: raw.summary,
      scores: scores as AllDirectionScores,
      aiProcessed: true,
    };
  }

  /**
   * 将分值限制在 0-20 区间
   */
  private clampScore(value: number | undefined): number {
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
