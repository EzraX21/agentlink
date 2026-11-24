import Fastify, { LogController, type FastifyInstance } from 'fastify';
import type { Server } from 'node:http';
import { networkInterfaces } from 'node:os';
import { bootstrapAdmin } from './services/bootstrap.js';
import type { ReqFrame } from '@agentlink/protocol';
import type { Config } from './config.js';
import { loggerOptions } from './logger.js';
import { healthRoutes } from './routes/health.js';
import { authRoutes } from './routes/auth.js';
import { registerStatic } from './routes/static.js';
import { registerCors } from './routes/cors.js';
import { attachmentRoutes } from './routes/attachments.js';
import { searchRoutes } from './routes/search.js';
import { agentRoutes } from './routes/agent.js';
import { WsGateway, type Connection } from './ws/gateway.js';
import { openDatabase, type OpenedDb } from './db/index.js';
import { AuthService } from './auth/service.js';
import { Hub } from './hub.js';
import type { AppServices } from './services/index.js';
import { makeHandlers, validateData, type HandlerMap } from './ops/dispatch.js';
import { registerM1Handlers } from './ops/m1.js';
import { registerM2Handlers } from './ops/m2.js';
import { registerM3Handlers } from './ops/m3.js';
import { registerM4Handlers, makeStreamHooks } from './ops/m4.js';
import { registerM5Handlers } from './ops/m5.js';
import { registerM8Handlers } from './ops/m8.js';
import { registerTypingHandlers } from './ops/typing.js';
import { registerReadHandlers } from './ops/read.js';
import { registerToolHandlers } from './ops/tools.js';
import { registerReactionHandlers } from './ops/reactions.js';
import { registerEditHandlers } from './ops/edit.js';
import { registerPinHandlers } from './ops/pin.js';
import { registerForwardHandlers } from './ops/forward.js';
import { fromEnv as rateLimiterFromEnv } from './services/ratelimit.js';
import { AttachmentService } from './services/attachments.js';
import { loadHooks, NOOP_HOOKS } from './hooks.js';
import { startAuditCleanup, startEventsCleanup } from './services/resume.js';
import { StreamRegistry } from './services/stream.js';
import { AgentLinkError, makeEvt } from '@agentlink/protocol';
import { findMessage } from './db/queries.js';

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
    // 请求体上限必须容得下**最大的合法请求**，也就是一个附件上传。
    // 之前写死 1 MiB，导致"放开附件上限后文件仍被截断成 1 MiB"——
    // 而且路由级 bodyLimit 覆盖对 multipart 不生效，只能在这里设。
    // JSON 接口的安全不依赖这个值（schema 校验 + 限流 + 字段上限都在别处）。
    bodyLimit:
      config.maxAttachmentBytes > 0
        ? Math.max(1024 * 1024, config.maxAttachmentBytes + 1024 * 1024)
        : 2 ** 31,
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

  // 流式注册表：打断时要能通知到生成方的那条连接，所以先建 registry，
  // 通知函数里再查 gateway 的连接表。
  const streams = new StreamRegistry(
    dbc.db,
    makeStreamHooks(hub, (messageId) => {
      const row = findMessage(dbc.db, messageId);
      if (!row) return;
      for (const state of hub.connectionsOfUser(row.senderId)) {
        state.conn.send(
          makeEvt(
            'message.update',
            null,
            Date.now(),
            {
              conv_id: row.convId,
              message_id: messageId,
              rev: 0,
              delta: '',
              stream_closed: true,
            },
          ),
        );
      }
    }),
  );

  registerM4Handlers(handlers, streams);

  const limiter = rateLimiterFromEnv();
  const attachments = new AttachmentService(dbc.db, config.uploadsDir);
  registerM5Handlers(handlers, limiter);
  registerM8Handlers(handlers);
  // 协议扩展（docs/PROPOSAL-protocol-ext.md）：打字指示
  registerTypingHandlers(handlers);
  registerReadHandlers(handlers);
  registerToolHandlers(handlers);
  registerReactionHandlers(handlers);
  registerEditHandlers(handlers);
  registerPinHandlers(handlers);
  registerForwardHandlers(handlers);

  // 启动时清理残留的 streaming 消息（数据模型 §6.4）
  const recovered = streams.recoverStaleOnBoot();
  if (recovered.finalized > 0 || recovered.deleted > 0) {
    app.log.warn(recovered, '启动时收尾了残留的流式消息');
  }

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
      // 生成方断开：它名下未完成的流按 abort 语义收尾（空内容则删）
      if (conn.userId !== null) {
        streams.abortAllOf(conn.userId);
      }
    },
  });

  const hooks = config.hooksModule === null
    ? NOOP_HOOKS
    : ((await loadHooks(config.hooksModule, app.log)) ?? NOOP_HOOKS);

  services = { config, dbc, hub, auth, gateway, streams, limiter, attachments, hooks };

  await app.register(healthRoutes);
  await app.register(async (instance) => {
    await authRoutes(instance, services);
  });
  await app.register(async (instance) => {
    await attachmentRoutes(instance, services);
  });
  await app.register(async (instance) => {
    await searchRoutes(instance, services);

    // 外部 agent 的 HTTP + SSE 接入面（docs/AGENT-INTEGRATION.md）
    //
    // NDJSON 的流式回复体要**边到边处理**，不能被 Fastify 缓冲成一个字符串，
    // 所以这里注册一个把原始流原样交给 handler 的解析器。
    instance.addContentTypeParser('application/x-ndjson', (_req, payload, done) => {
      done(null, payload);
    });
    await agentRoutes(instance, services);
  });

  // 前后端分离：CORS 要在业务路由之前挂（预检要能直接 204 返回）
  await registerCors(app, config.corsOrigins);

  // 同源托管是可选的：设了 PUBLIC_DIR 才托管 Web 产物；
  // 分离部署时把它留空，服务端就只提供 API 与 WS。
  await registerStatic(app, config.publicDir);

  gateway.attach(app.server);

  // 首次启动：库里没有人类账号时自动建管理员，并把凭据打在日志里。
  // 一键启动的容器全靠这个 —— 否则用户面对一个空库不知道该拿什么账号进管理页。
  const boot = await bootstrapAdmin(dbc.db, config);
  logAccessBanner(app, config, boot);

  // events 只留 30 天（数据模型 §6.3），每 10 分钟清一次
  const stopCleanup = startEventsCleanup(dbc.db, app.log);
  // 审计日志保留期清理（安全日志通常要比业务事件留得更久，所以是独立配置）
  const stopAuditCleanup = startAuditCleanup(dbc.db, config.auditRetentionDays, app.log);

  app.addHook('onClose', async () => {
    stopCleanup();
    stopAuditCleanup();
    await gateway.close();
    dbc.close();
  });

  // 连接断开时收尾它名下未完成的流（空内容则删），避免留下僵尸 streaming 行
  app.addHook('onClose', async () => {
    /* 流式上下文随进程结束；单条连接的收尾在 gateway 的 onClose 里做 */
  });

  return { app, gateway, services };
}

export { validateData };

/**
 * 把"管理页在哪、用什么账号进"打进启动日志。
 *
 * 容器场景下这是唯一可靠的告知渠道：用户 `docker logs` 就能看到，
 * 不用翻文档猜端口，也不用先注册一个账号再"碰巧"成为管理员。
 */
function logAccessBanner(
  app: FastifyInstance,
  config: Config,
  boot: Awaited<ReturnType<typeof bootstrapAdmin>>,
): void {
  // 对外地址优先用显式配置；没有就枚举非回环网卡 —— 容器里看不到宿主的
  // 公网/局域网地址，猜出来的可能不准，但比只报 127.0.0.1 有用得多。
  const urls: string[] = [];
  if (config.publicUrl !== null) {
    urls.push(config.publicUrl.replace(/\/$/, ''));
  } else {
    const port = config.port === 80 || config.port === 443 ? '' : `:${config.port}`;
    for (const list of Object.values(networkInterfaces())) {
      for (const net of list ?? []) {
        if (net.family === 'IPv4' && !net.internal) {
          urls.push(`http://${net.address}${port}`);
        }
      }
    }
    if (urls.length === 0) urls.push(`http://127.0.0.1${port}`);
  }

  const lines = ['', '='.repeat(64), '  AgentLink 服务端已启动', ''];
  for (const u of urls) lines.push(`  管理页： ${u}`);
  // 容器里枚举到的是**容器内网地址**（172.17.x.x），宿主机与局域网都访问不到。
  // 不解释一下的话，用户照着日志里那个地址去浏览器打，必然失败。
  if (config.publicUrl === null) {
    lines.push(
      '',
      '  注：若在 Docker 里运行，上面是容器内网地址，宿主/局域网请用',
      '      映射到宿主机的地址（如 http://<本机IP>:<映射端口>）。',
      '      想让它显示正确地址，启动时加 -e PUBLIC_URL=http://你的地址:端口',
    );
  }

  if (boot.created) {
    lines.push(
      '',
      '  首次启动，已自动创建管理员账号：',
      `    用户名： ${boot.username ?? ''}`,
      `    密码：   ${boot.password ?? ''}`,
      '',
      '  登录后请立刻改密码（管理页引导的第一项就是它）。',
    );
    if (boot.credentialsPath !== null) {
      lines.push(`  这串凭据也写在了容器内：${boot.credentialsPath}`);
    }
  } else {
    lines.push('', '  管理员账号已存在（首次启动时创建，凭据见数据目录 initial-admin.txt）。');
  }

  lines.push('', '='.repeat(64), '');
  for (const line of lines) app.log.info(line);
}
