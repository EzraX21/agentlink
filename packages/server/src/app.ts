import Fastify, { type FastifyInstance } from 'fastify';
import type { Server } from 'node:http';
import type { Config } from './config.js';
import { loggerOptions } from './logger.js';
import { healthRoutes } from './routes/health.js';
import { WsGateway } from './ws/gateway.js';

export interface AppOptions {
  config: Config;
}

export interface BuiltApp {
  app: FastifyInstance;
  gateway: WsGateway;
}

/**
 * 组装 Fastify 实例与 WS 网关。
 * 路由与 op 处理在后续里程碑注册到这里。
 */
export async function buildApp(opts: AppOptions): Promise<BuiltApp> {
  const { config } = opts;

  // 泛型显式钉在 http1 Server 上：不写的话 Fastify 的重载会推断成 Http2SecureServer。
  const app: FastifyInstance = Fastify<Server>({
    logger: loggerOptions(config),
    // 访问日志只记 method/url/status，不记 header/body，避免 token 落日志。
    disableRequestLogging: true,
    bodyLimit: 1024 * 1024,
    trustProxy: true,
  });

  app.addHook('onResponse', async (req, reply) => {
    req.log.info({ method: req.method, url: req.url, status: reply.statusCode }, 'request');
  });

  await app.register(healthRoutes);

  const gateway = new WsGateway({
    config,
    app,
    handlers: new Map(),
    requiresAuth: (op) => op !== 'auth',
  });
  gateway.attach(app.server);
  app.addHook('onClose', async () => {
    await gateway.close();
  });

  return { app, gateway };
}
