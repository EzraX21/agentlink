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

# 协议扩展 / 外部 agent 接入 / MCP 的套件。
# 单独列出来是因为它们**必须**在默认门禁里：新增功能不进 verify.sh
# 等于"写了测试但没人跑"，比没有测试更糟。
# video-thumb：服务端上传视频 → ffmpeg 抽帧（没装 ffmpeg 时套件自己跳过）
# qt-client：Qt/C++ 桌面客户端的协议核心 + 真连服务端端到端
#            （需要先构建 agentlink-server 与 agentlink-qt 两个镜像，见下面第 4/6 步）
EXT_SUITES="agent-http ext-typing ext-read ext-reaction ext-edit ext-pin ext-forward ext-large-file mcp split video-thumb qt-client"

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

step "0/6 验收脚本语法检查（必须是纯 JS）"
./scripts/check-acceptance-syntax.sh

step "1/6 构建（pnpm -r build）"
pnpm -r build || fail "构建失败"

step "2/6 类型检查（pnpm -r typecheck）"
pnpm -r typecheck || fail "类型检查失败"

step "3/6 单元测试（pnpm -r test）"
pnpm -r test || fail "单元测试失败"

# 说明：perf 与 visual 都**不在默认门禁里**：
#   - perf：共享机器上一次偶发长任务就会红，没有信息量。
#     单独跑 node scripts/acceptance/run.mjs perf（写 reports/perf.md）
#   - visual：基线是**按机器**的（字体抗锯齿不同）。换机器先 UPDATE_BASELINES=1 重建，
#     平时单独跑 node scripts/acceptance/run.mjs visual
# qt-client 需要两个镜像：服务端（已存在）与 Qt 客户端（Qt6 + CMake，构建较慢）。
# 没有 Docker 就跳过 —— 套件自己也会跳过，这里只是提前把镜像准备好。
if [ "$WITH_DOCKER" -eq 1 ]; then
  step "4a/6 构建 Qt 客户端镜像（qt-client 套件需要）"
  docker build -f packages/qt-client/Dockerfile -t agentlink-qt:latest . \
    || echo "（Qt 镜像构建失败，qt-client 套件会跳过）"
  docker build -t agentlink-server:latest . >/dev/null || echo "（服务端镜像构建失败）"
fi

step "5/6 里程碑验收"

# 5/6、6/6 由最后的汇总行承担
if [ "$WITH_BROWSER" -ne 1 ]; then
  TARGETS="${TARGETS% ui-browser}"
  echo "（已跳过 ui-browser：--no-browser）"
fi

if [ "$WITH_DOCKER" -eq 1 ]; then
  TARGETS="m0 m1 m2 m3 m4 m5 m6 m7 m8 m9 m10 m11 ui-admin ui-media ui-ux ui-browser ${EXT_SUITES}"
else
  TARGETS="m0 m1 m2 m3 m4 m5 m6 m7 m8 m9 m11 ui-admin ui-media ui-ux ui-browser ${EXT_SUITES}"
  echo "（已跳过 m10：--no-docker）"
fi

if [ ! -x "$PLAYWRIGHT_BROWSERS_PATH/chromium-1255/chrome-linux/chrome" ] && [ ! -d "$PLAYWRIGHT_BROWSERS_PATH" ]; then
  echo "提示：未找到 Chromium，先跑一次 pnpm run e2e:install（或加 --no-browser 跳过）"
fi

node scripts/acceptance/run.mjs $TARGETS || fail "验收未全部通过"

echo -e "\n\033[32m\033[1m全部通过\033[0m"
