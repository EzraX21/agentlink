import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { FastifyInstance } from 'fastify';
import fastifyStatic from '@fastify/static';

/**
 * 生产部署时由服务端自己托管构建好的 Web 产物（M10 的 Docker 镜像就是这么跑的）。
 * 本地开发用 Vite 的 dev server + 代理，不启用。
 *
 * `PUBLIC_DIR` 未设置时整个函数是空操作，所以不影响开发与验收。
 */
export async function registerStatic(app: FastifyInstance, publicDir: string | null): Promise<void> {
  if (publicDir === null) return;
  const root = resolve(publicDir);
  if (!existsSync(root)) {
    app.log.warn({ root }, 'PUBLIC_DIR 不存在，跳过静态资源托管');
    return;
  }

  await app.register(fastifyStatic, { root, prefix: '/' });

  // SPA 兜底：非 /api、非 /ws、非 /healthz、且不带扩展名的 GET 一律回 index.html
  app.setNotFoundHandler((req, reply) => {
    const url = req.url;
    const isSpaRoute =
      req.method === 'GET' &&
      !url.startsWith('/api') &&
      !url.startsWith('/ws') &&
      !url.startsWith('/healthz') &&
      !/\.[a-z0-9]+$/i.test(url);
    if (isSpaRoute) {
      return reply.type('text/html').sendFile('index.html');
    }
    return reply.code(404).send({ error: { code: 'NOT_FOUND', message: '路径不存在' } });
  });

  app.log.info({ root }, '静态资源托管已启用');
}