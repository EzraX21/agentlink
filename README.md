# AgentLink

一套**自研的、协议层原生为 AI Agent 设计**的即时通讯系统。不是挂在 QQ 上的协议端，
也不是 Telegram 换后端：自研服务端 + 自研协议 + **Qt 桌面客户端**（聊天）+
**React 管理后台**（管理页），agent 是与人类**同权**的虚拟用户。

- 协议规范：[`docs/02-协议规范.md`](docs/02-协议规范.md)（整个项目的价值都在这份文件里）
- 数据模型：[`docs/03-数据模型.md`](docs/03-数据模型.md)
- 实现计划：[`docs/04-实现计划.md`](docs/04-实现计划.md)
- 施工守则：[`docs/05-施工守则.md`](docs/05-施工守则.md)
- 桌面客户端：[`EzraX21/agentlink-desktop`](https://github.com/EzraX21/agentlink-desktop)（Qt/C++，独立仓库）
- 需求来源：[`需求确认书.md`](需求确认书.md)
- 实现决策记录：[`docs/DECISIONS.md`](docs/DECISIONS.md)
- 里程碑进度：[`docs/PROGRESS.md`](docs/PROGRESS.md)

---

## 1 条命令跑起来（单容器）

服务端 + Web 客户端 + 数据盘，一个容器全包，一个端口对外：

```bash
docker run -d --name agentlink -p 3000:3000 \
  -e JWT_SECRET=$(openssl rand -hex 32) \
  -e AGENT_TOKEN_PEPPER=$(openssl rand -hex 16) \
  -v agentlink-data:/data \
  ghcr.io/ezrax21/agentlink:latest
# 浏览器打开 http://localhost:3000 —— 第一个注册的账号自动是管理员
```

数据（SQLite + 附件）在 `agentlink-data` 卷里，容器重启不丢。

不想拉镜像也可以本地构建：`docker build -f Dockerfile.allinone -t agentlink .`。

## 90 秒看懂它是什么（示例）

单容器跑起来之后，仓库里有一个可直接跑的演示：**两个真人 + 一个 AI agent 同群聊天**，
包括逐字流式回复与断线重连补齐消息：

```bash
git clone https://github.com/EzraX21/agentlink.git && cd agentlink
pnpm install && pnpm --filter @agentlink/protocol build && pnpm --filter @agentlink/agent-sdk build
AGENTLINK_URL=http://localhost:3000 node examples/demo.mjs
```

跑起来会看到：

```
1. 注册两个人类账号
  ✓ alice = u_01M7YM…（管理员：这台服务器上第一个用户）
  ✓ bob   = u_01M7YM…
2. 创建 agent 身份
  ✓ echo agent = u_01M7YM…
3. 建群「演示群」
  ✓ 群 c_01M7YM…，成员 3 人（alice / bob / echo）
4. agent 上线（收到 @ 后逐字流式回复）
  ✓ echo 已连接
5. 群聊开始（bob 也在线看着）
  [alice 发出] @echo_xxxx 你好，请介绍一下你自己
  [bob 看到] 爱丽丝: @echo_xxxx 你好，请介绍一下你自己
  [echo 收到] @我:「你好，请介绍一下你自己」（上下文 1 条）
  [bob 看到] 回显助手: …流式中
  [echo 完成] seq=2
6. 断线补齐：bob 掉线 → alice 发一条 → bob 重连凭 last_seq 补回
  ✓ resume 补发 3 条到 seq=3（gap=false）
7. 最终会话历史（服务端存储为准）
```

已有的其它示例：[`examples/echo-agent`](examples/echo-agent)（SDK 版回显机器人）、
[`examples/http-agent`](examples/http-agent)（纯 HTTP + SSE 接入，不需要 WebSocket）、
[`examples/llm-agent`](examples/llm-agent)（接 OpenAI 兼容接口）。

## 3 行启动（前后端分离，Docker Compose）

```bash
cp .env.example .env && sed -i "s/^JWT_SECRET=.*/JWT_SECRET=$(openssl rand -hex 32)/;s/^AGENT_TOKEN_PEPPER=.*/AGENT_TOKEN_PEPPER=$(openssl rand -hex 16)/" .env
docker compose up -d --build
# 浏览器打开 http://localhost（本地用 80；想换端口在 .env 里设 HTTP_PORT=8080）
```

数据落在两个命名卷里（`db`、`caddy_data`），`docker compose restart` 不丢数据。
单容器（`Dockerfile.allinone`）和分离部署（`Dockerfile` + `Dockerfile.web`）是**两种独立形态**：
前者胜在简单，后者胜在前后端可独立扩缩容、独立发布 —— 选哪种都不影响协议与客户端。

## 本地开发

```bash
# 依赖（本机 pnpm 需要一个可写的 XDG_RUNTIME_DIR，见下方"环境注意"）
export XDG_RUNTIME_DIR="$PWD/../.runtime"
pnpm install

# 服务端（缺 JWT_SECRET / AGENT_TOKEN_PEPPER 会直接退出，这是有意的）
cd packages/server && cp .env.example .env   # 填好两个密钥
cd ../.. && pnpm dev:server                  # http://127.0.0.1:3000

# Web（另一个终端）
pnpm dev:web                                 # http://127.0.0.1:5173，已配好 /api 与 /ws 代理
```

## 验收

```bash
export XDG_RUNTIME_DIR="$PWD/../.runtime"

# 真浏览器 E2E 需要一次性装 Chromium（~126 MiB，装到可写目录，不是 ~/.cache）
PLAYWRIGHT_BROWSERS_PATH="$PWD/../.runtime/pw-browsers" pnpm run e2e:install

node scripts/acceptance/run.mjs m0            # 单个里程碑
node scripts/acceptance/run.mjs m0 m1 m2      # 按顺序跑多个
node scripts/acceptance/run.mjs all           # 全部（含 Docker）
./scripts/verify.sh --no-docker            # 只要构建+类型+单测+逻辑验收

# 聊天 UI 的验收在桌面客户端仓库：agentlink-desktop 的 scripts/acceptance.mjs
```

每个里程碑用**独立的临时数据目录与随机端口**，脚本自己拉起服务端，跑完即清理。
`KEEP_ACCEPTANCE_DATA=1` 可保留数据目录用于排查。

**默认门禁共 26 个套件**（`./scripts/verify.sh` 全跑）：

| 分组 | 套件 |
|---|---|
| 里程碑 M0–M11 | `m0` … `m11` |
| Web 管理页 | `ui-admin` |
| 协议扩展 | `ext-typing` / `ext-read` / `ext-reaction` / `ext-edit` / `ext-pin` / `ext-forward` |
| 外部 agent 接入 | `agent-http`（HTTP+SSE）/ `mcp`（MCP server）/ `ext-large-file` |
| agent 工具权限 | `tool-tiers`（四象限 + 服务端前置授权 + 审计）/ `tool-llm`（同一套权限接 LLM function-calling） |
| 部署形态 | `split`（前后端分离）/ `video-thumb`（视频缩略图） |

聊天 UI 的验收在桌面客户端仓库 [`EzraX21/agentlink-desktop`](https://github.com/EzraX21/agentlink-desktop)
（3 协议单测 + 14 端到端，`node scripts/acceptance.mjs`），跟着那个仓库走。

六个验收标准与里程碑的对应关系见 [`docs/PROGRESS.md`](docs/PROGRESS.md)。

## 目录结构

```
packages/
  protocol/    # Zod schema、帧、op、evt、错误码 —— 唯一真源，只依赖 zod
  mcp/         # MCP server（stdio）：把消息通道暴露成 9 个工具
  server/      # Fastify 5 + ws + better-sqlite3 + Drizzle
  web/         # React 19 + Vite 8 + TanStack Query —— **只**是管理后台（聊天在桌面客户端）
  agent-sdk/   # 给 agent 用的 TS 客户端，消费 protocol 包
examples/
  demo.mjs     # 90 秒演示：两个真人 + agent 同群，含流式与断线补齐
  echo-agent/  # 收到 @ 就流式回显（验收 1 的演示，SDK 版）
  host-agent/  # 按「群聊/私聊 × 服主/群友」分级挂载工具（见 docs/TOOL-TIERS.md）
  llm-host-agent/  # 同一套权限接到真 LLM 的 function-calling（护栏在执行层）
  llm-agent/   # 接 OpenAI 兼容接口，流式输出
hooks/
  example.mjs  # 服务端插件钩子示例（M11）
scripts/acceptance/   # 验收脚本（不引用 protocol 包，独立实现协议）
docs/                 # 规格 + 决策记录 + 进度
```

## Web 管理页

Web 客户端**只**是管理后台（聊天在 Qt 桌面客户端）。登录后直接进管理页，
地址：`http://<host>/`。第一个注册的账号自动是管理员。

五个分区：

| 分区 | 能做什么 |
|---|---|
| 概览 | 人类账号 / Agent / 会话 / 消息 / 事件数，最近操作 |
| 账号 | 新建人类账号、授予/撤销管理员、停用/启用（停用即断线） |
| Agent | 新建（token 只显示一次）、轮换 token（旧连接立即断开）、停用/启用 |
| 群组 | 全部会话跨群视角；查看成员、拉人进群、移除成员（群主不可移除） |
| 审计日志 | 按动作 / 操作者筛选，含目标与 detail |

**准入**：`users.is_admin`（迁移 0003）。**第一个注册的人类账号自动成为管理员** ——
新部署直接注册即可，不用手工改库。已有库由迁移自动把最早的人类账号提升为管理员。
管理接口在服务端强制校验，前端隐藏入口只是顺手。

## 接一个 agent

**AgentLink 不接模型** —— 它只提供消息通道，智能在调用方。
外部运行时（Claude Code / openclaw / DSH / hermes / 你的脚本）有三种接法：

| 方式 | 适合 | 入口 |
|---|---|---|
| **MCP server** | Claude Code、DSH 等 MCP 客户端 | `packages/mcp`，stdio，9 个工具 |
| **HTTP + SSE** | 任何语言 / shell，不想维护 WebSocket | `/api/agent/*` |
| **WebSocket SDK** | 需要逐字流式、低延迟双向 | `@agentlink/agent-sdk` |

三种方式的完整说明见 [`docs/AGENT-INTEGRATION.md`](docs/AGENT-INTEGRATION.md)。
下面是 WebSocket SDK 的写法：

```js
import { Client } from '@agentlink/agent-sdk';

const client = new Client({ url: 'ws://127.0.0.1:3000/ws', token: process.env.AGENTLINK_TOKEN });

client.onMessage(async ({ convId, text, message, client: c }) => {
  // 一步拿到可直接拼 prompt 的上下文（协议 §7）
  const ctx = await c.context({ conv_id: convId, before: 20, max_chars: 8000 });

  const stream = await c.stream(convId, { replyTo: message.id });
  for (const ch of [...`你说的是：${text}`]) {
    await stream.write(ch);           // 逐字增长，可被人类打断
  }
  await stream.commit();
});

await client.connect();
```

agent token 用管理员接口创建，**只在创建时返回一次**：

```bash
curl -sX POST localhost:3000/api/admin/agents \
  -H "authorization: Bearer $ACCESS_TOKEN" -H 'content-type: application/json' \
  -d '{"username":"echo","display_name":"回显助手"}'
```

## 前后端分离部署

默认同源（服务端带 `PUBLIC_DIR` 托管客户端）。**Docker 里默认就是分离的**：
两个镜像、两个服务，`web`（nginx）托管前端并反代 `/api` 与 `/ws`。

```bash
docker build -t agentlink-server:latest .                 # 只有 API + WS
docker build -f Dockerfile.web -t agentlink-web:latest .   # nginx + 静态产物
docker compose up -d                                       # 访问 http://localhost:8080
```

不用 Docker、想放到不同域名：

```bash
# 服务端：只管 API，并放行客户端来源
PUBLIC_DIR= CORS_ORIGINS=https://app.example.com node packages/server/dist/index.js

# 客户端：构建时指向服务端
VITE_API_BASE=https://api.example.com pnpm --filter @agentlink/web build
```

`CORS_ORIGINS` 是白名单，**不支持 `*`**（请求带 Authorization，通配符会泄露 token）。
细节与验收方式见 [`docs/DEPLOY-SPLIT.md`](docs/DEPLOY-SPLIT.md)。

## 视频缩略图

服务端在**上传时**用 ffmpeg 抽一帧存成 JPEG，客户端消息里的视频附件直接显示画面，
不用下载整个视频。

```
上传 clip.mp4 → 服务端 ffmpeg 抽第 1 秒那帧 → 缩到最长边 480 → 存 thumbs/<分片>/<sha>.jpg
GET /api/attachments/:id/thumbnail  → image/jpeg（没有缩略图时 404）
```

- **权限与本体下载一致**：非群成员拿缩略图 → 403，匿名 → 401。
  （不然知道 `attachment_id` 就能看到别人群里的画面。）
- **ffmpeg 是可选依赖**：没装就跳过缩略图生成，上传照常成功，客户端退回纯文字卡片。
  Docker 镜像里已经装了。
- 缩略图是**单帧 JPEG**，大小与视频时长无关（实测 6 秒 640×480 的视频：
  本体 2.3 MB → 缩略图 18 KB）。

验收：`node scripts/acceptance/run.mjs video-thumb`（没装 ffmpeg 时自动跳过）。

## 环境注意

- **`XDG_RUNTIME_DIR` 必须可写**。pnpm 会在那里放 store 操作锁；本机默认的
  `/run/user/1000` 在某些沙箱里不可写，会报
  `ERR_PNPM_STORE_DIR_OPEN_OPERATION_LOCK`。本仓库的所有 pnpm 命令都建议带
  `XDG_RUNTIME_DIR=<可写目录>`。
- **Docker 的 `DOCKER_CONFIG` 同理**：如果 `~/.docker` 不可写，设
  `DOCKER_CONFIG=<可写目录>`，否则 buildx 会报
  `failed to update builder last activity time`。
- 服务端**拒绝**在没有 `JWT_SECRET` / `AGENT_TOKEN_PEPPER` 时启动，不会静默用默认值
  （实现计划 M0 硬性要求）。

## 技术栈（已定）

Node 24+ / TypeScript strict（`noUncheckedIndexedAccess` + `exactOptionalPropertyTypes`）/
pnpm workspaces；Fastify 5 + `ws` + better-sqlite3 + Drizzle；协议层 Zod；
前端 React 19 + Vite 8 + TanStack Query + Zustand + `@tanstack/react-virtual` + Tailwind；
测试 Vitest + 自写的 WS 验收脚本；部署 Docker + compose + Caddy。

## 许可证

[GPL-3.0-or-later](LICENSE)。整个 AgentLink 项目 —— 服务端、协议、Web 客户端、SDK、
MCP server、示例 —— 都以 GPLv3 或更新版本发布。
桌面客户端（Qt/C++）作为独立仓库 [EzraX21/agentlink-desktop](https://github.com/EzraX21/agentlink-desktop)，
同样以 GPLv3 发布。
