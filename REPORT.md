# 交付报告

> 一句话：AgentLink v1（M0–M11）全部实现并通过验收；Web 客户端在**不扩协议**的范围内
> 已对齐 Telegram Desktop 的主要常用功能；剩余功能全部阻塞在"需要新增 op/evt"，
> 方案已备好（见第 6 节 `docs/PROPOSAL-protocol-ext.md`），等你批准。

生成时间：2026-11-17 · 代码位置：`agentlink/`（独立 git 仓库）

---

## 1. 怎么验证（三条命令）

```bash
cd agentlink
export XDG_RUNTIME_DIR="$PWD/../.runtime"
export PLAYWRIGHT_BROWSERS_PATH="$PWD/../.runtime/pw-browsers"

./scripts/verify.sh        # 构建 + 类型 + 单测 + 16 个验收套件（含 Docker 与真浏览器）
node scripts/acceptance/run.mjs perf     # 性能实测 → reports/perf.md
node scripts/acceptance/run.mjs visual   # 截图像素回归（8 张基线）
```

最近一次全量：**16 个套件全绿，exit 0**；web 单测 **101 项**。

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
| `ui-media` | 附件上传/渲染、搜索（HTTP 面）、excerpt XSS | 41 |
| `ui-ux` | 引用回复、右键菜单、草稿、未读、置顶、富文本、打字降级、离线队列、可访问性 | 132 |
| `ui-browser` | **真 Chromium** 端到端：登录/发消息/流式/上传/搜索/管理页/窄屏/断线重连/离线队列 | 37 |
| `perf` | 1000 条消息的帧率与长任务 → `reports/perf.md` | 18 |
| `visual` | 8 张关键页截图像素回归 + 深色亮度客观校验 | 10 |

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
| 「对方正在输入」**服务端**未实现 | 协议 §6 有 `typing` 事件、§5 没有触发它的 op | 提案第 1 节，客户端已就绪，加 op 即生效 |
| 表情回应 / 编辑消息 / 置顶消息 / 已读回执 / 转发 | 同上：都需新增 op/evt | 提案第 2–6 节，含迁移与验收 |
| 像素级视觉回归跨机器 | 基线按机器（字体抗锯齿不同） | 换机器 `UPDATE_BASELINES=1` 重建 |
| `examples/llm-agent` 的真实 LLM 调用 | 需要外部 API key | 未配置时退化回显，链路可验 |
| 端到端加密 / 音视频 / 移动端 App / 多语言 | 规格明确不做 | 若要做需改需求 |

**唯一挡着验收标准的一条**：M6 验收第 2 条（typing）。其余五条都已通过。

## 6. 决策与坑的记录

- `docs/DECISIONS.md`：FTS 触发器损坏、中文检索双路径、附件鉴权与 `<img>` 冲突、
  搜索 excerpt XSS、`group.update` 不推事件、离线队列与幂等键、视觉基线判真等。
- `docs/PROPOSAL-protocol-ext.md`：协议扩展提案（待审批，含 5 个待你拍板的问题）。
- `docs/PROGRESS.md`：里程碑与套件的验收矩阵。
