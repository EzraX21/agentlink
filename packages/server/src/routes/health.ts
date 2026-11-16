import type { FastifyInstance } from 'fastify';

/**
 * 健康检查（协议 §1）：`GET /healthz` → 200 `{"ok":true}`。
 * Docker HEALTHCHECK 也打这个（实现计划 M10）。
 */
export async function healthRoutes(app: FastifyInstance): Promise<void> {
  app.get('/healthz', async () => ({ ok: true }));
}
