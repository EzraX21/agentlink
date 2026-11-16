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
