#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(pwd)"
DIST_DIR="$ROOT_DIR/dist"

# 记录总开始时间
TOTAL_START=$(node -e "console.log(Date.now())")

# 打印耗时的辅助函数
print_time() {
  local start=$1
  local end=$(node -e "console.log(Date.now())")
  local elapsed=$((end - start))
  local seconds=$((elapsed / 1000))
  local ms=$((elapsed % 1000))
  echo "   ⏱️  耗时: ${seconds}.$(printf "%03d" $ms)s"
}

echo "[1/4] 清理 dist 目录"
STEP_START=$(node -e "console.log(Date.now())")
rm -rf "$ROOT_DIR/dist"
print_time $STEP_START
echo ""

echo "[2/4] 构建 server 和 client"
STEP_START=$(node -e "console.log(Date.now())")

# 给 server/client 构建子进程预留 8GB heap，缓解 vite build transform 阶段 OOM
# （典型错误：Reached heap limit Allocation failed）。
# 仅在外部未设置 NODE_OPTIONS 时注入，允许 CI / 用户通过外部环境变量完全覆盖
BUILD_NODE_OPTIONS="${NODE_OPTIONS:---max-old-space-size=8192}"

# 根据 only_frontend_change 决定是否构建 server
if [[ "${only_frontend_change:-false}" == "true" ]]; then
  echo "仅构建 client (only_frontend_change=true)"

  echo "   ├─ 启动 client 构建..."
  NODE_OPTIONS="$BUILD_NODE_OPTIONS" npm run build:client > /tmp/build-client.log 2>&1
  CLIENT_EXIT=$?

  if [ $CLIENT_EXIT -ne 0 ]; then
    echo "   ❌ Client 构建失败"
    cat /tmp/build-client.log
    exit 1
  fi

  echo "   ✅ Client 构建完成"
else
  echo "并行构建 server 和 client"

  # 并行构建
  echo "   ├─ 启动 server 构建..."
  NODE_OPTIONS="$BUILD_NODE_OPTIONS" npm run build:server > /tmp/build-server.log 2>&1 &
  SERVER_PID=$!

  echo "   ├─ 启动 client 构建..."
  NODE_OPTIONS="$BUILD_NODE_OPTIONS" npm run build:client > /tmp/build-client.log 2>&1 &
  CLIENT_PID=$!

  # 等待两个构建完成
  SERVER_EXIT=0
  CLIENT_EXIT=0

  wait $SERVER_PID || SERVER_EXIT=$?
  wait $CLIENT_PID || CLIENT_EXIT=$?

  # 检查构建结果
  if [ $SERVER_EXIT -ne 0 ]; then
    echo "   ❌ Server 构建失败"
    cat /tmp/build-server.log
    exit 1
  fi

  if [ $CLIENT_EXIT -ne 0 ]; then
    echo "   ❌ Client 构建失败"
    cat /tmp/build-client.log
    exit 1
  fi

  echo "   ✅ Server 构建完成"
  echo "   ✅ Client 构建完成"
fi

print_time $STEP_START
echo ""

echo "[3/4] 准备产物"
STEP_START=$(node -e "console.log(Date.now())")

# 移动 client 下的 HTML 文件到 dist/dist/client，保证 views 路径在 dev/prod 下一致
# 使用 mv 而非 cp：HTML 不能上传到公网 CDN，移走后 dist/client 中不再包含 HTML
if [ -d "$DIST_DIR/client" ]; then
  mkdir -p "$DIST_DIR/dist/client"
  find "$DIST_DIR/client" -maxdepth 1 -name "*.html" -exec mv {} "$DIST_DIR/dist/client/" \;
fi

# server 相关产物准备（only_frontend_change=true 时跳过）
if [[ "${only_frontend_change:-false}" == "true" ]]; then
  echo "   [skip] 跳过 run.sh/.env 复制 (only_frontend_change=true)"
else
  # 拷贝 run.sh 到 dist/（prod 从 dist/ 启动，确保 cwd 一致性）
  cp "$ROOT_DIR/scripts/run.sh" "$DIST_DIR/"

  # Runtime configuration must come from the target environment, never from a
  # developer workstation copied into the distributable artifact.
  echo "   [skip] 不复制 .env；请在服务器环境变量或密钥存储中提供运行配置"
fi

# 清理无用文件
rm -rf "$DIST_DIR/scripts"
rm -rf "$DIST_DIR/tsconfig.node.tsbuildinfo"

print_time $STEP_START
echo ""

echo "[4/4] 构建完成"

# 总耗时
echo "构建完成"
print_time $TOTAL_START

# 输出产物信息
DIST_SIZE=$(du -sh "$DIST_DIR" | cut -f1)
if [[ "${only_frontend_change:-false}" == "true" ]]; then
  echo ""
  echo "📊 构建产物统计:"
  echo "   产物大小:        $DIST_SIZE"
  echo ""
else
  NODE_MODULES_SIZE=$(du -sh "$ROOT_DIR/node_modules" | cut -f1)
  echo ""
  echo "📊 构建产物统计:"
  echo "   产物大小:        $DIST_SIZE"
  echo "   node_modules: $NODE_MODULES_SIZE"
  echo ""
fi
