# Agent 的工具权限分级（四象限）

AgentLink 的 agent 不只是"能聊天"——它可以挂载系统工具。但**谁能用哪些工具**
必须按场景分级，否则一个群友就能让 agent 执行 `rm -rf /`。

`examples/host-agent` 实现了这套分级：

```
                   群聊 (conv.kind = group)        私聊 (conv.kind = dm)
                 ┌──────────────────────────┬──────────────────────────┐
  普通群友        │ 纯问答，不挂任何工具        │ 个人助理 / 答疑，不挂工具   │
                 ├──────────────────────────┼──────────────────────────┤
  服主本人        │ 沙箱只读工具（无害）        │ Host Root 全权限终端       │
                 └──────────────────────────┴──────────────────────────┘
```

## 判定规则

| 输入 | 来源 |
|---|---|
| 会话是群聊还是私聊 | `conv.get` 的 `conv.kind`（SDK 已把它放进 `MessageContext.convKind`） |
| 发送者是不是服主 | 服主 id **显式配置优先**：`HOST_OWNER_ID`；没配才回退到 agent 的 `owner_user_id`（谁建的 agent） |

服主 id 通过 `auth` 响应下发（`self.host_owner_id` / `self.owner_user_id`），
SDK 暴露为 `client.hostOwnerId` / `client.ownerUserId`。

> **踩过的坑**：判定不能写成 `hostOwnerId || ownerUserId`。一旦显式配了别的人，
> 创建者仍会被当成服主，权限并没有真正转移。验收套件第 11 节专门测这个。

## 服务端是权威：前置授权 + 审计

agent 进程跑在用户机器上，服务端管不到它**真的执行了什么**。所以执行顺序是：

```
agent 收到消息
   → 算出四象限（本地，仅用于交互文案）
   → 调 agent.tool.request {conv_id, tool, args_preview, triggered_by, message_id}
        ↓ 服务端判定：会话类型 × triggered_by 是不是服主
        ↓ 通过 → 落 audit_logs（action = tool.<name>）→ 返回 {audit_id, tier}
        ↓ 拒绝 → PERM_DENIED（details 里带 tier / allowed）
   → 拿到 ok 才真的执行；被拒就放弃，而不是"执行完再补记"
```

为什么关键：

- **判定权威在服务端**：agent 本地 `route()` 算错了、被 prompt 注入改了逻辑，
  也越不过服务端这道门。验收 10c 段直接伪造申请（普通群友触发 `exec`）会被拒。
- **`triggered_by` 是核心字段**：报的是"谁让 agent 干活的"，不是 agent 自己。
  服务端会校验它是会话成员 —— 否则 agent 报个假 id 就能提权。
- **审计在主流程里**：`audit_logs` 的 `action` 是 `tool.exec` / `tool.ls` 这种粒度，
  `detail` 里有 `conv_id` / `conv_kind` / `tier` / `triggered_by` / `host_id` /
  `args_preview` / `message_id`。管理页「审计日志」分区可以按 action 筛出全部
  `tool.exec`。

## 告警与保留期

**被拒的尝试也会留痕**（`tool.denied`）。这是安全审计里最容易漏的一类信号：
只记成功的话，"有人在反复试探 exec"在系统里完全不可见 —— 而失败的尝试
往往比成功的更能说明问题。`tool.denied` 的 detail 里带 `allowed`（当时允许的
工具清单），便于判断对方是不是在探测。

**实时告警**（`tool.alert`，瞬时事件）发给：
- `TOOL_ALERT_USER_IDS` 显式指定的账号；留空 = 全部人类管理员

两类触发：
| kind | 时机 | 为什么重要 |
|---|---|---|
| `exec` | 全权限命令被授权执行 | "服务器可能被改了什么"的唯一实时信号 |
| `denied` | 任何工具申请被拒 | 有人在越权尝试 |

投递用 hub 的 `onlyUserIds`（**限定**收件人，不是"多推给几个人"）——
只用 forceUserIds 的话，其他能看见该会话的人照样会收到，等于把告警内容泄露
给了非收件人。验收里专门断言了"非管理员收不到告警"。

**待确认状态在内存里**：`pendingConfirm` 是进程内的 Map，agent 重启后
"等你确认"的那条命令就丢了（用户回复「确认」会得到"没有待确认的操作"）。
这是有意的取舍 —— 危险命令不应该在进程重启后**自动**复活执行。
代价是用户要重新发一次请求。

**审计保留期**：`AUDIT_RETENTION_DAYS`（默认 180，`0` = 永不删除）。
与 events 的 30 天分开配置 —— 安全日志通常要留得比业务数据久。服务启动时
先跑一次清理，之后每 10 分钟一次。

已知限制（诚实说明）：agent 仍然可以**不调用**这个 op 而偷偷执行命令——服务端无法
物理阻止。要真正强制，得把工具执行移到服务端（架构变更，未做）。当前设计的价值是：
正常运行的 agent 一定会经过授权与审计，而恶意/被注入的 agent 属于"主机已失守"，
那种情况下审计的价值是**事后取证**而不是阻止。

## 工具集

### 沙箱（群聊 · 服主）— 只读、无副作用

`whoami` `pwd` `uname` `uptime` `df` `free` `ps` `ls` `cat`

护栏：
- 只能读白名单目录：`/home`、`/tmp`、`/var/log`
- `/etc` **不整目录放行**，只放行 `/etc/hostname`、`/etc/os-release`、`/etc/hosts`
  （放行 `/etc` 等于允许读 `/etc/shadow` 密码哈希与 `/etc/ssh` 主机私钥）
- `cat` 单次最多 256 KiB

### Host Root（私聊 · 服主）— 全权限，但有硬护栏

`exec <command>` —— 任意 shell 命令。

护栏（缺一不可）：
1. **只认服主**：普通群友的私聊里没有 `exec`，调了会得到"没有挂载工具"
2. **只在私聊**：群里永远不会挂载 `exec`
3. **危险命令二次确认**：命中 `rm -rf` / `dd of=` / `mkfs` / `shutdown` /
   `chmod -R` / `curl | sh` / `sudo` 等模式时，先回"看起来危险，回复确认执行"，
   服主回复「确认」才执行、「取消」则放弃
4. 未确认期间的任何其他消息都不会绕过（仍在等确认）

> 这是**高危能力**。agent 拿到 root shell 意味着：token 泄露 = 服务器沦陷，
> prompt 注入（别人在群里发一句话诱导它执行命令）= 服务器沦陷。
> 所以上面四条不是"锦上添花"，是这套功能能存在的前提。

## 运行

```bash
# 服务端（可选地指定服主；不指定则回退到建 agent 的人）
HOST_OWNER_ID=u_xxx node packages/server/dist/index.js

# agent
AGENTLINK_URL=ws://127.0.0.1:3000/ws \
AGENTLINK_TOKEN=ag_u_xxx_secret \
node examples/host-agent/index.mjs
```

## 消息格式

命令式（便于离线验证；接真 LLM 时把工具集转成 function-calling 的 tools 即可）：

```
群聊里：  @host !ls /tmp           → 服主：返回目录；普通群友："没有挂载工具"
私聊里：  !df                      → 服主：磁盘用量；普通群友："没有挂载工具"
私聊里：  !exec uptime             → 只有服主能执行
私聊里：  !exec rm -rf /tmp/x      → 服主需回复「确认」才执行
```

## 另一个改动：私聊不再要求 @

`only_mentions` 订阅过滤器以前对**所有**会话生效，导致 agent 在私聊里
必须被 @ 才收得到消息——而一对一对话里没人会 @ 机器人，"个人助理"象限直接失效。

现在私聊**不受** `only_mentions` 约束（群聊仍然只在被 @ 时推送，这是群聊不刷屏的关键）。

## 接 LLM 的 function-calling

`examples/llm-host-agent` 把同一套权限接到 OpenAI 兼容的 function-calling 上。
风险模型变了：从"人打错命令"变成"模型被诱导"，所以**护栏位置必须变**：

```
❌ 靠 system prompt 说"不要执行危险命令"   ← 提示词能被绕过
✅ 执行层强制：每次工具调用先过服务端授权
   危险命令必须让真人回「确认」才执行        ← 代码挡得住
```

流程：

```
消息 → 按四象限算出 tools 范围 → 传给 LLM
     → LLM 返回 tool_calls
       → 逐个：agent.tool.request（服务端授权 + 审计）
                → 危险命令？→ 不执行，问人「确认」/「取消」
                → 否则执行
       → 结果以 role:tool 回灌 → 继续下一轮，直到给出最终文本
```

`tools` 只是给模型看的"提议范围"；真正的门是服务端授权 —— 模型硬编一个
不存在的工具名或越权工具，都过不去。

待确认的危险调用存在内存里（含上下文 messages），所以用户回「确认」后能
接着推进多轮对话，而不是从头重来（重来会让模型重新规划、可能又提同样的命令）。

## 验收

```bash
node scripts/acceptance/run.mjs tool-tiers     # 65 项断言（命令式 agent）
node scripts/acceptance/run.mjs tool-llm       # 40 项断言（接 LLM，用假 LLM 驱动）
```

覆盖：auth 下发服主身份、四个象限各自的工具集、沙箱越权读被挡、
`exec` 在多词语句下正确传参、危险命令二次确认、确认/取消流程、
`HOST_OWNER_ID` 显式配置后权限真正转移、普通群友私聊拿不到全权限。
