#!/usr/bin/env bash
# 一条命令验证整个项目：构建 + 类型检查 + 单测 + 全部里程碑验收。
#
# 用法：
#   ./scripts/verify.sh            # 全部（含 Docker 部署，需要本机有 docker）
#   ./scripts/verify.sh --no-docker
#
# 退出码 0 表示全绿；任何一步失败立即非 0 退出（不吞错）。
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

# pnpm 需要一个可写的 XDG_RUNTIME_DIR（见 README 的"环境注意"）
export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-$REPO_ROOT/../.runtime}"
mkdir -p "$XDG_RUNTIME_DIR"

# Docker 的 buildx 状态目录同理
if [ -z "${DOCKER_CONFIG:-}" ]; then
  export DOCKER_CONFIG="$REPO_ROOT/../.runtime/docker"
  mkdir -p "$DOCKER_CONFIG"
fi

WITH_DOCKER=1
WITH_BROWSER=1
for arg in "$@"; do
  case "$arg" in
    --no-docker) WITH_DOCKER=0 ;;
    --no-browser) WITH_BROWSER=0 ;;
    *) echo "未知参数: $arg"; exit 2 ;;
  esac
done

# 真浏览器 E2E 需要 Chromium（一次性安装，~126 MiB）
export PLAYWRIGHT_BROWSERS_PATH="${PLAYWRIGHT_BROWSERS_PATH:-$REPO_ROOT/../.runtime/pw-browsers}"

fail() { echo -e "\n\033[31m✗ $*\033[0m"; exit 1; }
step() { echo -e "\n\033[1m\033[36m=== $* ===\033[0m"; }

step "1/4 构建（pnpm -r build）"
pnpm -r build || fail "构建失败"

step "2/4 类型检查（pnpm -r typecheck）"
pnpm -r typecheck || fail "类型检查失败"

step "3/4 单元测试（pnpm -r test）"
pnpm -r test || fail "单元测试失败"

step "4/4 里程碑验收"
if [ "$WITH_BROWSER" -ne 1 ]; then
  TARGETS="${TARGETS% ui-browser}"
  echo "（已跳过 ui-browser：--no-browser）"
fi

if [ "$WITH_DOCKER" -eq 1 ]; then
  TARGETS="m0 m1 m2 m3 m4 m5 m6 m7 m8 m9 m10 m11 ui-admin ui-media ui-ux ui-browser"
else
  TARGETS="m0 m1 m2 m3 m4 m5 m6 m7 m8 m9 m11 ui-admin ui-media ui-ux ui-browser"
  echo "（已跳过 m10：--no-docker）"
fi

if [ ! -x "$PLAYWRIGHT_BROWSERS_PATH/chromium-1255/chrome-linux/chrome" ] && [ ! -d "$PLAYWRIGHT_BROWSERS_PATH" ]; then
  echo "提示：未找到 Chromium，先跑一次 pnpm run e2e:install（或加 --no-browser 跳过）"
fi

node scripts/acceptance/run.mjs $TARGETS || fail "验收未全部通过"

echo -e "\n\033[32m\033[1m全部通过\033[0m"
