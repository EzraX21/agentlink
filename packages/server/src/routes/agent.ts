import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { AgentLinkError, EVENTS } from '@agentlink/protocol';
import type { AppServices } from '../services/index.js';
import { requireUser } from './auth.js';
import { sendError } from './errors.js';
import { sendMessage } from '../services/messages.js';
import { fetchHistory } from '../services/messages.js';
import { listConversations } from '../services/conversations.js';
import { requireMembership } from '../permissions.js';
import { findUserById } from '../db/queries.js';

/**
 * 外部 agent 的 HTTP 接入面（`/api/agent/*`）。
 *
 * ## 为什么需要它
 *
 * AgentLink 里的 "agent" 是**外部 AI 运行时的接入身份**（Claude Code、openclaw、
 * DSH、hermes……），本服务**不内置模型**、也不调用任何模型。主协议是 WebSocket
 * （协议 §2），但让每个外部运行时都自己维护 WS 连接、重连退避、seq 补发，
 * 成本远高于"调 HTTP"。
 *
 * 所以这里做一个**薄桥**：语义完全复用服务端已有的服务函数
 * （`sendMessage` / `fetchHistory` / `listConversations`），只是把入口从 WS 帧换成 HTTP，
 * 把"服务端推给你"换成 **SSE 流**。**不新增协议 op/evt**，WS 客户端不受影响。
 *
 * 端点：
 *   GET  /api/agent/self                 我是谁（也可以用来自检 token）
 *   GET  /api/agent/convs                我可见的会话
 *   GET  /api/agent/history              ?conv_id=&limit=&before_seq=
 *   POST /api/agent/messages             发消息（client_msg_id 幂等，同 §5.3）
 *   POST /api/agent/typing               上报"正在输入"（同 typing.send 语义）
 *   GET  /api/agent/events               SSE：?since=<seq>，从该 seq 之后往前推
 *   GET  /api/agent/events?once=1        一次性取一批（给 shell / 简单脚本用）
 *
 * 鉴权：`Authorization: Bearer <agent token>`（人类 token 也能用，方便调试）。
 */

const SSE_HEARTBEAT_MS = 15_000;
const SSE_POLL_MS = 400;

interface AgentEventRow {
  seq: number;
  type: string;
  conv_id: string | null;
  payload: string;
  created_at: number;
}

export async function agentRoutes(app: FastifyInstance, services: AppServices): Promise<void> {
  const db = services.dbc.db;
  // 直接查 events 表：Drizzle 的封装没有暴露 prepare，而这里是
  // "按 seq 增量拉一页"这种很直白的查询，用底层 sqlite 句柄更清楚
  const raw = services.dbc.raw;

  const who = async (req: FastifyRequest): Promise<{ userId: string; kind: string }> => {
    return requireUser(services, req.headers as Record<string, string | string[] | undefined>);
  };

  /** 取 seq 之后的事件（只含持久化事件：typing/poke 这类瞬时事件不在表里）。 */
  const eventsSince = (since: number, limit: number): AgentEventRow[] =>
    raw
      .prepare(
        `SELECT seq, type, conv_id, payload, created_at
           FROM events
          WHERE seq > ?
          ORDER BY seq ASC
          LIMIT ?`,
      )
      .all(since, limit) as AgentEventRow[];

  const toEvt = (row: AgentEventRow): Record<string, unknown> => ({
    v: 1,
    kind: 'evt',
    type: row.type,
    seq: row.seq,
    ts: row.created_at,
    data: JSON.parse(row.payload) as unknown,
  });

  // -------------------------------------------------------------------------
  // 自检
  // -------------------------------------------------------------------------
  app.get('/api/agent/self', async (req, reply) => {
    try {
      const me = await who(req);
      const user = findUserById(db, me.userId);
      if (!user) throw new AgentLinkError('AUTH_INVALID', '账号不存在');
      return reply.send({
        self: {
          id: user.id,
          kind: user.kind,
          display_name: user.displayName,
          tenant_id: user.tenantId,
        },
        server_time: Date.now(),
        // 明确告诉外部运行时：这里只做消息中转，不替你调模型
        note: 'AgentLink 只提供消息通道；模型调用发生在你自己的进程里。',
      });
    } catch (err) {
      return sendError(reply, err);
    }
  });

  // -------------------------------------------------------------------------
  // 会话与历史
  // -------------------------------------------------------------------------
  app.get('/api/agent/convs', async (req, reply) => {
    try {
      const me = await who(req);
      const items = listConversations(db, me.userId, 100).items;
      return reply.send({ items });
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.get('/api/agent/history', async (req, reply) => {
    try {
      const me = await who(req);
      const q = req.query as { conv_id?: string; limit?: string; before_seq?: string };
      if (q.conv_id === undefined) {
        throw new AgentLinkError('VALIDATION_FAILED', '缺少 conv_id', {
          issues: [{ path: 'conv_id', message: 'required' }],
        });
      }
      requireMembership(db, q.conv_id, me.userId);
      const limit = Math.min(100, Math.max(1, Number(q.limit ?? 50) || 50));
      const beforeSeq = q.before_seq === undefined ? undefined : Number(q.before_seq);
      const page = fetchHistory(db, {
        convId: q.conv_id,
        userId: me.userId,
        limit,
        ...(beforeSeq === undefined || Number.isNaN(beforeSeq) ? {} : { beforeSeq }),
      });
      return reply.send(page);
    } catch (err) {
      return sendError(reply, err);
    }
  });

  // -------------------------------------------------------------------------
  // 发消息（与 WS 的 message.send 语义完全一致：同一个服务函数、同样的幂等）
  // -------------------------------------------------------------------------
  app.post('/api/agent/messages', async (req, reply) => {
    try {
      const me = await who(req);
      const body = req.body as {
        conv_id?: string;
        text?: string;
        content?: unknown;
        client_msg_id?: string;
        reply_to?: string;
      } | null;
      if (body === null || typeof body !== 'object' || body.conv_id === undefined) {
        throw new AgentLinkError('VALIDATION_FAILED', '缺少 conv_id', {
          issues: [{ path: 'conv_id', message: 'required' }],
        });
      }

      // 便捷写法：直接给 text，服务端包成 content 块；给 content 则原样用
      const content =
        body.content !== undefined
          ? body.content
          : typeof body.text === 'string'
            ? [{ type: 'text', text: body.text }]
            : undefined;
      if (content === undefined) {
        throw new AgentLinkError('VALIDATION_FAILED', '需要 text 或 content', {
          issues: [{ path: 'content', message: 'required' }],
        });
      }

      // client_msg_id 省略时用「时间戳+随机」生成：仍然落库做幂等键，
      // 但调用方重试时必须自己带上同一个 id 才有幂等效果（文档里写清楚了）。
      const clientMsgId =
        body.client_msg_id ?? `http_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;

      const result = sendMessage(db, {
        convId: body.conv_id,
        senderId: me.userId,
        clientMsgId,
        content: content as never,
        ...(body.reply_to === undefined ? {} : { replyTo: body.reply_to }),
      });

      // 事务已经提交（sendMessage 内部），这里推送是安全的
      services.hub.publish({
        type: 'message.new',
        seq: result.seq,
        convId: body.conv_id,
        data: {
          conv_id: body.conv_id,
          message: result.message,
          mentions: result.mentions,
        },
      });

      return reply.send({
        message_id: result.messageId,
        seq: result.seq,
        client_msg_id: result.clientMsgId,
        created_at: result.createdAt,
        duplicate: result.duplicate,
      });
    } catch (err) {
      return sendError(reply, err);
    }
  });

  // -------------------------------------------------------------------------
  // 打字指示（与 WS 的 typing.send 一样：瞬时、去重由服务端做）
  // -------------------------------------------------------------------------
  app.post('/api/agent/typing', async (req, reply) => {
    try {
      const me = await who(req);
      const body = req.body as { conv_id?: string } | null;
      if (body === null || typeof body !== 'object' || body.conv_id === undefined) {
        throw new AgentLinkError('VALIDATION_FAILED', '缺少 conv_id', {
          issues: [{ path: 'conv_id', message: 'required' }],
        });
      }
      requireMembership(db, body.conv_id, me.userId);
      const user = findUserById(db, me.userId);
      services.hub.publish({
        type: 'typing',
        seq: null,
        convId: body.conv_id,
        data: {
          conv_id: body.conv_id,
          user_id: me.userId,
          ...(user === undefined || user === null
            ? {}
            : { user: { id: user.id, kind: user.kind, display_name: user.displayName } }),
        },
      });
      return reply.send({ ok: true });
    } catch (err) {
      return sendError(reply, err);
    }
  });

  // -------------------------------------------------------------------------
  // 事件流：SSE（默认）或一次性批量（?once=1）
  // -------------------------------------------------------------------------
  app.get('/api/agent/events', async (req, reply: FastifyReply) => {
    let me: { userId: string };
    try {
      me = await who(req as FastifyRequest);
    } catch (err) {
      return sendError(reply, err);
    }
    const q = (req as FastifyRequest).query as { since?: string; once?: string };
    const since = Number(q.since ?? 0) || 0;

    // 一次性批量：给 curl / shell 用（不需要处理长连接）
    if (q.once === '1') {
      const rows = eventsSince(since, 200);
      return reply.send({
        events: rows.map(toEvt),
        next_seq: rows.length === 0 ? since : (rows[rows.length - 1]?.seq ?? since),
      });
    }

    // SSE：先写头，然后边轮询边推
    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    reply.raw.write(`retry: 3000\n\n`);
    reply.raw.write(`event: ready\ndata: ${JSON.stringify({ since })}\n\n`);

    let cursor = since;
    let closed = false;
    const write = (chunk: string): void => {
      if (!closed) reply.raw.write(chunk);
    };

    const flushNew = (): void => {
      const rows = eventsSince(cursor, 200);
      for (const row of rows) {
        cursor = row.seq;
        write(`id: ${row.seq}\nevent: agentlink\ndata: ${JSON.stringify(toEvt(row))}\n\n`);
      }
    };

    flushNew();
    const poll = setInterval(() => {
      try {
        flushNew();
      } catch {
        // 数据库忙等偶发错误不该断流
      }
    }, SSE_POLL_MS);
    const beat = setInterval(() => write(`: ping\n\n`), SSE_HEARTBEAT_MS);

    const cleanup = (): void => {
      if (closed) return;
      closed = true;
      clearInterval(poll);
      clearInterval(beat);
      reply.raw.end();
    };
    (req as FastifyRequest).raw.on('close', cleanup);
    (req as FastifyRequest).raw.on('error', cleanup);
    // 不 return reply：连接由 raw 流自己管，Fastify 不要再去结束它
    void me;
    return undefined;
  });
}

/** 供验收脚本断言：桥接面覆盖的事件类型必须都是**已持久化**的类型。 */
export function bridgeEventTypes(): string[] {
  return Object.entries(EVENTS)
    .filter(([, def]) => def.seq !== false)
    .map(([name]) => name);
}
