# 前后端分离部署

默认形态是**同源**：服务端用 `PUBLIC_DIR` 托管构建好的客户端，`/api` 与 `/ws` 同域，
零配置。这份文档讲另一种：**客户端与服务端分开部署**（客户端放 CDN / 另一个域名）。

## 为什么支持分离

- 客户端可以独立发布（改 UI 不必重启 API）
- 客户端可以放 CDN，静态资源走边缘节点
- 多个环境（staging/prod）共用一个 API 时更清楚

## 服务端：只管 API

```bash
# 不设 PUBLIC_DIR → 不再托管前端，/ 返回 404
PUBLIC_DIR= CORS_ORIGINS=https://app.example.com DATABASE_PATH=/data/agentlink.db UPLOADS_DIR=/data/uploads JWT_SECRET=... AGENT_TOKEN_PEPPER=... node packages/server/dist/index.js
```

`CORS_ORIGINS` 是**逗号分隔的白名单**，会逐字回显命中的来源。

**不允许 `*`**：请求带 `Authorization: Bearer`，通配符等于把 token 暴露给任意站点。
非白名单来源拿不到任何 CORS 头，浏览器会拦下来 —— 这是明确的拒绝，不是"忘了加"。

预检 `OPTIONS` 直接 204，放行的头是：
`authorization, content-type, x-agentlink-conv, mcp-session-id, last-event-id`。

## 客户端：构建时指向服务端

```bash
VITE_API_BASE=https://api.example.com pnpm --filter @agentlink/web build
```

产物里所有请求与 WebSocket 都指向这个地址（见 `packages/web/src/lib/endpoint.ts`）。
不设 `VITE_API_BASE` 就是同源模式，请求走相对路径。

`wss:` 跟随 base 的协议：base 是 `https` 就必须用 `wss`，否则浏览器会拦。

## 本地开发（分离形态）

```bash
# 终端 1：服务端
pnpm --filter @agentlink/server dev

# 终端 2：客户端 dev server（默认代理到 127.0.0.1:3000）
pnpm --filter @agentlink/web dev

# 想把客户端指到另一台机器的服务端：
VITE_PROXY_TARGET=http://192.168.1.50:3000 pnpm --filter @agentlink/web dev
```

## 验收

`scripts/acceptance/split.mjs` 真跑这条链路：

1. 服务端不设 `PUBLIC_DIR` → `/` 是 404
2. 起一个**独立的静态服务器**（模拟 CDN，随机端口）
3. 用那个端口作为 `CORS_ORIGINS` 重启服务端
4. 用**最终** API 地址构建客户端（顺序很重要：先重启再构建，
   否则产物指向旧端口，浏览器里表现为 `Failed to fetch`）
5. 浏览器里真跑：跨域注册 → 登录 → WebSocket 连上

跑法：`node scripts/acceptance/run.mjs split`

## 一个容易踩的顺序问题

构建客户端需要知道**最终**的 API 地址，而服务端的端口在重启后可能变。
所以顺序必须是：

```
起静态服务器 → 拿到客户端来源 → 重启服务端(带 CORS) → 拿到最终 API 地址 → 构建客户端
```

我在验收脚本里第一版把构建放在重启之前，产物指向旧端口，浏览器报 `Failed to fetch` ——
现象看起来像"CORS 没配对"，实际是产物里的地址过期了。
