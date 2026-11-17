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

---

## 2026-11-17 · 部署相关的两个坑

**Caddy 不能"直接回" `/healthz`**

`Caddyfile` 里最初写了 `respond /healthz 200`，看起来更省一次反代。但协议 §1 要求
`/healthz` 返回 `{"ok":true}`，而 `respond` 只回空 body —— 任何按 JSON 断言的探活
（以及 M10 验收）都会失败。改为透传给后端。Docker 的 `HEALTHCHECK` 打的是容器内端口，
不经过 Caddy，所以它一直是对的，问题只在外部路径上。

**容器里 `/app` 的属主**

镜像最后 `USER node`，但前面 `COPY` 进来的文件属主是 root，`node` 用户读不了自己的
`package.json`，启动直接 `ERR_INVALID_PACKAGE_CONFIG: permission denied`。
修法是在 `USER node` 之前 `chown -R node:node /app /data`。

**`docker compose` 的 `:?` 必填变量对所有子命令生效**

`compose` 里的 `JWT_SECRET: ${JWT_SECRET:?…}` 不只影响 `up`：`docker compose ps`、
`down` 这种只读命令同样会因变量缺失而报错。所以验收脚本里**每一次** compose 调用
都要带上这两个密钥，不能只在 `up` 时带。

---

## 2026-11-17 · 验收脚本必须可重复运行

**问题**：M10 第一次在 `verify.sh` 里跑挂了，报"注册新用户 → 409"。原因是上一次验收
留下的容器与命名卷还在，用户已存在。

**选择**：
1. 每次验收先 `docker compose down -v`，并断言 `compose ps` 为空（真的从零开始）；
2. 用户名带上时间戳后缀（双保险）。

**理由**：验收标准第 6 条的原话就是"`docker compose up` **从零**起服务"。如果脚本
依赖上一次的残留状态，它证明不了这句话。可重复运行是验收脚本的基本要求。

---

## 2026-11-17 · 全局管理员（users.is_admin）与 Web 管理页

**问题**：需求确认书 §5 要求"WebUI 管理面板：建群、账号与 Agent 管理、审计日志"。
但数据模型 §1 里**没有任何全局管理员概念** —— 它的权限矩阵是**按会话**的
（owner/admin/member）。原来的实现因此只检查 `kind === 'human'`，等于**任何注册
用户**都能建 Agent、停用 Agent、读全部审计日志。管理页要成立，就必须有准入。

**选择**：迁移 0003 给 `users` 加 `is_admin`（数据模型 §1 开头允许"实现可以加字段"），
并规定：

1. **第一个注册的人类账号自动成为管理员**。否则新库上没人能打开管理页（先有鸡还是
   先有蛋）。已有库由迁移里的 `UPDATE` 把最早的人类账号提升为管理员。
2. 管理接口（`/api/admin/*`）一律要求 `is_admin = 1`，否则 `PERM_DENIED` / HTTP 403。
3. 管理页可以授予/撤销管理员，但**不能撤销自己**，也**不能停用自己**，更不能
   把最后一个管理员降级或停用（否则会把所有人锁在门外）。
4. 前端只是"不显示入口"，真正的准入在服务端强制。

**代价**：
- 这是个**语义新增**：以前任何人类都能调管理接口（虽然没人依赖这个行为）。
  `m5` 的验收脚本因此要改用第一个注册的账号建 Agent —— 这属于把测试对齐到
  更严格的正确语义，不是放宽。
- 单租户自用场景下"第一个账号即管理员"很方便；多租户时要改成显式初始化，
  属于 v2。

**协议没动**：这不是协议变更（`is_admin` 不进 WS 帧），只是 HTTP 控制面的准入。
协议 §10 的会话内权限矩阵一字未改，agent 与人类仍然同权。

---

## 2026-11-17 · 管理页是路由，不是弹窗；建群对话框独立

**问题**：M6 的产出写的是"管理面板**路由**：建群、成员操作、审计日志"，但第一版做成了
一个三标签弹窗，塞不下账号/群组/审计这些表格，而且 ESC 一按就没了。

**选择**：
- 用 **hash 路由**（`#/admin`、`#/admin/users` …），不引 react-router —— 只有
  "聊天 / 管理"两个顶层视图，引路由库收益为零。
- 建群用**独立对话框** `CreateGroupDialog`，不放进管理页。理由：协议 §5.2 的
  `conv.create` 对**任何登录用户**开放，不要求管理员；普通用户在会话列表点 ＋
  也要能建群。
- 管理页的"成员操作"走**新的 HTTP 管理接口**（`/api/admin/convs/:id/members`），
  而不是复用 WS 的 `member.*`。因为协议 §5.5 的 `member.*` 要求调用者是**该群**的
  owner/admin，而管理页是**跨群视角**：管理员可能根本不在那个群里。

**代价**：成员管理有两套入口（群内面板走 WS op，管理页走 HTTP），语义略有重复。
可接受：前者受协议权限矩阵约束，后者受 `is_admin` 约束，审计都记 `member.invite` /
`member.kick` 并在 `detail.via = "admin_console"` 里标明来源。

**验收覆盖**：`scripts/acceptance/ui-admin.mjs`（91 项断言）覆盖准入、账号增删启停、
Agent 建/轮换/停用、跨群拉人与移除、审计筛选，以及页面路由与拒绝态；
`packages/web/src/pages/AdminPage.test.tsx`（4 项）覆盖渲染。

---

## 2026-11-17 · "发一条消息显示两次"：乐观插入与服务端回推撞车

**现象**（用户实测报的）：发一条消息，界面上出现两次；刷新后变回一条。

**根因**：两条到达路径叠在一起。

1. 客户端为了即时反馈，先插入一条**乐观消息**，id 是 `local_<uuid>`；
2. 服务端把 `message.new` **也推给发送者自己**（`hub.publish` 不排除发送者），
   客户端按 id 去重时插入了真实消息 `m_<ULID>`；
3. 随后 `message.send` 的响应到达，代码把"id 等于真实 id 的那条"替换掉 ——
   可它替换的是第 2 步插进来的那条，第 1 步的 `local_` 占位**没人删**。

于是列表里同时有 `local_xxx` 与 `m_xxx`，两条 id 不同，按 id 去重去不掉。
刷新时 `history.fetch` 只返回服务端那条，所以"刷新就好了"——这正是问题的指纹。

**为什么不能只靠"服务端不回推给发送者"解决**：多标签页 / 多设备需要它。
你在手机上发的消息，网页端也得通过 `message.new` 出现。所以回推是对的，
要在客户端把它们收敛。

**选择**：把发送逻辑抽成 `packages/web/src/lib/sendText.ts`，顺序固定为
"先 `removeMessage(localId)`，再 `replaceMessage(权威消息)`"。两种到达顺序都收敛到一条：

- **事件先到**：列表已有 `m_xxx` → 删掉 `local_xxx`，`replaceMessage` 按 id 幂等；
- **响应先到**：列表只有 `local_xxx` → 删掉它，放入 `m_xxx`，随后事件再按 id 幂等。

**为什么抽成独立模块**：这段逻辑之前在 `App.tsx` 的 `useCallback` 里，没法单测。
抽出来后 `sendText.test.ts` 覆盖 6 个场景，其中两个直接复现两种到达顺序。
**已验证它能抓住原 bug**：临时把 `removeMessage` 去掉后，这两个用例立刻失败并报
`expected [...] to have a length of 1 but got 2`。

**没改协议、没改服务端**：协议 §5.3 的 `message.send` 返回值与 §6 的 `message.new`
语义都没动，纯客户端去重。

---

## 2026-11-17 · 附件为什么不能直接给 `<img src>`：鉴权与 header 的冲突

**问题**：图片要在聊天气泡里显示，最自然的写法是
`<img src="/api/attachments/a_xxx/photo.png">`。但施工守则 §8 要求
"附件下载校验群成员身份"，服务端因此要求 `Authorization: Bearer <token>`
——而 `<img>` 标签**无法发送自定义请求头**。

三条"方便"的路都不能走：

| 做法 | 为什么不行 |
|---|---|
| token 放 URL 查询串（`?token=`） | 明确禁止：会进反向代理访问日志（协议 §2.4、施工守则 §3） |
| 改成 Cookie 会话 | 等于新增一套会话机制，且 CSRF 面变大，超出必要范围 |
| 放宽下载鉴权 | 直接违反施工守则 §8 |

**选择**：`fetch` 带 header 取回字节 → `URL.createObjectURL(blob)` → 交给 `<img>`。
实现见 `packages/web/src/lib/attachments.ts`：模块级缓存 + 引用计数，
组件卸载时 `revokeObjectURL`，同一个附件只取一次。

**代价**：图片不能交给浏览器原生缓存（`Cache-Control` 由浏览器管理 blob 生命期）。
单机自用、群聊图片量级下可接受。若将来图片量很大，正解是"短时效签名 URL"——
但那需要新协议字段，属于 v2。

---

## 2026-11-17 · 搜索结果里的 `<mark>` 不能用 innerHTML

**问题**：协议 §5.7 规定 `excerpt` 是"命中片段，命中词用 `<mark>` 包裹"，
服务端因此返回**带标签的字符串**。前端最省事的写法是
`dangerouslySetInnerHTML={{ __html: hit.excerpt }}`。

**这是 XSS**：`excerpt` = 消息原文 + 我们加的 `<mark>`，而消息原文是任意用户输入。
有人发一条 `<img src=x onerror=alert(1)>`，任何搜到它的用户都会执行那段脚本。

**选择**：`SearchPanel` 里写一个 `Excerpt` 组件，用正则把字符串按
`<mark>…</mark>` 切成片段，逐段作为 **React 文本节点**渲染。标签以外的字符一律
当纯文本，不存在注入面。

**验收覆盖**：`media.test.tsx` 里专门喂了一条
`<img src=x onerror=alert(1)> 也含 <mark>周报</mark>`，断言：
- 渲染结果里**没有** `<img>` 元素
- `<img src=x onerror=alert(1)>` 以纯文本出现在 `textContent` 里
- 同时 `<mark>` 仍然是真元素（高亮没被牺牲）

---

## 2026-11-17 · 检索 excerpt 曾经把正文重复一遍

**现象**：搜"演示"，返回片段是
`这个群是演示数据，随便发消息试试<mark>演示</mark>数据，随便发消息试试`
——正文出现两次。

**根因**：子串路径的 SQL 里，前缀长度写死成 40：
```sql
substr(text, max(1, instr(text, q) - 40), 40)   -- 错
```
当命中位置靠前（`instr ≤ 41`）时，起点被夹到 1，但**长度仍是 40**，
于是把"命中点之前的内容 + 命中词 + 之后的内容"整段又拼了一遍。

**修法**：先用 CTE 算出命中位置 `p`，前缀长度改成 `p - max(1, p - 40)`
（正好截到命中点为止）。现在短消息返回
`这个群是<mark>演示</mark>数据，随便发消息试试`，长消息返回
`…前文<mark>周报</mark>后文…`。

**验收覆盖**：`ui-media.mjs` 里对一条短消息断言 excerpt **精确等于**期望字符串
（不是 contains），这样重复问题不会再溜过去。

---

## 2026-11-17 · 草稿 / 未读 / 置顶放本地，不进协议

**问题**：对齐 TG 客户端时，草稿、未读计数、会话置顶都需要"记住状态"。
最直接的做法是往协议加字段（比如 `conversation.draft`、`membership.read_seq`）。

**选择**：这三样只放 `localStorage`（`packages/web/src/lib/localState.ts`），不加协议字段。

**理由**：
1. 它们本质上是**单设备的使用习惯**，不是会话事实。TG 桌面版也把草稿与已读位置
   按设备存本地；
2. 加字段就是协议变更，施工守则 §6 要求先问；而这一批的目标恰恰是
   "不动协议也能明显更像 TG"；
3. 未读用"客户端收到的条数"近似，而不是服务端已读游标 —— 换设备不同步，
   但**不会错**（不会出现"服务端说读了、客户端还显示未读"的矛盾）。

**代价**：换设备/清缓存后草稿与未读丢失。真要做多端同步的已读回执，
需要新增 `read` 相关 op（第 3 批，待用户拍板）。

**顺便说明 `reply_to`**：引用回复**没有**新增协议 —— 协议 §5.3 的
`message.send` 本来就有 `reply_to` 字段，`message.reply_to` 也早就在消息对象里。
这批只是把 UI 接上：右键"引用回复" → 输入区显示被引用摘要 → 发送带 `reply_to`
→ 气泡里渲染可点击的引用块。服务端行为也验过：引用不存在的消息、以及跨会话引用
都会被 `NOT_FOUND` 拒绝（否则会泄漏别的会话的内容）。

---

## 2026-11-17 · 上传进度必须换 XHR；正文富文本不能拼 HTML

**上传进度**：`fetch` 只能读**下载**流，**拿不到上传进度** —— 传 20 MiB 文件时界面
一点反馈都没有，体验上像卡死。改用 `XMLHttpRequest` 的 `upload.onprogress`
（`lib/attachments.ts` 的 `uploadAttachment`），并在输入区上方显示文件名 + 百分比 + 细进度条。
`total` 未知时（浏览器不给 `lengthComputable`）显示不确定态，不假装知道百分比。

**正文富文本**：为了让链接可点、`` `代码` `` 等宽显示，最省事的做法是把正文转成 HTML
再 `dangerouslySetInnerHTML`。**同样是 XSS**：正文是任意用户输入。
所以 `lib/richtext.ts` 只产出**结构化片段**
（`text | url | code | codeblock | bold`），`RichText` 组件逐段渲染成 React 文本节点 /
`<a>` / `<code>`，全程不拼 HTML 字符串。

配套的两条安全细节：
- 只把 `http(s)://` 与 `mailto:` 当链接，`javascript:` 一律按纯文本渲染；
- 外链带 `rel="noopener noreferrer"`（防 `window.opener` 劫持）。

**刻意不做斜体**：单个 `*` 在日常文本里太常见（`2*3*4`、`*.log`），误判比收益大。
需求确认书也把富文本编辑器列在"明确不做"里 —— 这里只做**渲染**，不做编辑。

**会话内搜索**：与全局搜索共用 `GET /api/search`，只是固定带上 `conv_id`；
结果条显示 `n/m` 与 ↑↓ 跳转，命中片段复用同一个 `Excerpt`（按 `<mark>` 切分渲染）。

---

## 2026-11-17 · 富文本切分是有顺序的（一次真实的回归）

**背景**：给正文加 `@提及` 高亮时，我把文本段的切分函数从 `splitUrls` 换成了
`splitMentions`，结果 **URL 全部不再识别** —— 因为 `splitUrls` 才会去找链接，
换成 `splitMentions` 后链接永远没有机会被匹配到。

**正确顺序**（`lib/richtext.ts`）：

```
代码块 → 行内代码/粗体 → URL → 提及
```

也即：文本段必须先过 `splitUrls`，由它内部再切 `splitMentions`。

**为什么写下来**：这类"管线顺序"bug 不会被类型检查发现，单测也只有在同时覆盖
两种语法时才会红。现在有专门的回归用例
（`提及与 URL 同时出现时两者都要识别`），输入 `@echo 看 https://example.com/x 这个`，
要求同时产出 `mention` 与 `url` 两种片段。

**顺带修的另一处**：同一次改动里我用通用字符串替换，误把 `splitMentions` 的尾巴
改成了**递归调用自己**（无命中时 `text.slice(0)` 无限递归），直接
`RangeError: Maximum call stack size exceeded`，六个用例同时红。教训是：
**大范围字符串替换后必须跑测试**，不能只看 typecheck 通过。

---

## 2026-11-17 · `group.update` 曾经只改库、不推事件

**问题**：协议 §6 定义了 `group.update` 事件（带 seq、可补发），客户端 `store.ts`
也有 `case 'group.update'` 分支。但服务端的 `group.update` 处理器**只更新了数据库、
写了一条审计，从来没 publish 过事件**。

后果：A 改了群名，B 的界面要**刷新**才看得到；断线重连也补不回来（因为根本没有
事件行可补）。

**选择**：迁移已有的事件类型，不加新东西 —— 在同一个事务里
①更新 conversations、②appendEvent('group.update')，提交后再 `hub.publish`。
这样：
- 在线成员立刻收到（含发起者的其它标签页）；
- `resume` 能补发（事件带 seq、30 天内有效）；
- 与数据模型 §4 的"消息/事件同事务"纪律一致。

**为什么值得单独记**：这是"协议定义了、客户端也实现了、服务端却漏了"的空档 ——
只测客户端或只测服务端都发现不了。现在 `ui-ux.mjs` 的 A3 段真跑：
owner 改名 → 成员收到事件 → 成员断线期间再改名 → 重连 `resume` 补发到 →
普通成员改名被 `PERM_DENIED` 拒绝。

---

## 2026-11-17 · 离线发件箱：靠幂等键，不靠新协议

**问题**：断线时用户按发送，消息要么直接失败、要么光标里的字被清掉 —— 两种都很难接受。
TG 的做法是"消息先显示在本地，恢复后自动发出"。

**选择**：`lib/outbox.ts`（localStorage）+ 恢复连接后按**同一个 `client_msg_id`** 重发。

关键在于**不需要新协议**：协议 §5.3 规定 `client_msg_id` 是幂等键，服务端遇到重复的
`(sender_id, client_msg_id)` 不报错、直接返回已有消息（M2 验收专门验过）。
所以"断线时以为没发出去、其实已经到了"的情况下重发是安全的 ——
服务端只会返回同一条，不会产生两条。

配套三个细节：
1. **断线时不尝试发送**：`sendText` 先看 `isOnline()`，不可用就直接入队，
   不然用户要先等 10 秒超时才知道失败；
2. **气泡保留并标「待发送 ⏳」**：不能把用户刚写的字清掉；
3. **区分失败类型**：只有连接类错误（连接未建立/已关闭/超时/网络）才进队列；
   权限、校验失败仍然删占位并报错 —— 那种重发一万次也不会成功。

**代价**：发件箱按设备存（换设备不同步），且上限 100 条；
重发是按顺序串行的，队头失败会阻断后面的（避免乱序）。

**顺带修的一个 UX bug**：自己发的消息原来不会自动滚到底部，而气泡是虚拟滚动的 ——
用户在翻历史时发一条，会因为"只渲染可见窗口"而**看不到自己刚发的消息**。
现在发送后一律回到底部。

**验收覆盖**：`ui-browser` 第 10 段真做：kill -9 服务端 → 断线横幅 → 发一条 →
气泡在且标「待发送」→ 重启服务端 → 用 WS 查历史确认**服务端只有一条** →
DOM 里只有一条、标记消失。

---

## 2026-11-17 · 视觉回归怎么避免"永远是绿的"

截图比对有个陷阱：**基线截错了状态，之后每次都是绿的**。比如"深色主题"那张
如果其实截到的是浅色页（切换没生效），基线就记录了浅色，之后无论深色主题怎么坏
都会"通过"。

**做法**：除了像素比对，再加一条**不依赖人眼、也不依赖基线**的客观校验 ——
算截图的平均亮度（`0.299R + 0.587G + 0.114B`，抽样每 7 个像素），
断言深色主题截图的亮度显著低于浅色（实测 237.6 → 31.4，阈值 0.75 倍）。

同类可加的还有"弹窗截图里必须有一块暗色遮罩"、"搜索面板里必须出现 `<mark>` 颜色"，
原理一样：**给基线本身加一条能独立判真的约束**。

另外两个让截图稳定的细节：
- 数据用**固定时间戳**灌入（否则消息上的时钟每次不同，diff 随机波动）；
- 弹窗/菜单/搜索这些状态要**等渲染稳定**（`waitForTimeout(350)`）再截，
  否则动画中间帧会让 diff 抖。

**阈值 0.5%**：同机重复跑噪声在 0～0.3%（字体抗锯齿、虚拟滚动亚像素），
而真实配色/版式改动是 1%+ 量级（实测把 `--al-primary` 改掉后是 1.3%/1.17%）。

---

## 2026-11-17 · 文件"点击才下载"、下载也要进度、动效要能关

**1. 文件卡片从"预载 + 链接"改成"点击下载"**

原来文件卡片挂载时就去取字节（为了给 `<a download>` 一个 blob URL）。问题是：
一个群里贴了 20 个附件，进群就把 20 个文件全下载了 —— 流量和内存都浪费，
而用户可能一个都不看。现在改成点击才取，并显示进度（`role="progressbar"`）。

**2. 下载进度必须用 XHR**

和上传一样：`fetch` 只能读**下载流**但拿不到 `progress` 事件（`fetch` 的
`body.getReader()` 能自己算，但要手动拼流）。这里用 `XMLHttpRequest` 的
`onprogress`，`responseType='blob'`，一次性拿到 Blob 再触发保存。

**3. `prefers-reduced-motion`**

系统的"减少动效"设置是给前庭功能敏感/晕动症用户用的。两层落实：
- CSS：`@media (prefers-reduced-motion: reduce)` 把动画/过渡压到 0.001ms，
  流式光标改成静态半透明；
- JS：`scrollToBottom` 在开启时用 `behavior: 'auto'` 而不是 `'smooth'`
  （CSS 的 `scroll-behavior` 管不到 JS 主动调用的平滑滚动）。

**4. 消息气泡键盘可达**

气泡原来只能右键打开操作菜单 —— 纯键盘用户没有等价入口。现在气泡
`tabIndex=0` + `role="article"` + `aria-label="发送者：内容摘要"`，
Enter/空格等价于右键。

**测试归属的一个教训**：CSS 内容的断言我一开始写在组件单测里，用 Vite 的
`?raw` 导入 —— 在 vitest 里被 Tailwind 插件处理后拿到**空字符串**，断言恒失败。
把"CSS 里有没有写媒体查询"移到 `ui-ux` 验收脚本（Node 环境直接 `readFile`），
组件单测只测 `useMediaQuery` 的行为 —— 各测各能测的东西。

---

## 2026-11-17 · 「正在输入」：客户端先按降级语义实现，不等协议

**背景**：协议 §6 有 `typing` 事件，§5 却没有触发它的 op。这是规格空白，
补 op 属于协议变更（施工守则 §6.3 要求先问），提案已写在
`docs/PROPOSAL-protocol-ext.md`，等审批。

**这轮做了什么**：把**客户端那一半**先做了，靠协议 §12 的既有语义：
「未知 op → 回 `UNSUPPORTED_OP` 且不断连，客户端视为服务端较旧并降级」。

于是 `lib/typing.ts` 的行为是：
- 输入时按 2 秒节流尝试 `typing.send`；
- 收到 `UNSUPPORTED_OP` → **永久停用**（不再每 2 秒撞一次）；
- 其它错误（断线等）只影响当次；
- 界面侧 `typing` 事件的处理早就有了，显示逻辑这轮补齐（3 秒过期）。

**好处**：服务端一旦加上这个 op，客户端**零改动**生效；现在也不会产生重复请求。
**边界**：协议包里仍然**没有** `typing.send`（`ui-ux` 里有断言守住这条），
所以这不是"擅自扩协议"，而是"按协议处理服务端不支持的情况"。

**踩到的一个真 bug**：节流判断写成 `lastSentAt.get(convId) ?? 0`，
导致**第一次**打字就被吞掉（`now - 0 < 2000` 恒成立）。单测直接抓到了，
改成"没有上次时间就立刻发"。

---

## 2026-11-17 · 协议扩展开工：先做 `typing.send`

用户批准扩展后，按提案顺序先做 `typing.send` —— 它是 M6 验收第 2 条唯一的阻塞项。

**为什么先做它**：改动最小（一个 op、无迁移）、收益最直接（解锁一条验收标准）、
且客户端那一半早就按 §12 的降级语义写好了，服务端一上线即刻生效。

**四个刻意的设计**（都已写进协议注释与 `ops/typing.ts`）：

1. **不带 state 字段**：客户端只报"我在打字"，没有 start/stop 状态机 ——
   少一个状态就少一类"对方一直显示正在输入"的 bug。
2. **服务端自己去重**：同一 `(user, conv)` 在 `TYPING_THROTTLE_MS`（2s）内重复上报
   **静默丢弃**，不报 `RATE_LIMITED`。打字指示是尽力而为的信号，回错误码只会让
   每个客户端都要多写一个分支，而用户什么也感知不到。
3. **瞬时事件**：`seq: null`、不写 `events` 表、不进 `resume` 补发 ——
   补发三分钟前的"正在输入"没有意义，还会污染补发日志。
4. **事件里带 `user`**：前端的"X 正在输入…"需要昵称，否则每个客户端都要再查一次成员。

**验收**：新增 `ext-typing`（18 项）+ `m6` 的 M6.3 从"只校验常量"改成端到端 +
`ui-browser` 加"两个浏览器上下文"：A 窗输入 → B 窗出现「爱丽丝 正在输入…」→
3 秒后自动消失。

---

## 2026-11-17 · 一个被掩盖很久的问题：dist 里的测试被跑了两遍

给协议加 op 时，`覆盖协议 §5 列出的全部 op` 这条测试出现诡异现象：断言里明明加了
`typing.send`，失败信息却说"Expected 里没有、Received 里有"。

原因：`tsconfig.json` 的 `include` 是 `src/**/*.ts`，**测试文件也被编译进了 `dist/`**；
而 `vitest run` 默认把 `dist/**/*.test.js` 也收进来 ——
于是每个用例被跑两遍，其中一遍跑的是**上一次构建的旧代码**。
所以协议包之前显示"50 项测试通过"，实际只有 25 项。

**修法**：三处一起改
- 三个包的 `tsconfig.json` 都 `exclude` 掉 `src/**/*.test.ts(x)`
- `protocol` / `server` 加 `vitest.config.ts`，`include` 只收 `src/**`
- 删掉 `dist/` 里的历史测试产物

**为什么值得记**：这个 bug 不会让 CI 变红（旧测试通常是过的），只会让数字虚高、
让"改了却没生效"看起来像玄学。测试数量虚高一倍这种事，靠审阅数字是发现不了的 ——
必须是某次"我改了但断言说没改"才会撞出来。

---

## 2026-11-17 · agent 是"外部接入方"，不是内置模型

用户澄清了定位：**AgentLink 不接模型**。它的 "agent" 是给外部 AI 运行时
（Claude Code、openclaw、DSH、hermes、脚本）用的接入身份，服务端只做消息通道。

**这带来两件事**：

1. **修正容易误解的地方**：`examples/llm-agent` 里确实在调 `/chat/completions`，
   但那是**调用方**接入了模型 —— 服务端不知道也不关心。该示例已加醒目注释，
   并新增 `examples/http-agent`（纯 HTTP，零模型依赖）作为对照。
   验收里加了客观断言：服务端源码不含任何模型 SDK/端点，http-agent 也不含。

2. **补上真正缺的入口：HTTP + SSE 桥**（`/api/agent/*`）。
   之前外部 agent **必须说 WebSocket** —— 要自己维护连接、重连退避、seq 补发，
   对 CLI 类运行时成本很高。现在：

   | 端点 | 用途 |
   |---|---|
   | `GET /api/agent/self` | 我是谁（响应里写明"只提供消息通道"） |
   | `GET /api/agent/convs` | 我可见的会话 |
   | `GET /api/agent/history` | 历史分页 |
   | `POST /api/agent/messages` | 发消息（`client_msg_id` 幂等） |
   | `POST /api/agent/typing` | 正在输入（瞬时） |
   | `GET /api/agent/events` | **SSE** 持续收事件，`since=<seq>` 断点续拉 |
   | `GET /api/agent/events?once=1` | 一次性批量（给 shell 用） |

**关键取舍：这不是新增协议 op/evt**，而是把 WS 已有的服务端函数
（`sendMessage` / `fetchHistory` / `listConversations`）换个入口暴露出去 ——
所以两个通道语义完全一致，事件帧形状也一样（`{v,kind:'evt',type,seq,ts,data}`），
客户端逻辑可以复用。WS 侧一行没动。

**SSE 走数据库而不是订阅 hub**：直接用 `events` 表按 `seq` 增量拉。
好处是**天然可补发、跨实例一致**（hub 是单实例内存），代价是只有持久化事件能走
这条路 —— `typing`/`poke` 这类瞬时事件不进 SSE（它们过期即无用，本来也不需要）。
需要逐字流式（`stream.delta`）时仍应使用 WebSocket。

**验收**（`agent-http`，31 项）：身份/会话/历史/发消息、**幂等**（同 `client_msg_id`
重发只有一条）、WS↔HTTP 双向（HTTP 发的消息 WS 收到，人发的消息经 SSE 被 agent 收到）、
SSE `content-type` 与帧形状、`?once=1`、非成员 403、缺 token 401、
以及"服务端与 http-agent 都不含模型调用"的客观断言。

---

## 2026-11-17 · 已读回执：只存水位，不写事件表

**协议**：新增 op `read.set {conv_id, last_seq}`、瞬时事件 `read.update`（`seq= null`），
成员对象新增 `last_read_seq`；迁移 `0004` 给 `memberships` 加一列。

**三个关键取舍**：

1. **只存水位，不做逐条回执**。做"每条消息谁读过"需要另一张表，写入量随消息数线性
   增长，而需求确认书也没要求。一个 `last_read_seq` 就够画 ✓✓。
2. **事件瞬时（不落库）**。已读如果每条都进 `events` 表，一个人翻历史就能写几百行，
   补发日志会被刷爆。重连对齐靠 `conv.get` 里的成员水位 —— 这也是为什么
   `Member.last_read_seq` 是必要的，而不是"为了好看"。
3. **只增不减，且用 SQL 的 `MAX()` 兜底**。客户端往上翻历史会上报更小的 seq；
   两个客户端并发上报也可能乱序到达。在 SQL 里写 `SET last_read_seq = MAX(last_read_seq, ?)`
   比"先读后写"更抗并发，也省一次往返。

**语义**：单聊是"对方读到哪"；群聊取**除自己外所有成员的最小水位**（与 TG 一致）。
成员为空（只有自己）时不显示已读状态，避免"1 人已读"这种噪音。

**验收**（`ext-read`，28 项）：水位持久化、只增不减、事件瞬时、events 表 0 行、
补发里没有已读、群聊取最小水位、非成员 `PERM_DENIED`、负数 `VALIDATION_FAILED`。

---

## 2026-11-17 · 表情回应：回全量、带 seq、撤回即清

**协议**：`reaction.add` / `reaction.remove`（入参 `conv_id` + `message_id` + `emoji`）、
事件 `message.reaction`（**带 seq**）、`Message.reactions` 可选字段；迁移 `0005`。

**四个取舍**：

1. **返回全量汇总而不是增量**。增量方案要客户端自己做加/减，一旦丢一帧就会长期
   不一致（而且没法自愈）。全量是"整体替换"，天然幂等。
2. **事件带 seq（可补发）**。回应是**状态**（谁给这条点了什么），断线重连必须补齐；
   对比已读回执那种"过期即无用"的信号用 `seq=null`。两者语义不同，不能一刀切。
3. **`emoji` 只接受单个表情**（1～32 码点 + `Extended_Pictographic` 正则，
   允许 ZWJ 组合与肤色）。放开成任意字符串等于给了一个任意长度的文本注入面。
   服务端校验在协议层，客户端只提供一组常用表情。
4. **撤回即清空**。撤回的消息不该还挂着"👍 2"，所以 `revokeMessageById` 在同一个
   事务里 `clearReactions`，水合时也对 `state='revoked'` 再兜一层。

**顺带修的两处测试自身问题**（都是"会假通过"的类型）：

- 断言撤回后状态时用了 `history.fetch` —— 历史列表**不返回**已撤回的行，
  于是 `find(...)` 得到 `undefined`，"没有回应残留"这条在 `undefined` 上**假通过**。
  改用 `message.get`。
- `message_id` 用了 `m_does_not_exist`，但 ID 有 `m_<ULID>` 格式校验，
  于是拿到的是 `VALIDATION_FAILED` 而不是 `NOT_FOUND` —— 断言写错了预期。
  改用格式合法但不存在的 ULID。

---

## 2026-11-17 · 编辑消息：FTS 才是真考点

**协议**：`message.edit {conv_id, message_id, content}`、事件 `message.edit`（带 seq）、
`Message.edited_at`；迁移 `0006` 只加一列（**不做编辑历史**，需求确认书 §5 排除）。

**最容易出错的地方不是"内容变了"，而是全文索引**：
FTS5 的 `trg_messages_au` 要在同一条 UPDATE 里删旧词条、插新词条。
如果这里错了，用户会**搜到不存在的内容**——比"编辑失败"难查得多。
所以验收里专门断言三件事：旧关键词 0 命中、新关键词 1 命中、`messages_fts`
里旧文本残留为 0。

**编辑的服务端约束**：只能编辑自己的、`state='final'`、未撤回的消息；
流式中的（内容还在变）和已撤回的一律 `CONFLICT`。

**过程中的一个真实事故**：我用 `str.replace` 改 Drizzle schema 加 `editedAt`，
本意只加到 `messages`，但 `replace` 默认替换**全部**匹配 —— 于是
`refresh_tokens` 也被加了一列，而迁移里没有。表现是**注册接口 500**
（"table refresh_tokens has no column named edited_at"），报错还落在
`insertRefreshToken` 上，完全不像"我改了消息表"。
教训：改 schema 这种多表同构的地方，替换后要**数一下命中次数**。
