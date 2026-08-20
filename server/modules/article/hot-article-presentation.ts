import type { Direction } from '@shared/api.interface';
import { DIRECTIONS } from '@shared/directions';

interface HotArticlePresentationInput {
  title: string;
  summary: string | null;
  sourceName: string;
  direction: Direction;
}

interface HotArticlePresentation {
  displayTitle: string;
  summary: string;
}

interface PurposeCopy {
  short: string;
  detail: string;
}

const PURPOSE_RULES: Array<{ test: RegExp; copy: PurposeCopy }> = [
  {
    test: /anthropic_default_model|default model.{0,30}environment variable/i,
    copy: {
      short: '新增默认模型配置',
      detail: '新增 ANTHROPIC_DEFAULT_MODEL 环境变量，可指定新会话默认使用的模型；仍可用 /model 临时切换，并在重启后保留设置。',
    },
  },
  {
    test: /audiobook|e[- ]?book.{0,40}(?:audio|tts)|voice clon/i,
    copy: {
      short: '把电子书转换为有声书',
      detail: '可在本地使用 CPU 或 GPU，把电子书转换为带章节和元数据的有声书，并支持语音克隆与多语言语音合成。',
    },
  },
  {
    test: /knowledge graph|code intelligence|repository.{0,40}graph|代码.{0,12}知识图谱/i,
    copy: {
      short: '在浏览器内生成代码知识图谱',
      detail: '把 GitHub、GitLab、Azure 或本地代码仓库转换为知识图谱，并在浏览器本地完成处理，方便理解和检索代码结构。',
    },
  },
  {
    test: /agent substrate|core systemagent|agent framework|智能体.{0,12}(?:框架|基础)/i,
    copy: {
      short: '提供智能体任务执行基础框架',
      detail: '为智能体提供任务执行和系统集成所需的基础能力；使用前应同时确认项目的官方支持范围与安全责任边界。',
    },
  },
  {
    test: /mcp.{0,20}toolbox|toolbox.{0,20}database|database.{0,20}mcp/i,
    copy: {
      short: '让智能体通过 MCP 操作数据库',
      detail: '为智能体提供标准化的数据库工具接口，使其能够通过 MCP 连接、查询和操作多种数据库。',
    },
  },
  {
    test: /vector database|milvus|向量数据库/i,
    copy: {
      short: '提供向量检索与 AI 数据存储',
      detail: '面向 AI 应用提供向量数据存储和相似度检索能力，适合知识库、语义搜索和检索增强生成场景。',
    },
  },
  {
    test: /sandbox|isolated execution|隔离.{0,8}(?:环境|执行)/i,
    copy: {
      short: '为 AI 任务提供隔离运行环境',
      detail: '为代码或智能体任务提供隔离的执行环境，降低运行不可信代码时对宿主系统造成影响的风险。',
    },
  },
  {
    test: /observability|log aggregation|grafana|loki|日志.{0,8}(?:聚合|监控)/i,
    copy: {
      short: '集中采集和查询系统日志',
      detail: '用于集中采集、存储和查询系统日志，帮助开发和运维人员定位服务异常、性能问题和运行事件。',
    },
  },
  {
    test: /code generation|generate code|coding agent|代码生成|编程智能体/i,
    copy: {
      short: '辅助生成和修改代码',
      detail: '让 AI 参与代码生成、修改或工程任务，减少重复开发工作；具体支持范围和交付质量以原文说明为准。',
    },
  },
  {
    test: /dataset|benchmark|leaderboard|数据集|评测|排行榜/i,
    copy: {
      short: '提供 AI 数据或评测参考',
      detail: '提供模型训练数据、评测方法或榜单结果，用于比较模型能力、质量、成本或运行效率。',
    },
  },
  {
    test: /image.{0,20}video|text.to.image|text.to.video|multimodal|多模态|图像生成|视频生成/i,
    copy: {
      short: '处理或生成多模态内容',
      detail: '用于理解、生成或编辑图像、视频、语音等多模态内容，具体输入输出形式和质量指标以原文为准。',
    },
  },
  {
    test: /gpu|inference|training cluster|推理|训练集群|芯片|加速/i,
    copy: {
      short: '提升 AI 训练或推理效率',
      detail: '面向 AI 训练、推理或部署提供计算与软件基础设施，重点关注性能、成本、容量和运维方式。',
    },
  },
];

const GENERIC_PURPOSE: Record<Direction, PurposeCopy> = {
  model: { short: '更新模型能力或使用方式', detail: '这是一项模型相关更新，主要涉及模型能力、可用方式、性能或生态适配；具体变化和使用条件请查看原文。' },
  agent: { short: '增强智能体任务执行能力', detail: '这是一项智能体相关更新，主要涉及任务执行、工具调用、流程编排或生产运行；具体能力边界请查看原文。' },
  multimodal: { short: '处理或生成多模态内容', detail: '这是一项多模态相关更新，涉及图像、视频、语音或其他模态的理解、生成与交互。' },
  coding: { short: '辅助软件开发与代码交付', detail: '这是一项 AI 编程相关更新，主要用于代码生成、仓库理解、工程修改或开发工具集成。' },
  infrastructure: { short: '支持 AI 训练、推理或部署', detail: '这是一项 AI 基础设施更新，主要涉及算力、训练、推理、云服务、端侧部署或运行维护。' },
  data_eval: { short: '提供数据与模型评测依据', detail: '这是一项数据与评测更新，主要涉及数据资产、评测方法、排行榜、质量指标或数据治理。' },
  safety_governance: { short: '降低 AI 风险并满足治理要求', detail: '这是一项安全治理更新，主要涉及风险控制、隐私、版权、监管、审计或合规要求。' },
  applications: { short: '把 AI 用到真实业务场景', detail: '这是一项 AI 应用落地信息，主要说明 AI 在具体行业或业务流程中的使用方式、部署状态和实际效果。' },
  business_ecosystem: { short: '反映 AI 市场与商业变化', detail: '这是一项商业生态信息，主要涉及融资、合作、并购、市场竞争、商业模式、社区或人才变化。' },
};

function cleanText(value: string): string {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .replace(/^\[(?:AI ?News|新闻|快讯)\]\s*/i, '')
    .trim();
}

function hasChinese(value: string): boolean {
  return /[\u3400-\u9fff]/.test(value);
}

function shortenChineseTitle(value: string): string {
  const firstTopic = value.split(/[；|｜]/)[0]?.trim() || value;
  // Keep a full product + action phrase together. The title is clamped by the
  // card UI as a final guard, so we do not cut the useful action in half here.
  return firstTopic.length > 46 ? `${firstTopic.slice(0, 45)}…` : firstTopic;
}

function displayIdentifier(value: string): string {
  const normalized = value.trim().replace(/[_-]+/g, ' ');
  if (!normalized) return 'AI 前沿';
  return normalized.replace(/\b[a-z]/g, (char) => char.toUpperCase());
}

function productName(title: string, sourceName: string): string {
  const repo = title.match(/(?:^|\s)([\w.-]+)\/([\w.-]+)(?:$|\s)/);
  if (repo?.[1] && repo[2]) {
    // Repositories such as agent-substrate/substrate are better recognised
    // by their project namespace than by the generic repository leaf name.
    const namespace = repo[1].toLowerCase();
    const name = repo[2].toLowerCase();
    return namespace.includes(name)
      ? displayIdentifier(repo[1])
      : displayIdentifier(repo[2]);
  }
  const cleanedSource = sourceName
    .replace(/\s+(?:Releases?|RSS|Daily|Weekly|Monthly)(?:\s+-\s+.*)?$/i, '')
    .replace(/^GitHub Trending\s*(?:Daily|Weekly|Monthly)?\s*-\s*/i, '')
    .replace(/^Anthropic\s+(Claude\b)/i, '$1')
    .trim();
  return cleanedSource || 'AI 前沿';
}

function inferPurpose(text: string, direction: Direction): PurposeCopy {
  const matched = PURPOSE_RULES.find((rule) => rule.test.test(text));
  return matched?.copy ?? GENERIC_PURPOSE[direction];
}

/** Build a readable Chinese card without mutating the auditable source title. */
export function presentHotArticle(input: HotArticlePresentationInput): HotArticlePresentation {
  const originalTitle = cleanText(input.title);
  const originalSummary = cleanText(input.summary || '');
  const combined = `${originalTitle}\n${originalSummary}`;
  const purpose = inferPurpose(combined, input.direction);
  const product = productName(originalTitle, input.sourceName);

  let displayTitle: string;
  if (hasChinese(originalTitle)) {
    displayTitle = shortenChineseTitle(originalTitle);
  } else if (/^v?\d+(?:\.\d+)+(?:[-\w.]*)?$/i.test(originalTitle)) {
    displayTitle = `${product} ${originalTitle.replace(/^v/i, '')}：${purpose.short}`;
  } else {
    displayTitle = `${product}：${purpose.short}`;
  }

  const summary = hasChinese(originalSummary) && originalSummary.length >= 18
    ? (originalSummary.length > 140 ? `${originalSummary.slice(0, 139)}…` : originalSummary)
    : purpose.detail;

  return { displayTitle: shortenChineseTitle(displayTitle), summary };
}
