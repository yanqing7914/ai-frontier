# Contributing

## 唯一入口

所有开发都在 `ai-frontier-client/` 内进行。不要在工作区根目录、`legacy/` 或 `archive/` 创建功能分支，也不要恢复已移除的妙搭（Spark）元数据。

## Agent 开发流程

1. 明确目标模块和验收标准，先阅读相邻模块与 `docs/ARCHITECTURE.md`。
2. 由一个 agent 负责一个边界（例如一个 server module、一个 client page 或测试），避免多个 agent 同时改同一文件。
3. 共享契约先行：改动 API 或 agent 输入输出时，同步更新 `shared/`、实现和测试。
4. 每个 agent 在交付前运行最小相关测试；集成阶段再运行完整 lint、typecheck、test 和 build。
5. 主 agent 只整合已验证的改动，检查 `git diff`，确认没有 `.env`、`node_modules`、`.spark*` 或生成文件。

## 提交边界

- 不提交 `.env`、凭据、构建产物或 `node_modules`。
- 不新增妙搭平台配置；外部能力必须通过明确的 adapter 接口接入。
- 提交信息使用 `feat:`, `fix:`, `test:`, `docs:`, `chore:` 等前缀。
- 发布前从 `main` 创建可追溯的 SemVer tag，并保留构建产物对应的 commit SHA。
