/**
 * 客户端如何找到服务端（**前后端分离**的关键）。
 *
 * 部署形态有两种，这个模块同时支持：
 *
 * 1. **同源托管**（服务端用 `PUBLIC_DIR` 托管构建产物）：`API_BASE` 为空，
 *    请求走相对路径 `/api/...`，WebSocket 用当前 host。零配置。
 * 2. **前后端分离**（客户端在 CDN / 另一个域名 / Vite dev server）：
 *    构建时设 `VITE_API_BASE=https://api.example.com`，所有请求与 WS 都指向它。
 *
 * 为什么不在各处散着写 `location.host`：那样分离部署时每一处都要改，
 * 漏一处就是"某些功能跨域失败"这种难查的问题。集中到这一个文件，
 * 并让 `apiUrl()` / `wsUrl()` 成为唯一入口。
 */

/** 构建期注入的服务端地址；空字符串 = 同源。末尾斜杠去掉，避免拼出 `//api`。 */
const RAW_BASE: string = import.meta.env['VITE_API_BASE'] ?? '';

/** 例如 `https://api.example.com` 或 `''`（同源）。 */
export const API_BASE: string = RAW_BASE.replace(/\/$/, '');

/** 是否处于前后端分离模式。 */
export const IS_SPLIT: boolean = API_BASE !== '';

/**
 * 把 `/api/...` 这类路径解析成完整 URL。
 * 同源模式下原样返回（相对路径，交给浏览器），分离模式下加上 base。
 */
export function apiUrl(path: string): string {
  if (!path.startsWith('/')) {
    throw new Error(`apiUrl 只接受以 / 开头的路径，收到: ${path}`);
  }
  return `${API_BASE}${path}`;
}

/**
 * WebSocket 地址。
 *
 * token 仍然只在帧体内、URL 里不带凭证（协议 §2.4）—— 分离部署不改变这一点。
 * `wss:` 跟随 base 的协议：base 是 https 就必须用 wss，否则浏览器会拦。
 */
export function wsUrl(): string {
  if (API_BASE === '') {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${proto}//${location.host}/ws`;
  }
  const url = new URL(API_BASE);
  const proto = url.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${url.host}/ws`;
}
