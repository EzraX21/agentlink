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

---

## 2026-11-16 · @ 提及的三种写法

**问题**：协议只规定 `only_mentions:true` 时"该消息 @ 了本用户才推送"，没说 @ 的
文本形式是什么。实现在 M9 第一次跑通时暴露问题：示例 agent 的用户名是 `echo`，
测试里发 `@echo 你好`，但当时的判定只认 `@<user_id>` 与 `@<display_name>`，所以
agent 一条都收不到。

**选择**：三种写法都认 —— `@u_xxx`（ID）、`@昵称`、`@username`。

**理由**：
- agent 的用户名是稳定的英文标识，`@echo` 比 `@u_01J...` 好记得多，比昵称稳定（昵称可改）。
- ID 形式对 SDK 最省事（不会歧义）。
- 三者都认不会误判：都是本群成员的名字，且需要显式 `@` 前缀。

**代价**：昵称与用户名可能撞名（例如两个成员都叫 "echo"）。v1 接受：撞名时两条都算
被 @，agent 会多收一条。精确指向用 ID 形式。

**验收覆盖**：`m9.mjs` 的 M9.2 用 `@echo` 触发，要求 3 秒内出现逐字增长的回复。

---

## 2026-11-16 · FTS 触发器必须分开判断"旧行是否在索引里"

**问题**：按数据模型 §2 的字面 DDL 实现触发器后，流式消息 commit 时报
`SQLITE_CORRUPT_VTAB`（database disk image is malformed），此后该库所有消息
UPDATE 都失败。

**根因**：DDL 里的 `trg_messages_au` 条件是 `WHEN old.state='final' OR new.state='final'`，
且**总是**先执行 FTS5 的 `'delete'` 插入。流式消息插入时 `state='streaming'`
（没进过索引），UPDATE 成 `'final'` 时 `old.state != 'final'`，却仍对从未存在的
索引项发 `'delete'` —— FTS5 直接标记虚表损坏。

**选择**：迁移 0002 把三个动作**分开判断**：

```sql
CREATE TRIGGER trg_messages_au AFTER UPDATE ON messages
BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, text_plain)
  SELECT 'delete', old.rowid, old.text_plain
  WHERE old.state = 'final' AND old.revoked_at IS NULL;   -- 旧行在索引里才删

  INSERT INTO messages_fts(rowid, text_plain)
  SELECT new.rowid, new.text_plain
  WHERE new.state = 'final' AND new.revoked_at IS NULL;   -- 新行该进才插
END;
```

启动时还跑一次 FTS5 的 `'rebuild'`（`src/db/index.ts` 的 `rebuildFts`），自愈任何
索引不一致。这条命令不能放进迁移文件：drizzle 的 migrator 用 `prepare()` 执行每条
语句，而 FTS5 特殊命令不能 prepare。

**代价**：每次启动多一次 rebuild。1 万条量级是毫秒级，可接受；换来的是"搜索不会
静静地返回空结果"。

**验收覆盖**：`m4.mjs`（流式 commit 会 UPDATE messages）、`m8.mjs`（FTS 索引行数）。

---

## 2026-11-16 · 测试环境的限流放宽

**问题**：M2/M3/M8 要造 120～10000 条消息来验证 seq 单调、分页与查询耗时，
但协议 §11 的发消息配额是 30 条/60 秒，按身份计 —— 规模测试会先撞限流。

**选择**：`RateLimiter.fromEnv()` 在 `NODE_ENV=test` 且设置了
`RATE_LIMIT_OVERRIDE` 时才覆盖配额；验收跑批器给这几个里程碑自动注入该变量。

**理由**：
- 限流本身由 M5 单独验证（60 秒内 31 条 → 第 31 条 RATE_LIMITED），不能被削弱。
- 生产环境完全忽略这个变量：配额仍是服务端常量，不落库、无配置界面（协议 §11）。
- 不这样做就只能让规模测试"等配额"，把 8 秒的验收变成几分钟。

**验收覆盖**：`m5.mjs` 的 M5.4 用**默认**配额跑（不注入 override），断言第 31 条被拒。

---

## 2026-11-16 · 验收跑批器按进程组杀进程

**问题**：M9 要求"杀掉服务端 10 秒再启动，agent 自动重连"。第一次跑时出现
`EADDRINUSE`，而断言"重连成功"竟然还是通的 —— 说明它连上的是**没被杀掉的旧进程**。

**根因**：服务端是用 `tsx src/index.ts` 起的，`tsx` 会再 fork 一个 node 进程跑真正的
服务。只 `kill(tsx.pid)` 会留下孤儿子进程继续占着端口。

**选择**：`spawn(..., { detached: true })` 让子进程自成进程组，用
`process.kill(-pid, sig)` 按组发信号；`stop()`/`kill9()` 之后还要轮询等端口真正释放。

**代价**：验收脚本多几十行；换来的是"重启"这件事真的发生了。

**验收覆盖**：`m9.mjs` 的 M9.5 要求出现**第二次** `resume 完成`（用出现次数判定，
不是 includes —— 否则首次连接的日志会让断言假阳）。
