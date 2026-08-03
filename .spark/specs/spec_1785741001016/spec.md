# 技术方案

## 开发元信息
- 开发模式: 全栈应用
- 涉及层级: [数据库, 插件, 服务端, 前端]

## 页面路由与导航

### 页面路由
| 路径 | 页面 | 说明 |
|------|------|------|
| `/` | 今日热点 | 首页，面向全公司的 AI 热点阅读入口 |
| `/workbench` | 运营工作台 | 打分明细、溯源、质量门禁、审核队列 |
| `/sources` | 源管理 | 信息源 CRUD 与健康监控 |

### 导航设计
- 导航机制：页面路由
- 导航项：
  - 今日热点
  - 运营工作台
  - 源管理

## 业务组件
| 组件 | 来源 | 关联页面 | 对应功能点 |
|------|------|---------|-----------|
| Badge | shadcn/ui | 今日热点、运营工作台 | 方向标签、状态标识 |
| Card | shadcn/ui | 今日热点 | 热点卡片列表 |
| Tabs | shadcn/ui | 运营工作台 | 四个 Tab 切换 |
| Table | shadcn/ui | 源管理、运营工作台 | 数据表格展示 |
| Dialog | shadcn/ui | 源管理 | 新增/编辑信息源弹窗 |
| Sheet | shadcn/ui | 今日热点 | 每日简报抽屉 |
| Select | shadcn/ui | 运营工作台、源管理 | 筛选下拉 |
| Switch | shadcn/ui | 源管理 | 启用/禁用开关 |
| Button | shadcn/ui | 全部页面 | 操作按钮 |
| Empty | shadcn/ui | 全部页面 | 空状态提示 |

## 数据模型

### 数据库设计

#### 信息源表（feed_source）
用途：存储 RSS/Atom 信息源配置与抓取健康状态。
核心字段：
- name: varchar (源名称)
- url: varchar (源 URL 地址)
- tier: varchar ['authoritative', 'validation', 'signal'] (层级)
- feed_type: varchar ['rss', 'atom', 'web'] (源类型)
- enabled: boolean (是否启用，默认 true)
- total_fetches: integer (累计抓取次数，默认 0)
- success_fetches: integer (成功抓取次数，默认 0)
- last_success_at: customTimestamptz (最后成功抓取时间)
- consecutive_failures: integer (连续失败次数，默认 0)
- last_error: text (最近错误信息)
关联关系：与 article 是一对多关系

#### 资讯条目表（article）
用途：存储采集处理后的资讯条目，含溯源、状态与主方向评分。
核心字段：
- title: varchar (标题)
- url: varchar (条目 URL)
- original_url: varchar (溯源解析出的原始出处 URL，可为空)
- content_hash: varchar (内容哈希，用于去重)
- summary: text (AI 或规则生成的摘要)
- source_name: varchar (来源名称，冗余存储)
- feed_source_id: uuid (关联信息源，引用 feed_source)
- published_at: customTimestamptz (原始发布时间)
- collected_at: customTimestamptz (采集时间)
- cluster_id: varchar (事件聚类 ID，同一事件共享)
- status: varchar ['published', 'draft', 'blocked', 'pending_review'] (发布状态)
- primary_direction: varchar ['agent','model','coding','multi','eval','infra','data','security'] (最高分方向)
- primary_score: integer (最高方向总分)
- ai_processed: boolean (是否经 AI 处理)
关联关系：与 direction_score、quality_gate、review_item 均为一对多关系

#### 方向评分表（direction_score）
用途：存储每条资讯在 8 个技术方向的多维评分明细。
核心字段：
- article_id: uuid (关联 article)
- direction: varchar ['agent','model','coding','multi','eval','infra','data','security'] (方向标识)
- dimension_scores: jsonb (维度得分明细，结构如 `{"novelty":15,"depth":12,"impact":18,"authority":16,"timeliness":14}`)
- total_score: integer (该方向总分，各维度加总)
关联关系：与 article 是多对一关系，每条 article 对应 8 条 direction_score

#### 质量门禁表（quality_gate）
用途：记录被质量过滤拦截的条目及拦截原因。
核心字段：
- article_id: uuid (关联 article)
- reason: varchar ['link_dead', 'content_stale', 'untraceable'] (拦截原因类型)
- detail: text (拦截原因详细描述)
- blocked_at: customTimestamptz (拦截时间)
关联关系：与 article 是多对一关系

#### 人工审核队列表（review_item）
用途：存储溯源失败或需人工介入的待审核条目。
核心字段：
- article_id: uuid (关联 article)
- status: varchar ['pending', 'approved', 'rejected'] (审核状态，默认 pending)
- reviewed_at: customTimestamptz (审核操作时间)
- review_note: text (审核备注)
关联关系：与 article 是多对一关系

#### 每日简报表（daily_digest）
用途：存储每日热点简报汇总数据。
核心字段：
- digest_date: date (简报日期，唯一)
- summary: text (简报正文内容)
- article_count: integer (当日发布热点数量)
- article_ids: jsonb (当日热点 ID 列表)
关联关系：无外键，按日期与 article 逻辑对应

#### 系统配置表（app_config）
用途：存储系统运行配置（AI 调用上限、降级开关、采集参数等）。
核心字段：
- key: varchar (配置键名，唯一)
- value: jsonb (配置值)
- description: varchar (配置说明)

**预置配置项**：
- `ai_daily_limit`：每日 AI 调用上限（默认 200）
- `fetch_concurrency`：采集并发数（默认 3）
- `fetch_retry_count`：重试次数（默认 3）
- `publish_threshold`：发布门槛分数（默认 75）

### 表关系总览
- feed_source → article：一对多
- article → direction_score：一对多（每条 article 8 条评分记录）
- article → quality_gate：一对多（一条 article 可被多种原因拦截）
- article → review_item：一对一（仅溯源失败的 article 进入审核）
- daily_digest：无外键，按 digest_date 与 article 的 collected_at 逻辑对应

## 插件设计
| 插件名称 | 基础插件 | 用途 | 调用方式 | 关联页面 | 输入参数 | 输出类型 |
|---------|---------|------|---------|---------|---------|---------|
| article-ai-scoring | ai-text-to-json | AI 摘要生成与 8 方向多维评分 | 服务端 CapabilityService（采集流水线内调用，结果直接落库） | 运营工作台（查看打分明细） | text: string（文章标题 + 内容摘要 + 来源层级信息） | {summary, scores: {agent, model, coding, multi, eval, infra, data, security}}，每个方向含 novelty/depth/impact/authority/timeliness 五个维度分值 |

**AI 调用控制**：
- 服务端维护每日调用计数器（app_config 表 `ai_daily_count_{date}`），每次调用前检查是否达上限
- 同一 content_hash 的 article 不重复调用（检查 ai_processed 字段）
- 达到上限后降级为规则打分模式，article.ai_processed 标记为 false
- 降级规则模式：基于关键词匹配判定方向，基于来源层级和信息完整度固定权重打分

## 业务模型

### API 设计

#### 今日热点页面相关
**页面路径**: /
**功能全景**：
| 功能 | 实现方式 | 说明 |
|------|----------|------|
| 展示今日热点列表 | API | GET /api/hot-articles |
| 查看每日简报 | API | GET /api/daily-digests/:date |
| 获取当前用户信息 | 平台能力 | 内置用户系统 |

**所需 API**:
```typescript
// 获取今日热点列表 [领域模型: Article] [对应页面功能: 热点卡片列表]
GET /api/hot-articles?page=1&pageSize=20&directions=agent,model
Response: {
  items: Array<{
    id: string;
    title: string;
    url: string;
    originalUrl: string | null;
    summary: string;
    sourceName: string;
    primaryDirection: string;
    primaryScore: number;
    publishedAt: string;
    clusterCount: number;
  }>;
  total: number;
}

// 获取每日简报 [领域模型: DailyDigest] [对应页面功能: 简报抽屉]
GET /api/daily-digests/:date
Response: {
  id: string;
  digestDate: string;
  summary: string;
  articleCount: number;
  articles: Array<{ id: string; title: string; primaryDirection: string; primaryScore: number }>;
}
```

#### 运营工作台相关
**页面路径**: /workbench
**功能全景**：
| 功能 | 实现方式 | 说明 |
|------|----------|------|
| 运营概览指标 | API | GET /api/workbench/overview |
| 全部条目与打分明细 | API | GET /api/workbench/articles |
| 单条打分明细 | API | GET /api/articles/:id/scores |
| 质量门禁列表 | API | GET /api/workbench/quality-gates |
| 待审核队列 | API | GET /api/workbench/reviews |
| 审核放行/丢弃 | API | PATCH /api/workbench/reviews/:id |
| 溯源链路查看 | API | GET /api/articles/:id/trace |

**所需 API**:
```typescript
// 运营概览统计 [领域模型: Article] [对应页面功能: 顶部概览栏]
GET /api/workbench/overview
Response: {
  totalCollected: number;
  publishedCount: number;
  draftCount: number;
  pendingReviewCount: number;
  aiCallsToday: number;
  aiDailyLimit: number;
  aiDegraded: boolean;
}

// 全部条目列表（含评分） [领域模型: Article] [对应页面功能: 打分明细 Tab]
GET /api/workbench/articles?page=1&pageSize=20&status=published&direction=agent&sortBy=primaryScore
Response: {
  items: Array<{
    id: string;
    title: string;
    sourceName: string;
    primaryDirection: string;
    primaryScore: number;
    status: string;
    aiProcessed: boolean;
    collectedAt: string;
  }>;
  total: number;
}

// 单条打分明细 [领域模型: DirectionScore] [对应页面功能: 展开查看维度得分]
GET /api/articles/:id/scores
Response: {
  items: Array<{
    direction: string;
    totalScore: number;
    dimensionScores: { novelty: number; depth: number; impact: number; authority: number; timeliness: number };
  }>;
}

// 质量门禁拦截列表 [领域模型: QualityGate] [对应页面功能: 质量门禁 Tab]
GET /api/workbench/quality-gates?page=1&pageSize=20&reason=link_dead
Response: {
  items: Array<{
    id: string;
    articleTitle: string;
    sourceName: string;
    reason: string;
    detail: string;
    blockedAt: string;
  }>;
  total: number;
}

// 待审核队列 [领域模型: ReviewItem] [对应页面功能: 人工审核队列 Tab]
GET /api/workbench/reviews?page=1&pageSize=20&status=pending
Response: {
  items: Array<{
    id: string;
    articleId: string;
    articleTitle: string;
    sourceName: string;
    url: string;
    status: string;
    collectedAt: string;
  }>;
  total: number;
}

// 审核操作 [领域模型: ReviewItem] [对应页面功能: 放行/丢弃按钮]
PATCH /api/workbench/reviews/:id
Body: { action: 'approve' | 'reject'; note?: string }
Response: { id: string; status: string }

// 溯源链路 [领域模型: Article] [对应页面功能: 溯源链路 Tab]
GET /api/articles/:id/trace
Response: {
  articleId: string;
  title: string;
  url: string;
  originalUrl: string | null;
  sourceName: string;
  traced: boolean;
}
```

#### 源管理相关
**页面路径**: /sources
**功能全景**：
| 功能 | 实现方式 | 说明 |
|------|----------|------|
| 新增信息源 | API | POST /api/feed-sources |
| 信息源列表 | API | GET /api/feed-sources |
| 编辑信息源 | API | PATCH /api/feed-sources/:id |
| 删除信息源 | API | DELETE /api/feed-sources/:id |
| 启用/禁用切换 | API | PATCH /api/feed-sources/:id/toggle |
| 健康指标详情 | API | GET /api/feed-sources/:id/health |

**所需 API**:
```typescript
// 创建信息源 [领域模型: FeedSource] [对应页面功能: 新增弹窗]
POST /api/feed-sources
Body: { name: string; url: string; tier: 'authoritative' | 'validation' | 'signal'; feedType: 'rss' | 'atom' | 'web' }
Response: { id: string; name: string; url: string; tier: string; feedType: string; enabled: boolean }

// 信息源列表 [领域模型: FeedSource] [对应页面功能: 信息源列表表格]
GET /api/feed-sources?page=1&pageSize=20&tier=authoritative&enabled=true
Response: {
  items: Array<{
    id: string;
    name: string;
    url: string;
    tier: string;
    feedType: string;
    enabled: boolean;
    successRate: number;
    lastSuccessAt: string | null;
    consecutiveFailures: number;
  }>;
  total: number;
}

// 更新信息源 [领域模型: FeedSource] [对应页面功能: 编辑弹窗]
PATCH /api/feed-sources/:id
Body: { name?: string; url?: string; tier?: string; feedType?: string }
Response: { id: string; name: string; url: string; tier: string; feedType: string }

// 删除信息源 [领域模型: FeedSource] [对应页面功能: 删除按钮]
DELETE /api/feed-sources/:id
Response: { success: boolean }

// 启用/禁用切换 [领域模型: FeedSource] [对应页面功能: 启用状态开关]
PATCH /api/feed-sources/:id/toggle
Body: { enabled: boolean }
Response: { id: string; enabled: boolean }

// 健康指标详情 [领域模型: FeedSource] [对应页面功能: 抓取健康详情面板]
GET /api/feed-sources/:id/health
Response: {
  totalFetches: number;
  successFetches: number;
  successRate: number;
  lastSuccessAt: string | null;
  consecutiveFailures: number;
  lastError: string | null;
}
```

## 自动化任务设计

### 采集打分流水线（cron 触发器）
- **触发时间**：每小时整点（`0 * * * *`）
- **触发器名称**：`aiNewsCollectionPipeline`
- **执行方式**：服务端 Automation，使用 `@Automation()` + `@BindTrigger('aiNewsCollectionPipeline')` 装饰器

### 流水线步骤
1. **抓取**：查询所有 enabled 的信息源，分批并发抓取 RSS/Atom 内容（限制并发数，读取 app_config 的 fetch_concurrency），每个源独立 try-catch，失败时退避重试（最多 3 次），更新 feed_source 健康统计
2. **解析入库**：解析 RSS 条目，提取标题/URL/发布时间/内容摘要，计算 content_hash，查重（同 hash 已存在则跳过），新条目写入 article 表
3. **溯源**：对新条目解析原始出处（HTTP 重定向跟踪、常见转载平台 URL 模式匹配），溯源成功的写入 original_url，溯源失败的创建 review_item（status=pending）并标记 status=pending_review
4. **质量过滤**：检查链接有效性（HEAD 请求）、内容时效性（published_at 距今不超过 7 天），不合格的创建 quality_gate 记录并标记 article.status=blocked
5. **去重聚类**：对新条目按标题词集 Jaccard 相似度聚类（阈值 0.5），同事件条目共享 cluster_id
6. **AI 打分**：检查 AI 每日调用计数（app_config），未达上限则调用 article-ai-scoring 插件生成摘要和 8 方向评分，写入 direction_score 表；达到上限则降级为规则打分。更新 article 的 primary_direction、primary_score、summary、ai_processed
7. **发布判定**：primary_score >= 75（读取 app_config 的 publish_threshold）的标记 status=published，否则 status=draft
8. **简报生成**：每日首次执行时（当日尚无 daily_digest 记录），为前一天生成简报摘要

### 容错策略
- 每个信息源的抓取独立 try-catch，单源失败不影响其他源
- 失败退避重试（指数退避，最多 3 次）
- 保留上一次成功结果（article 表中已有数据不受影响）
- 所有错误通过 Logger 记录并写入 feed_source.last_error

## 服务端模块划分
| 模块 | 目录 | 职责 |
|------|------|------|
| feed-source | server/modules/feed-source/ | 信息源 CRUD、健康统计 |
| article | server/modules/article/ | 文章查询（热点列表、工作台列表、打分明细、溯源链路） |
| collector | server/modules/collector/ | 采集流水线核心逻辑（RSS 抓取、溯源、去重聚类、质量过滤、AI 打分、发布判定） |
| digest | server/modules/digest/ | 每日简报生成与查询 |
| review | server/modules/review/ | 人工审核队列管理（放行/丢弃） |

### 依赖的 NPM 包
- `rss-parser`：RSS/Atom feed 解析
- `@nestjs/axios` + `axios`：HTTP 请求（溯源、链接检测）
- `htmlparser2`：HTML 内容提取（从 RSS description 提取纯文本）

## 打分模型设计

### 8 个技术方向
agent（智能体）、model（模型）、coding（编程）、multi（多模态）、eval（评测）、infra（基础设施）、data（数据）、security（安全）

### 5 个评分维度（每方向，各 0-20 分，满分 100）
| 维度 | 标识 | 说明 |
|------|------|------|
| 信息新颖度 | novelty | 内容是否提供了新信息或新视角 |
| 技术深度 | depth | 技术分析或实践内容的深度 |
| 行业影响力 | impact | 对 AI 行业的潜在影响程度 |
| 来源权威性 | authority | 信息源的权威性和可信度（authoritative 源此项更高） |
| 时效性 | timeliness | 信息的发布时间和相关性时效 |

### 发布规则
- 取 8 个方向中最高 total_score 作为 primary_score，对应方向为 primary_direction
- primary_score >= 75 → status=published（今日热点）
- primary_score < 75 → status=draft（仅内部可查）

### 降级规则
- AI 调用次数达到每日上限后自动切换为规则模式
- 规则模式：基于标题/内容关键词匹配判定方向，基于来源层级和信息完整度固定权重打分
- 降级处理的条目 ai_processed=false，工作台中可区分标识
- AI 调用去重：同一 content_hash 仅调用一次（检查 article.ai_processed）
- 每日调用计数存储在 app_config 表，键名格式 `ai_daily_count_{YYYY-MM-DD}`
