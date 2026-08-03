// ---- plugin:ai_article_scoring_1 ----
// ============================================================
// 插件 ai_article_scoring_1 (AI资讯文章打分插件) 的类型定义
// 由 get_plugin_ai_json 自动生成
// ============================================================

export interface AiArticleScoringOneInput {
  /** 文章标题和内容的组合文本 */
  article_text: string;
}

/**
 * capabilityClient.load('ai_article_scoring_1').call<AiArticleScoringOneOutput>('textToJson', input)
 * 直接返回此类型，无 .data 包装，直接解构使用：
 * const { summary, scores } = result;
 */
/** 单方向的5维评分，每维度 0-20 整数 */
export interface DirectionScores {
  novelty: number;
  depth: number;
  impact: number;
  authority: number;
  timeliness: number;
}

/** 8个 AI 技术方向键 */
export type ScoringDirection =
  | 'agent'
  | 'model'
  | 'coding'
  | 'multi'
  | 'eval'
  | 'infra'
  | 'data'
  | 'security';

export type AllDirectionScores = Record<ScoringDirection, DirectionScores>;

export interface AiArticleScoringOneOutput {
  /** 文章核心摘要，准确概括文章主要内容、核心观点和关键信息 */
  summary: string;
  /** 8个方向的多维评分结果 */
  scores: AllDirectionScores;
}
// ---- end:ai_article_scoring_1 ----