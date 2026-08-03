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
export interface AiArticleScoringOneOutput {
  /** 文章核心摘要，准确概括文章主要内容、核心观点和关键信息 */
  summary: string;
  /** 8个方向的多维评分结果，schema: {"agent": {"novelty": number, "depth": number, "impact": number, "authority": number, "timeliness": number}, "model": {"novelty": number, "depth": number, "impact": number, "authority": number, "timeliness": number}, "coding": {"novelty": number, "depth": number, "impact": number, "authority": number, "timeliness": number}, "multi": {"novelty": number, "depth": number, "impact": number, "authority": number, "timeliness": number}, "eval": {"novelty": number, "depth": number, "impact": number, "authority": number, "timeliness": number}, "infra": {"novelty": number, "depth": number, "impact": number, "authority": number, "timeliness": number}, "data": {"novelty": number, "depth": number, "impact": number, "authority": number, "timeliness": number}, "security": {"novelty": number, "depth": number, "impact": number, "authority": number, "timeliness": number}} */
  scores: Record<string, unknown>;
}
// ---- end:ai_article_scoring_1 ----

// ---- plugin:github_repo_desc_translate_1 ----
// ============================================================
// 插件 github_repo_desc_translate_1 (GitHub仓库英文简介翻译) 的类型定义
// 由 get_plugin_ai_json 自动生成
// ============================================================

export interface GithubRepoDescTranslateOneInput {
  /** GitHub仓库的英文简介文本 */
  repo_desc_en: string;
}

/**
 * capabilityClient.load('github_repo_desc_translate_1').call<GithubRepoDescTranslateOneOutput>('textToJson', input)
 * 直接返回此类型，无 .data 包装，直接解构使用：
 * const { description_zh } = result;
 */
export interface GithubRepoDescTranslateOneOutput {
  /** GitHub仓库的中文简介，用一句通顺的话说明仓库的用途和功能 */
  description_zh: string;
}
// ---- end:github_repo_desc_translate_1 ----