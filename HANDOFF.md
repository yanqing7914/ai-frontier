# AI Frontier 开发交接文档

更新时间：2026-09-22

这份文档给接手本项目的下一个 Agent 使用。请先完整阅读，再开始改代码或部署。

## 1. 项目定位

AI Frontier 是一个内部 AI 行业资讯系统，负责：

- 采集 AI 行业新闻、论文、官方发布和其他配置来源；
- 对文章去重、分类、评分、聚类、质量审核并决定是否发布；
- 通过 React/Vite 前端展示热点和运营工作台；
- 通过 NestJS 服务端提供 API、持久化、采集流水线和健康检查；
- 通过可插拔 capability / agent contract 接入 AI provider。

唯一 canonical 项目是本 Git 仓库，即包含本文件、`package.json`、`client/`、`server/` 和 `shared/` 的那份 `ai-frontier-client` checkout。

路径因电脑而异，不要把下面这台电脑的绝对路径当成必需路径：

```text
<workspace>/ai-frontier-client
```

在新电脑上，先进入实际 checkout，再用 `git rev-parse --show-toplevel` 确认仓库根目录。工作区根目录的 `legacy/` 和 `archive/` 只用于参考，不得作为开发基础，也不要在根目录复制项目。

## 2. 当前真实状态

### 本地代码

- 当前分支：`codex/fix-litellm-provider`
- HEAD：`590b42a fix: pass systemd scope to deployment step`
- 当前分支包含 LiteLLM/OpenAI-compatible provider、provider timeout/cancellation、健康检查、Collector 聚类阶段拆分、生产构建修复和手动环境部署 workflow。
- 当前工作树干净；上述改动已拆分为本地 Git 提交，但尚未推送到远程 `dev` / `main`。
- 尚未运行真实 GitHub Actions 部署，也没有确认部署到任何远程服务器。

### 验证结果

2026-09-22 在当前工作树执行：

- `npm run type:check`：通过，server/client 均通过；
- `npm test -- --runInBand`：通过，30 个测试套件、325 个测试通过；
- 之前已通过 `npm run lint`；
- 之前已通过 `npm run build:prod`；
- 之前已通过 `npm run smoke:prod`。该冒烟测试需要绑定本机回环端口，在受限沙箱中会出现 `listen EPERM`，获得本机临时端口权限后通过。
- 修改检查 `git diff --check`：通过。

测试中的 provider 失败日志是预期的 fallback 场景，不代表测试失败；测试最后全部 PASS。

### 远程服务器状态

此前尝试连接的 SSH 目标：

- `skills-server`：`root@10.68.13.190`
- 原应用服务器：`10.70.55.110`

两台机器当时都能建立 TCP 连接，但在 SSH key exchange 阶段返回 `Connection reset by peer`，尚未进入认证，也没有执行远程写操作。因此不要声称已经部署成功。

新服务器尚未提供有效连接信息。接手后如果用户要求部署，先让用户提供可验证的 SSH 主机/用户名/端口，或者让服务器具备主动拉取制品的网络能力。

## 3. 当前这批改动做了什么

### AI provider / LiteLLM

涉及：

- `server/infrastructure/capability.service.ts`
- `server/infrastructure/ai-provider-status.ts`
- `server/modules/collector/agents/gateway.ts`
- `server/modules/collector/agents/types.ts`

行为要点：

- provider 默认保持 legacy capability 协议；
- LiteLLM / OpenAI-compatible endpoint 通过 `AI_PROVIDER_PROTOCOL=openai` 启用；
- OpenAI-compatible 请求使用 `/v1/chat/completions` 形式；
- 支持 capability-specific scoring URL：`AI_ARTICLE_SCORING_1_URL` 优先于全局 `AI_PROVIDER_URL`；
- provider 请求有可配置超时 `AI_PROVIDER_TIMEOUT_MS`；
- agent gateway 在支持 `callWithSignal` 时，超时会触发 `AbortController`；
- AI provider 调用失败时，Collector 仍会回退到规则评分逻辑。

### 评分证据约束

`CapabilityService` 中的 scoring prompt 已补充方向和维度证据契约。5 分维度必须提供所需字段和原文 quote，不能靠模型自行补充或改写事实。

### Collector 聚类阶段

涉及：

- `server/modules/collector/collector.service.ts`
- `server/modules/collector/stages/cluster-stage.ts`
- `server/modules/collector/stages/index.ts`
- `test/unit/collector/cluster-stage.spec.ts`

聚类逻辑从 `CollectorService` 抽成 `runClusterStage`，历史读取和 cluster assignment 都是 best-effort；失败会标记 `degraded` 并继续评分/发布流水线。

### 健康检查和生产启动

涉及：

- `server/main.ts`
- `server/modules/health/health.controller.ts`
- `server/modules/view/view.controller.ts`
- `scripts/build.sh`
- `scripts/run.sh`
- `scripts/smoke-production.js`

要点：

- `server/main.ts` 在加载 `AppModule` 前先加载 runtime environment；
- 生产产物布局为 `dist/server/`、`dist/client/`、`dist/scripts/run.sh`；
- 静态资源只暴露 client 目录，不应暴露 server 源码；
- `/health` 是无需认证的 liveness endpoint；
- `/health` 响应会区分 database readiness 和 AI scoring provider 状态；
- 没有数据库配置时，健康 endpoint 仍返回 HTTP 200，但 readiness 为 `degraded`；
- 生产启动使用 `npm start` 或 `./scripts/run.sh`。

## 4. 目录和架构速览

```text
client/                 React/Vite 前端
server/                 NestJS API、数据库、采集和处理流水线
server/modules/collector/采集流水线、评分、agent gateway、stage
server/modules/collector/agents/八个后处理角色和 contract-bound runtime
server/modules/collector/architecture/角色契约、依赖、失败策略、幂等范围
shared/                 前后端共享类型和 API 契约
test/                   单元、回归和契约测试
deploy/                 构建产物和健康检查说明
scripts/                dev/build/run/smoke/lint 脚本
docs/ARCHITECTURE.md    12-stage pipeline 和八角色架构说明
```

12-stage pipeline 的排序和契约测试在 `test/unit/collector/pipeline-stages.spec.ts`。八个后处理角色为：

1. `content_filter`
2. `content_evaluator`
3. `chinese_processor`
4. `body_organizer`
5. `event_recognizer`
6. `semantic_clusterer`
7. `event_reviewer`
8. `featured_explainer`

改 API 或 agent input/output 时，必须同步更新 `shared/`、实现和测试。

## 5. 本地开发

要求：Node.js 22+、npm 10+。

```bash
cd <path-to-ai-frontier-client>
npm ci --ignore-scripts
cp .env.example .env.local
npm run dev:local
```

常用命令：

```bash
npm run lint
npm run type:check
npm test -- --runInBand
npm run build:prod
npm run smoke:prod
npm start
```

默认服务监听：`SERVER_HOST=0.0.0.0`、`SERVER_PORT=3000`。

## 6. 环境变量和安全边界

以 `.env.example` 为字段清单。常用字段包括：

- `SERVER_HOST`、`SERVER_PORT`
- `VITE_API_BASE_URL`、`VITE_API_PROXY_TARGET`
- `DATABASE_URL`
- `AI_PROVIDER_URL`
- `AI_ARTICLE_SCORING_1_URL`
- `AI_PROVIDER_API_KEY`
- `AI_PROVIDER_MODEL`
- `AI_PROVIDER_PROTOCOL`
- `AI_PROVIDER_TIMEOUT_MS`
- `DB_POOL_MAX`
- `LOG_REQUEST_BODY`、`LOG_RESPONSE_BODY`

安全要求：

- 不读取、复制或提交真实 `.env`；
- 不把 API key、数据库密码、SSH 私钥写入仓库、交接文档或构建产物；
- `VITE_*` 会进入浏览器构建产物，生产环境不要设置 `VITE_ADMIN_API_TOKEN`；
- LiteLLM 场景明确设置 `AI_PROVIDER_PROTOCOL=openai`；
- 目标服务器将运行时配置放在 secret store、systemd `EnvironmentFile` 或服务器本地受限配置中。

## 7. 部署现状和推荐方案

当前 `.github/workflows/build.yml` 负责构建/上传 `dist` 制品，`.github/workflows/deploy-template.yml` 是不修改基础设施的包装模板；`.github/workflows/deploy.yml` 是新增的、手动触发的环境部署 workflow。它要求目标环境预先配置运行时 `.env` 和受管 systemd 服务，并通过 GitHub Environment secrets 建立 SSH 部署。部署前必须确认 workflow 使用的 systemd scope（系统级或用户级）与目标服务器实际服务模型一致。

推荐后续采用“CI 构建，服务器主动拉取”的发布方式：

```text
commit/tag -> GitHub Actions 验证和构建 dist
          -> 制品库或 GitHub artifact/release
          -> 服务器主动下载指定版本
          -> /opt/ai-frontier/releases/<sha>
          -> 原子切换 current
          -> systemd 重启
          -> /health 检查，失败回滚
```

推荐目录：

```text
/opt/ai-frontier/
├── current -> releases/<sha>
├── releases/<sha>/
└── shared/.env
```

如果用户要求“马上部署”，必须先完成：

1. 确认新服务器 SSH 可达、用户名、端口和部署目录；
2. 确认服务器 Node.js 22+、npm 10+，或准备包含依赖的部署制品；
3. 确认数据库和 LiteLLM endpoint 从服务器可达；
4. 把当前未提交改动审查后提交到一个明确分支/commit；
5. 构建并记录 commit SHA；
6. 服务器配置 `AI_PROVIDER_PROTOCOL=openai` 等运行变量；
7. 用 systemd 或等价进程管理器启动；
8. 检查 `/health`、首页、静态 asset 和关键 API；
9. 记录回滚版本。

当前不允许把“本地测试通过”当成“远程部署完成”。

## 8. 接手 Agent 的第一轮操作

请按以下顺序执行：

```bash
cd <path-to-ai-frontier-client>
git status --short --branch
git diff --check
git diff --stat
sed -n '1,260p' HANDOFF.md
sed -n '1,360p' docs/ARCHITECTURE.md
```

然后：

1. 审阅当前未提交 diff，重点看 provider 协议、生产路径、健康检查和 `cluster-stage`；
2. 重跑 `npm run lint`、`npm run type:check`、`npm test -- --runInBand`、`npm run build:prod`、`npm run smoke:prod`；
3. 不要丢弃当前工作树改动，也不要使用 `git reset --hard` 或 `git checkout --`；
4. 如果目标是继续开发，先和用户确认要做的模块及验收标准；
5. 如果目标是部署，先验证新服务器连接和远程环境，再选择 push/pull 发布方案；
6. 完成后补充本文件的“当前真实状态”和“验证结果”。

如果当前电脑没有这个 checkout，先同步仓库再开始开发。优先使用用户提供的本地路径、挂载目录或可信 Git remote；不要凭空创建一个空目录，也不要只根据本文件重建项目。注意：本次交接的最新功能改动在原电脑上尚未提交，因此仅执行 `git clone` 只能得到远端已提交版本，不能得到本文件第 3 节描述的全部改动。需要通过提交并推送、受控补丁或其他明确的文件同步方式传递未提交改动后，才能继续验证。

## 9. 重要未决事项

- 当前工作树的未提交改动需要审阅、提交和推送；
- 需要决定把 `codex/fix-litellm-provider` 合并到 `dev` 还是 `main`；
- 需要提供可达的新服务器或恢复旧服务器/堡垒机网络；
- 当前部署 workflow 还没有真正的服务器发布 adapter；
- 需要决定制品来源：GitHub Release、内部制品库、对象存储或 self-hosted runner；
- 生产环境需要明确 systemd/Nginx/域名/HTTPS/备份和回滚策略；
- 需要在真实服务器上验证数据库连接、LiteLLM 调用、采集任务和静态资源隔离。

## 10. 禁止事项

- 不要把 `legacy/` 当成当前实现；
- 不要在工作区根目录创建第二份应用；
- 不要提交 `.env`、密钥、数据库凭据、构建产物、`node_modules` 或妙搭平台元数据；
- 不要未经用户明确授权向生产环境部署或执行数据库迁移；
- 不要在没有远程验证时声称部署成功；
- 不要为了“清理现场”回滚或覆盖用户已有改动。

## 11. 跨电脑接手说明

本文件可以随仓库在不同电脑之间使用，但其中的本地绝对路径、Node/npm 缓存、`.env`、SSH 配置和进程状态不会随 Git 仓库迁移。

新电脑接手时按以下顺序判断：

1. **有 checkout**：进入包含 `package.json` 的仓库根目录，确认当前分支和提交，再执行第 8 节的检查。
2. **只有文档，没有 checkout**：先获取完整仓库；如果要接着本次最新开发，必须额外同步尚未提交的工作树改动。
3. **远端只有旧分支**：不要直接声称已恢复当前状态；先比较 `git log` 和 `git diff`，确认 LiteLLM、健康检查、聚类阶段等改动是否已经进入远端提交。
4. **没有可用 Git remote**：让用户提供仓库压缩包、挂载目录或可信 remote；不要创建替代项目。

跨电脑同步后，必须重新安装依赖并重新运行类型检查、测试、构建和冒烟测试；不要把原电脑的通过结果当成新电脑的验证结果。
