# AI Frontier 开发与发布流程

本文档是 AI Frontier 的唯一开发流程约定。代码、配置和部署规则发生变化时，先更新本文档，再更新相关脚本或 workflow。

## 1. 分支模型

```text
main                 生产基线，只接受 dev 的合并
  ^
dev                  集成分支，staging 验收基线
  ^
codex/<topic>        功能、修复、重构和文档分支
hotfix/<topic>       生产紧急修复，完成后合并回 dev 和 main
```

- `main` 和 `dev` 禁止直接开发；所有改动通过 Pull Request 合并。
- 普通开发从最新 `dev` 创建分支：`git switch dev && git pull --ff-only && git switch -c codex/<topic>`。
- 分支名称使用小写短横线或下划线，主题应能说明变更目的，例如 `codex/fix-empty-hotlist`。
- 一个分支尽量只解决一个问题；跨模块变更也要保持一个清晰的用户或运行时目标。

## 2. 单次开发闭环

### Discovery

开始编码前确认：

- 需求、影响范围和验收标准；
- 目标环境（local、staging 或 production）；
- 需要同步的 `client/`、`server/`、`shared/`、测试和部署文件；
- 是否涉及数据库 schema、采集信源、AI provider、权限或运行时配置。

### Planning

把需求拆成可独立验证的实现项，并明确每项的验证命令、回滚方式和依赖。涉及 pipeline、provider、部署或数据迁移时，先补充设计说明或测试，再改实现。

### Implementation

```bash
cd <path-to-ai-frontier-client>
npm ci --ignore-scripts
cp .env.example .env.local   # 仅首次配置，真实密钥不得提交
npm run dev:local
```

- 只修改 canonical checkout；不要在 `legacy/`、`archive/` 或工作区根目录复制项目。
- API 契约变更必须同步 `shared/`、服务端、客户端和测试。
- 运行时密钥只放在 `.env.local`、服务器 secret store 或 systemd `EnvironmentFile`。
- 不把生产数据复制到 staging；需要验证时使用脱敏或专用 staging 数据。
- 每个逻辑步骤完成后提交一个小而完整的 commit，使用 `type: subject` 格式，例如 `fix: handle empty hotlist response`。

## 3. 本地验证门禁

提交 PR 前必须在本地执行：

```bash
npm run lint
npm run type:check
npm test -- --runInBand
npm run build:prod
npm run smoke:prod
git diff --check
```

如果只改文档，可跳过代码构建，但必须执行 `git diff --check`，并说明跳过原因。测试中的 provider fallback、数据库不可用等预期错误日志不等于失败，最终以测试进程退出码和 PASS 数量为准。

## 4. Pull Request 规则

PR 默认目标为 `dev`，标题使用清晰的变更类型：`feat`、`fix`、`refactor`、`test`、`docs`、`chore`。

PR 描述必须包含：

- 背景和问题；
- 变更范围与不包含的内容；
- 风险、数据迁移和配置变化；
- 本地验证命令及结果；
- 部署、观察和回滚方式。

GitHub Actions 的 `CI` 是合并门禁，必须通过 lint、类型检查、测试、生产构建和生产冒烟测试。未通过 CI、未完成 review 或存在未解决的高风险评论时，不得合并。

合并方式：

1. PR 合并到 `dev`，保留可追溯的 PR 和 commit；
2. 在 staging 部署并完成页面、`/health`、采集、评分、发布和数据链路验收；
3. 从已验收的 `dev` 版本创建 PR 合并到 `main`；
4. production 只能部署已合并到 `main` 的 commit 或 tag。

## 5. Staging 验收

通过 Actions 的 `Deploy` workflow 手动选择 `staging` 和明确的 commit/ref。staging 必须使用独立目录、独立数据库、独立端口和独立 `.env`，不得覆盖旧服务或生产数据。

最低验收清单：

- `/health` 返回 HTTP 200，database readiness 和 AI scoring 状态符合预期；
- 前端根路径可打开，API 请求没有指向错误环境；
- 信源列表、采集任务、评分 fallback、审核和发布流程可用；
- 日志中没有持续增长的异常、超时或数据库连接错误；
- 数据库迁移和回滚步骤已验证（如本次变更涉及 schema）。

## 6. Production 发布

production 使用 GitHub Environment `production`，必须配置 required reviewers。发布时：

1. 选择已合并到 `main` 的 commit 或 tag；
2. CI/build 成功后才允许部署；
3. workflow 上传不可变 artifact 到服务器的 `releases/<sha>`；
4. 运行时 `.env` 保留在 release 外部，`current` 原子切换到新 release；
5. systemd 重启并检查服务 active 和 `/health`；
6. 检查失败自动恢复旧的 `current`，并确认旧服务健康。

生产发布后观察至少一个采集周期，重点检查热点接口、采集成功率、AI provider、数据库连接和错误日志。发布记录必须包含 commit SHA、操作者、时间、健康检查结果和回滚结果（如发生）。

## 7. 回滚与紧急修复

- 应用回滚优先切回上一个健康的 `current` release，再重启对应 systemd 服务并检查 `/health`。
- 数据库迁移必须提供向前兼容方案；不可逆迁移不得与普通代码发布混在同一个无保护步骤中。
- 生产故障使用 `hotfix/<topic>`，先在 staging 复现和验证，再合并到 `dev`，随后同步合并到 `main`。
- 禁止使用 `git reset --hard`、强制 push 或直接修改服务器当前 release 来“修复”线上问题。

## 8. 环境与权限边界

GitHub Environments：

- `staging`：开发和测试人员可部署，使用 staging 主机、数据库、端口和 secrets；
- `production`：受保护环境，需要审批，使用独立 production secrets。

每个环境至少配置 `DEPLOY_HOST`、`DEPLOY_USER`、`DEPLOY_PATH`、`DEPLOY_SSH_KEY`；可选配置 `DEPLOY_PORT`、`DEPLOY_SERVICE`、`DEPLOY_SYSTEMD_SCOPE` 和 `HEALTHCHECK_URL`。密钥不写入 Git、PR、日志或前端 `VITE_*` 构建产物。

## 9. 完成定义

一个需求只有同时满足以下条件才算完成：

- 代码、测试、文档和配置已同步；
- 本地验证与 CI 均通过；
- PR 已 review 并合并到正确分支；
- staging 已验收，或明确记录“不适用”的理由；
- production 发布（如适用）有 commit、健康检查和观察记录；
- 工作树干净，未提交改动和临时密钥已清理。
