#!/bin/bash
# github_sync.sh - 创新药ETF报告同步到GitHub + IMA知识库
# 用法: bash /workspace/创新药ETF报告/github_sync.sh

set -e

REPORT_DIR="/workspace/创新药ETF报告"
REPO_DIR="/workspace/etf513120-reports"
# 从环境变量获取GH_TOKEN（不硬编码以避免Push Protection拦截）
GH_TOKEN="${GH_TOKEN:-$GITHUB_TOKEN}"
if [ -z "$GH_TOKEN" ]; then
  echo "❌ 请设置 GH_TOKEN 或 GITHUB_TOKEN 环境变量"
  exit 1
fi

echo "=== 步骤1: 复制文件到Git仓库 ==="
mkdir -p "$REPO_DIR/reports" "$REPO_DIR/models"
cp "$REPORT_DIR"/*.md "$REPO_DIR/reports/" 2>/dev/null || true
cp "$REPORT_DIR"/model_*.json "$REPO_DIR/models/" 2>/dev/null || true
cp "$REPORT_DIR"/ima_tool.cjs "$REPO_DIR/" 2>/dev/null || true
echo "✅ 文件复制完成"

echo "=== 步骤2: Git提交并推送 ==="
cd "$REPO_DIR"
git add -A
git config user.email "zhouyizhi79@github.com" 2>/dev/null || true
git config user.name "zhouyizhi79" 2>/dev/null || true
git commit -m "自动同步: $(date '+%Y-%m-%d %H:%M') 创新药ETF报告更新" 2>/dev/null || echo "⚠️ 无变更需要提交"
git remote set-url origin "https://zhouyizhi79:${GH_TOKEN}@github.com/zhouyizhi79/etf513120-reports.git"
git push origin main
echo "✅ GitHub推送完成"

echo "=== 步骤3: IMA知识库同步 ==="
export NODE_OPTIONS=""
# 导入最新晚报
LATEST_REPORT=$(ls -t "$REPORT_DIR"/创新药ETF分析晚报+*.md 2>/dev/null | head -1)
if [ -n "$LATEST_REPORT" ]; then
  FILENAME=$(basename "$LATEST_REPORT")
  ENCODED=$(python3 -c "import urllib.parse; print(urllib.parse.quote('$FILENAME'))")
  URL="https://raw.githubusercontent.com/zhouyizhi79/etf513120-reports/main/reports/${ENCODED}"
  echo "导入: $URL"
  node "$REPORT_DIR/ima_tool.cjs" add-urls "$URL" 2>&1 || echo "⚠️ IMA导入失败"
fi
echo "✅ IMA同步完成"

echo "=== 同步全部完成 ==="
