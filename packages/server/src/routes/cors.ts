import type { FastifyInstance } from 'fastify';

/**
 * 前后端分离部署时的 CORS（**同源托管时完全不启用**）。
 *
 * 三条纪律：
 *   1. **不允许 `*`**：请求带 `Authorization: Bearer`，通配符等于把 token 暴露给
 *      任意站点。必须由 `CORS_ORIGINS` 显式列出来源。
 *   2. 只放行必要的头（authorization / content-type / x-agentlink-conv /
 *      mcp-session-id）与方法，不做 `*`。
 *   3. 预检（OPTIONS）直接 204，不进入业务路由。
 *
 * 为什么不用 @fastify/cors：这个项目的需求只有"列几个来源 + 放行几个头"，
 * 自己写 30 行比多一个依赖更好审（而且通配符的默认行为正是我们想避免的）。
 */
export async function registerCors(
  app: FastifyInstance,
  origins: readonly string[],
): Promise<void> {
  if (origins.length === 0) return; // 同源部署：一个头都不加

  const allowed = new Set(origins);

  app.addHook('onRequest', async (req, reply) => {
    const origin = req.headers.origin;
    if (typeof origin !== 'string' || !allowed.has(origin)) return;

    reply.header('access-control-allow-origin', origin);
    // 让缓存按 Origin 分桶，避免把 A 站的响应喂给 B 站
    reply.header('vary', 'Origin');
    reply.header('access-control-allow-credentials', 'true');

    if (req.method === 'OPTIONS') {
      reply
        .header('access-control-allow-methods', 'GET, POST, DELETE, OPTIONS')
        .header(
          'access-control-allow-headers',
          'authorization, content-type, x-agentlink-conv, mcp-session-id, last-event-id',
        )
        // 预检结果缓存 10 分钟，减少往返
        .header('access-control-max-age', '600')
        .code(204)
        .send();
    }
  });

  app.log.info({ origins }, 'CORS 已启用（前后端分离部署）');
}
