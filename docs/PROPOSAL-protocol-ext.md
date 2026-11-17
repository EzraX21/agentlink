# 提案：协议扩展（typing / 回应 / 编辑 / 置顶 / 已读 / 转发）

> 状态：**待审批**。施工守则 §6.3 规定新增 op/evt 必须先问，这份文档就是那个"问"。
> 审批后按 `openspec/changes/protocol-ext-typing-reactions/tasks.md` 逐条实现。
>
> 为什么放在代码仓库而不是只放 openspec：openspec 工作区在本机是只读的
> （只有 spec 工具能写），而这份提案需要被提交、评审、随代码走。

## 一、为什么现在提

Web 客户端已经把「**只靠已有协议**就能做」的能力做完了：

- 附件（上传/下载/去重/权限）、全局与会话内搜索、引用回复、右键菜单
- 日期分隔、消息分组、草稿、未读、置顶（本地）、群公告与群名编辑
- 富文本（链接/代码/粗体/@提及）、上传下载进度、离线发件箱
- 键盘可用性、错误边界、断线横幅、真浏览器 E2E、性能与视觉回归

再往下对齐 TG 桌面版的常用功能，**全部卡在协议没有对应 op**：

| 想做的功能 | 缺什么 | 现状 |
|---|---|---|
| 「对方正在输入…」 | `typing.send` | 协议 §6 有 `typing` 事件，§5 **没有**触发它的 op → **M6 验收第 2 条至今无法实现** |
| 表情回应 | `reaction.add/remove` + `message.reaction` 事件 | 无 |
| 编辑消息 | `message.edit` + `message.edit` 事件 | 无 |
| 置顶消息 | `message.pin/unpin` + `message.pin` 事件 | 无 |
| 已读回执（✓✓） | `read.set` + 已读水位存储 | 无 |
| 转发 | `message.forward` | 无 |

## 二、要改什么

**协议层**（`@agentlink/protocol`，唯一真源）：

- 新增 8 个 op：`typing.send`、`read.set`、`reaction.add`、`reaction.remove`、
  `message.edit`、`message.pin`、`message.unpin`、`message.forward`
- 新增 4 个 evt：`message.reaction`、`message.edit`、`message.pin` 带 seq（可补发）；
  `read.update` 用 `seq=null`（瞬时，避免已读刷爆事件表）
- 消息对象加可选字段 `edited_at`、`reactions`；成员对象加 `last_read_seq`

**服务端**：8 个 handler + 迁移 `drizzle/0004_protocol_ext.sql`
（1 张新表 `message_reactions` + 3 个加列）。

**客户端**：打字节流与提示、已读上报与 ✓✓、回应 chip + picker、编辑入口、
置顶横幅、转发选择器。

## 三、关键设计取舍（详见设计文档）

1. **不需要 v=2**。协议 §12 已规定未知 op 回 `UNSUPPORTED_OP`、未知 evt 客户端忽略，
   所以这些是纯增量。
2. **打字不设状态机**：客户端只发"我在打字"，服务端 2 秒去重、3 秒过期。
   避免 "started 但没 stopped" 卡住。
3. **已读不写事件表**：只更新 `memberships.last_read_seq`（只增不减），
   事件 `seq=null`；重连后通过 `conv.get` 一次性拿到水位。
   否则一个人翻历史就能产生几百条事件。
4. **回应返回全量汇总**（`[{emoji, user_ids}]`）而不是增量：客户端整体替换，
   不会因丢帧而不一致。
5. **编辑不做历史**（需求确认书 §5 明确不做），只更新内容 + `edited_at`。
6. **置顶只做单条**（TG 桌面版默认行为），多条置顶留到以后。

## 四、影响

- **规格**：`docs/02-协议规范.md` 的 §5 op 清单、§6 evt 清单、消息对象；
  `docs/03-数据模型.md` 的新表与新增列。本次不改规格文件，改动点写进
  `docs/DECISIONS.md`（规格方持有文档）。
- **代码**：`packages/protocol/{ops,events,models}.ts`、`packages/server/{ops,db}`、
  `packages/web/{components,lib}`、`scripts/acceptance/*`。
- **风险**：每个 op 单独提交，出问题只回滚那一个；迁移只加表/加列，
  旧代码不读新列也不会坏。
- **回滚**：数据和代码都不需要停机迁移，`git revert` 单个提交即可。

## 五、需要你拍板的 5 个问题

1. **编辑时间窗**：TG 允许随时编辑。我们限制「发送后 15 分钟内」还是不限？
   （不限制实现更简单，只校验是本人。）
2. **置顶条数**：v1 单条够吗？多条需要 `pinned_messages` 表而不是一个列。
3. **已读粒度**：按会话记 `last_seq` 足够显示 ✓✓；要"每条谁读过"需要另一张表。
4. **回应 emoji**：限定单个 Unicode emoji（1～8 码点），还是允许任意短字符串？
5. **范围**：一次全做，还是只批 `typing.send`（解锁验收）+ `read.set`（改动小）？

## 六、验收计划

| 项 | 验收套件 | 重点断言 |
|---|---|---|
| typing | `ext-typing` + 修 `m6` M6.3 | A 打字 → B 收到 `typing`；非成员 `PERM_DENIED`；2 秒内重复调用只推一次 |
| reaction | `ext-reaction` | 汇总正确；撤回后清空；非法 emoji → `VALIDATION_FAILED` |
| edit | `ext-edit` | 旧关键词搜不到、新关键词能搜到；非本人 `PERM_DENIED` |
| pin | `ext-pin` | `conv.get` 带 `pinned_message_id`；member 权限 `PERM_DENIED`；断线补发能拿到 |
| read | `ext-read` | 只增不减；瞬时事件不写 events 表 |
| forward | `ext-forward` | 附件可跨会话打开；非成员被拒 |

真浏览器层面：`ui-browser` 补 typing 与 reaction 两条；视觉回归给置顶横幅与回应 chip
各加一张基线。
