# 交付报告

> 一句话：AgentLink v1（M0–M11）全部实现并通过验收；协议扩展 6 项全部落地；
> **前后端部署真正分离**（两个镜像、两个服务）；**架构最终形态**——服务端 + Web 管理后台 +
> Qt/C++ 桌面客户端（独立仓库 [`EzraX21/agentlink-desktop`](https://github.com/EzraX21/agentlink-desktop)），
> 所有 QQ 式聊天功能都在桌面客户端里，Web 只留管理页。

生成时间：2026-11-18 · 代码位置：`agentlink/`（独立 git 仓库）

---

## 1. 怎么验证（三条命令）

```bash
cd agentlink
export XDG_RUNTIME_DIR="$PWD/../.runtime"
export PLAYWRIGHT_BROWSERS_PATH="$PWD/../.runtime/pw-browsers"

```bash
cd agentlink
export XDG_RUNTIME_DIR="$PWD/../.runtime"

./scripts/verify.sh        # 构建 + 类型 + 单测 + 全部验收套件（含 Docker）
```

最近一次全量：**26 个套件全绿，exit 0**；web 单测 **15 项**（只留管理页测试）；
协议单测 27 项（33 个 op）；Qt 客户端 3 项协议单测 + 14 项端到端（在 agentlink-desktop 仓库）。

## 2. 里程碑与验收证据

| 里程碑 | 内容 | 验收套件 / 断言数 |
|---|---|---|
| M0 | monorepo + `@agentlink/protocol` + 验收脚手架 | `m0` / 16 |
| M1 | 认证、会话、WS 握手 | `m1` / 55 |
| M2 | 消息与 seq 幂等 | `m2` / 166 |
| M3 | 断线补齐 + gap（**验收 3**） | `m3` / 40 |
| M4 | 流式协议（**验收 1** 协议侧） | `m4` / 90 |
| M5 | 群管理与审计、限流（**验收 2**） | `m5` / 51 |
| M6 | Web 客户端（**验收 5**） | `m6` / 59 |
| M7 | 附件 | `m7` / 30 |
| M8 | 检索（**验收 4**） | `m8` / 54 |
| M9 | Agent SDK + 示例 agent（**验收 1** 端到端） | `m9` / 37 |
| M10 | Docker 部署（**验收 6**） | `m10` / 47 |
| M11 | 插件钩子与多实例 | `m11` / 36 |

后续补充（客户端对齐与工程度量）：

| 套件 | 覆盖 | 断言数 |
|---|---|---|
| `ui-admin` | Web 管理页（概览/账号/Agent/群组/审计）+ `is_admin` 准入 | 91 |

> 聊天 UI 的验收（原 `ui-media` / `ui-ux` / `ui-browser` / `perf` / `visual`）已搬到
> Qt 桌面客户端仓库 agentlink-desktop（`scripts/acceptance.mjs`：3 协议单测 + 14 端到端）。
> 这里不再有网页聊天的浏览器验收。
| `ext-typing` / `ext-read` / `ext-reaction` / `ext-edit` / `ext-pin` / `ext-forward` | 协议扩展 6 项 | 18 / 28 / 30 / 29 / 22 / 24 |
| `agent-http` | 外部 agent 的 HTTP + SSE 接入面 | 67 |
| `mcp` | MCP server（真 stdio JSON-RPC 子进程 + HTTP 传输，11 个工具） | 69 |
| `ext-large-file` | 解除附件大小上限（25 MiB 往返） | 15 |
| `split` | 前后端分离部署（真跨域：独立静态服务器 + CORS + 真浏览器） | 26 |
| `video-thumb` | 视频缩略图（真上传视频 → ffmpeg 抽帧 → JPEG） | 21 |
| `tool-tiers` | agent 工具权限四象限 + 服务端前置授权 + 审计 + 告警 | 83 |
| `tool-llm` | 同一套权限接 LLM function-calling（假 LLM 驱动，结果确定） | 40 |

## 3. 六条验收标准的落点

| # | 标准 | 怎么证明 |
|---|---|---|
| 1 | 两个浏览器窗 + 一个 agent：@agent 后 3 秒内逐字流式回复 | `m9` 真跑 `examples/echo-agent`；`ui-browser` 在真 DOM 里观察到文本长度 2→5→8 递增 |
| 2 | agent 禁言成员，动作进审计日志 | `m5`：agent 以 admin 身份踢人成功，`audit_logs` 的 actor 是 agent |
| 3 | 杀进程 1 分钟重启，凭 `last_seq` 拿回离线消息 | `m3`：`resume` 补发 seq 21–25、`gap=false`；`m9` 真 kill -9 后 agent 自动重连 |
| 4 | 关键词 + 时间范围 + 发送者组合检索 | `m8`：四者组合精确命中；1 万条下 6.5–60.5ms |
| 5 | WebUI 建群、拉人、停用 agent 立即生效 | `ui-admin`：跨群拉人后被拉者立刻能 `conv.get`；停用 agent 立即 1008 断连 |
| 6 | `docker compose up` 从零起、刷新可用、重启不丢 | `m10`：真容器栈 `down -v` → `up` → 经 Caddy 访问 → `restart` 后数据仍在 |

## 4. 客户端已对齐的能力（不扩协议）

附件（上传/下载/去重/权限/进度/失败重试）、全局与会话内搜索（含 `<mark>` 高亮，
且修掉了 XSS）、引用回复、右键菜单、日期分隔、消息分组、草稿、未读角标与分隔线、
置顶、群公告与群名编辑、富文本（链接/代码/粗体/@提及）、多图灯箱翻页、窄屏单栏、
键盘导航（会话 ↑↓、气泡 ↑↓ + Enter 开菜单）、离线发件箱（幂等重发）、
断线横幅与错误边界、`prefers-reduced-motion`、搜索面板与"正在输入"客户端一半。

## 5. 已知缺口（全部有明确原因）

| 缺口 | 原因 | 怎么办 |
|---|---|---|
| ~~正在输入 / 回应 / 编辑 / 置顶 / 已读 / 转发~~ | 需新增 op/evt，施工守则 §6.3 要求先问用户 | **已获批准并全部落地**（见下"协议扩展"一节） |
| 像素级视觉回归跨机器 | 基线按机器（字体抗锯齿不同） | 换机器 `UPDATE_BASELINES=1` 重建 |
| `examples/llm-agent` 的真实 LLM 调用 | 需要外部 API key | 未配置时退化回显，链路可验 |
| 端到端加密 / 音视频 / 移动端 App / 多语言 | 规格明确不做 | 若要做需改需求 |

**六条验收标准现已全部通过**（M6 第 2 条随 `typing.send` 落地）。

## 5b. 协议扩展（用户批准后新增）

| 扩展 | op | 事件 | 迁移 | 验收 |
|---|---|---|---|---|
| 正在输入 | `typing.send` | `typing`（瞬时） | — | `ext-typing` 18 |
| 已读回执 | `read.set` | `read.update`（瞬时） | 0004 | `ext-read` 28 |
| 表情回应 | `reaction.add/remove` | `message.reaction`（带 seq） | 0005 | `ext-reaction` 30 |
| 编辑消息 | `message.edit` | `message.edit`（带 seq） | 0006 | `ext-edit` 29 |
| 置顶消息 | `message.pin/unpin` | `message.pin`（带 seq） | 0007 | `ext-pin` 22 |
| 转发 | `message.forward` | 复用 `message.new` | — | `ext-forward` 24 |

设计要点：瞬时 vs 持久化事件严格区分（打字/已读不落库，回应/编辑/置顶可补发）；
转发不新增事件；附件随 `attachment_id` 跨会话，权限按"引用它的群"判定。

置顶的权限是 **owner/admin**（与改群名同级，权限矩阵 §10）—— agent 默认是普通成员，
所以 `agentlink_pin_message` 会先被拒，除非人类把它提成 admin。验收里**先证明被拒、
再提成、再成功**，避免"没提成也能过"这种假阳性。

## 5c. 外部 agent 接入（三种方式，都不接模型）

AgentLink 只提供消息通道，智能在调用方：

| 方式 | 入口 | 验收 |
|---|---|---|
| **MCP server**（stdio + HTTP，11 个工具） | `packages/mcp` | `mcp`（69 项） |
| **HTTP + SSE** | `/api/agent/*`：self / convs / history / messages（幂等）/ attachments / typing / stream（NDJSON 流式）/ events（SSE + Last-Event-ID） | `agent-http`（67 项） |
| **WebSocket SDK** | `@agentlink/agent-sdk` | `m9`（37 项） |

文档 `docs/AGENT-INTEGRATION.md`；零模型依赖示例 `examples/http-agent`。

## 5d. 部署形态：客户端与服务端真的分开

之前只有**代码层**分开（`packages/web` 与 `packages/server` 是两个包），部署还是
一个镜像（服务端顺带托管前端）。现在是两个镜像、两个服务：

| 镜像 | 内容 | 验收怎么查 |
|---|---|---|
| `agentlink-server` | 只有 API + WebSocket（`ls /app/packages` → 只有 `protocol` `server`） | `m10` 真 `docker run` 进去查 |
| `agentlink-web` | nginx + 静态产物（**连 node 都没有**） | `m10` 查 `command -v node` → none |

- `server`：`PUBLIC_DIR=` 置空 → 不再托管前端，`/` 是 404
- `web`：nginx 托管静态产物 + 反代 `/api` 与 `/ws`（含 Upgrade 头）
- `caddy`：`profile: tls`，只做 TLS 终止 → `web:80`

一个容易漏的点：nginx 里 **SSE 必须 `proxy_buffering off`**，否则
`/api/agent/events` 的事件会被 nginx 攒着不发 —— agent 看起来"连上了但收不到消息"。

真跨域形态另有一条验收（`split`）：起一个**独立的静态服务器**模拟 CDN →
用它的端口作 `CORS_ORIGINS` 重启服务端 → 用**最终** API 地址构建客户端 →
浏览器里真跑"跨域注册 → 登录 → WebSocket 连上"。

细节见 [`docs/DEPLOY-SPLIT.md`](docs/DEPLOY-SPLIT.md)。

## 5e. 视频缩略图

服务端在**上传时**用 ffmpeg 抽一帧存成 JPEG（最长边 480），客户端消息里的视频附件
直接显示画面，不用下载整个视频。

- `GET /api/attachments/:id/thumbnail` → `image/jpeg`；没有缩略图时 **404**
- 权限与本体下载**完全一致**：非群成员 403、匿名 401
- ffmpeg 是**可选依赖**：没装就跳过生成，上传照常成功，客户端退回纯文字卡片
- 缩略图是**单帧 JPEG**，大小与视频时长无关（实测 6 秒 640×480：本体 2.3 MB → 缩略图 18 KB）

验收 `video-thumb`（21 项）。

## 5f. Qt/C++ 桌面客户端

Qt/C++ 桌面客户端，不是网页套壳。已拆成独立仓库 [`EzraX21/agentlink-desktop`](https://github.com/EzraX21/agentlink-desktop)（GPLv3），验收脚本（协议单测 + 真连服务端端到端）也跟着搬了过去。

- **引导式**：第一次启动先填**服务器地址**（默认 `ws://127.0.0.1:3000`）→
  再注册或登录 → 之后这个地址被记住，直接进聊天
- **协议核心独立于 GUI**：`agentlink-core`（纯 C++，无 Qt 依赖）负责帧编解码、
  认证握手、请求/响应路由、事件分发，可以脱离 GUI 单测
- 构建：CMake + Qt 6（Core / Network / Widgets），不引入额外框架

见第 7 节与 [`docs/QT-CLIENT.md`](docs/QT-CLIENT.md)。

## 6. 决策与坑的记录

- `docs/DECISIONS.md`：FTS 触发器损坏、中文检索双路径、附件鉴权与 `<img>` 冲突、
  搜索 excerpt XSS、`group.update` 不推事件、离线队列与幂等键、视觉基线判真、
  协议扩展 6 项各自的事件语义取舍（瞬时 vs 持久化）、MCP 的订阅默认值等。
- `docs/PROPOSAL-protocol-ext.md`：协议扩展提案（已获批准并全部落地）。
- `docs/DEPLOY-SPLIT.md`：前后端分离部署的三种形态与验收。
- `docs/QT-CLIENT.md`：桌面客户端的架构、构建与部署。
- `docs/PROGRESS.md`：里程碑与套件的验收矩阵。
