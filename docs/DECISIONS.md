# 实现决策记录

施工守则 §6：规格没写到的地方，选最简单的实现，记在这里。

---

## 2026-11-16 · WS 子协议字符串可选

**问题**：协议 §1 没规定 WS 握手是否必须带 `Sec-WebSocket-Protocol: agentlink.v1`，但施工守则 §7 把 `agentlink.v1` 列为协议标识。

**选择**：`@agentlink/protocol` 导出 `WS_SUBPROTOCOL = 'agentlink.v1'`；服务端在客户端声明该子协议时回显它，未声明时也接受连接。

**理由**：浏览器 `new WebSocket(url)` 不传第二参数时不会带子协议头，强制要求会让最简客户端连不上，与"要能用手打的客户端验证"（协议 §1）冲突。验收脚本走的就是不带子协议这条路径。

---

## 2026-11-16 · 错误码 `INTERNAL` 不在协议里

**问题**：未预期的服务端异常需要一个 code，协议 §9 没有定义。

**选择**：内部异常统一回 `CONFLICT` + `message:"服务端内部错误"`，不新增 `INTERNAL` 码。

**理由**：施工守则 §6 规定新增 op/evt 必须先问；错误码同理，v1 不擅自扩表。`CONFLICT` 的语义是"状态冲突，拉最新状态"，对客户端来说是安全动作。

---

## 2026-11-16 · 构建产物用 tsc，不用打包器

**问题**：`packages/protocol`、`server`、`agent-sdk` 是 Node ESM，Web 用 Vite。

**选择**：三个 Node 包用 `tsc` 直出 `dist/`（保留 `.d.ts` 与 sourcemap）；`web` 用 Vite 打包。

**理由**：协议包要被服务端和 SDK 同时引用，`tsc` 输出的 ESM + d.ts 最省事，不需要给 Node 侧再引一个 bundler。

---

## 2026-11-16 · 验收脚本不引用 protocol 包

**问题**：验收脚本要不要复用 `@agentlink/protocol` 的解析器？

**选择**：`scripts/acceptance/_client.mjs` 自己手写帧，只依赖 `ws`。

**理由**：验收脚本是协议的**独立**实现。如果它和被测服务共用一份 schema，协议写错时两边一起错，验收就失去意义。这是刻意的重复。

---

## 2026-11-16 · pnpm 需要可写的 XDG_RUNTIME_DIR

**问题**：本机 `$XDG_RUNTIME_DIR` 指向 `/run/user/1000`，在该沙箱里不可写，pnpm 会在那里放 store 操作锁，导致 `ERR_PNPM_STORE_DIR_OPEN_OPERATION_LOCK`。

**选择**：本仓库的所有 pnpm 命令都带 `XDG_RUNTIME_DIR=<workspace>/.runtime`。已写进 `README.md` 与 `scripts/dev.sh`。

**理由**：这是环境问题，不是项目问题；但必须写下来，否则下一个人会以为依赖装不上。

---

## 2026-11-16 · 中文检索：FTS5 + instr 双路径

**问题**：数据模型 §2 指定 `tokenize='unicode61'`。实测（better-sqlite3 13.2 / SQLite 3.54）：

```
text_plain = "周报什么时候交"
fts5vocab  → tokens: ["周报什么时候交"]      # 整段中文是**一个** token
MATCH '周报' → 0 命中
MATCH '周报什么时候交' → 1 命中
```

文档原话是"对中文是**按字切分**，能用但不理想"，但实测行为不是按字切分，而是把连续
CJK 当一个词。这意味着只靠 FTS5 **无法满足验收 4**（关键词检索），因为最常见的中文
子串查询会返回空。

**选择**：`search.messages` 做两条查询的并集（不改表结构、不改协议、不引第三方分词器）：

1. **FTS5 路径**：`MATCH '"<q>"'` + `snippet()`，覆盖拉丁词与整串精确词，走索引，快。
2. **子串路径**：`instr(text_plain, q) > 0`，用 `substr()` 截前后各 40 字符并在命中词外包
   `<mark>`，覆盖中文子串。

结果按 `seq` 倒序合并、去重，截到 `limit`。

**理由**：
- 不新增 op/evt（施工守则 §6 要求先问），只是同一个 op 的实现细节。
- 不改 DDL（迁移只增不改），也不引 jieba 之类的分词器（需求确认书把自建 tokenizer
  排除在第一版范围外）。
- 两条路径都不改变 `excerpt` 契约（协议 §5.7：前后各约 40 字符、命中词用 `<mark>`）。

**代价**：子串路径是 `LIKE`/`instr` 全表扫。实测 1 万条消息下三次查询 6.5ms / 49.6ms /
60.5ms，仍远低于 500ms 要求。数据量再上一个量级时，应换成自建 tokenizer 或
`messages_fts_ci` 按字切分的辅助索引 —— 那属于 v2 的破坏性变更。

**验收覆盖**：`m8.mjs` 的 M8.5 专门测中文子串（`记得带附件`）与拉丁词（`deploy`），
两者都要求 `excerpt` 带 `<mark>`。
