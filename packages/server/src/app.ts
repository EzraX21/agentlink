import Fastify, { LogController, type FastifyInstance } from 'fastify';
import type { Server } from 'node:http';
import type { ReqFrame } from '@agentlink/protocol';
import type { Config } from './config.js';
import { loggerOptions } from './logger.js';
import { healthRoutes } from './routes/health.js';
import { authRoutes } from './routes/auth.js';
import { WsGateway, type Connection } from './ws/gateway.js';
import { openDatabase, type OpenedDb } from './db/index.js';
import { AuthService } from './auth/service.js';
import { Hub } from './hub.js';
import type { AppServices } from './services/index.js';
import { makeHandlers, validateData, type HandlerMap } from './ops/dispatch.js';
import { registerM1Handlers } from './ops/m1.js';
import { registerM2Handlers } from './ops/m2.js';
import { registerM3Handlers } from './ops/m3.js';
import { startEventsCleanup } from './services/resume.js';
import { AgentLinkError } from '@agentlink/protocol';

export interface AppOptions {
  config: Config;
  /** 测试用：覆盖数据库路径（`:memory:` 也可）。 */
  databasePath?: string;
}

export interface BuiltApp {
  app: FastifyInstance;
  gateway: WsGateway;
  services: AppServices;
}

/**
 * 组装整个服务端：数据库、认证、事件总线、HTTP 路由、WS 网关与 op 处理器。
 */
export async function buildApp(opts: AppOptions): Promise<BuiltApp> {
  const { config } = opts;

  // 泛型显式钉在 http1 Server 上：不写的话 Fastify 的重载会推断成 Http2SecureServer。
  const app: FastifyInstance = Fastify<Server>({
    logger: loggerOptions(config),
    // 关掉 Fastify 自带的请求日志，改用下面的 onResponse 钩子：
    // 只记 method/url/status，不记 header/body，token 不会落日志（施工守则 §8）。
    logController: new LogController({ disableRequestLogging: true }),
    bodyLimit: 1024 * 1024,
    trustProxy: true,
  });

  app.addHook('onResponse', async (req, reply) => {
    req.log.info({ method: req.method, url: req.url, status: reply.statusCode }, 'request');
  });

  const dbc: OpenedDb = openDatabase({
    path: opts.databasePath ?? config.databasePath,
    autoMigrate: config.autoMigrate,
    logger: app.log,
  });

  const auth = new AuthService(dbc.db, config);
  const hub = new Hub(dbc.db);

  const handlers: HandlerMap = makeHandlers();
  registerM1Handlers(handlers);
  registerM2Handlers(handlers);
  registerM3Handlers(handlers);

  let services: AppServices;

  const gateway = new WsGateway({
    config,
    app,
    requiresAuth: (op) => op !== 'auth',
    dispatch: async (conn: Connection, frame: ReqFrame) => {
      const state = hub.get(conn.id);
      if (!state) throw new AgentLinkError('AUTH_REQUIRED', '连接状态不存在');
      const handler = handlers.get(frame.op);
      if (!handler) {
        throw new AgentLinkError('UNSUPPORTED_OP', `不支持的操作 ${frame.op}`, { op: frame.op });
      }
      return handler({
        conn,
        state,
        services,
        config,
        db: dbc.db,
        hub,
        auth,
        rawData: frame.data,
      });
    },
    onConnect: (conn) => {
      hub.add({
        conn,
        userId: '',
        kind: 'human',
        filters: {},
        lastSeq: 0,
      });
    },
    onClose: (conn) => {
      hub.remove(conn.id);
    },
  });

  services = { config, dbc, hub, auth, gateway };

  await app.register(healthRoutes);
  await app.register(async (instance) => {
    await authRoutes(instance, services);
  });

  gateway.attach(app.server);

  // events 只留 30 天（数据模型 §6.3），每 10 分钟清一次
  const stopCleanup = startEventsCleanup(dbc.db, app.log);

  app.addHook('onClose', async () => {
    stopCleanup();
    await gateway.close();
    dbc.close();
  });

  return { app, gateway, services };
}

export { validateData };
