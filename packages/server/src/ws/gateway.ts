import { WebSocketServer, type WebSocket } from 'ws';
import type { Server } from 'node:http';
import type { FastifyInstance } from 'fastify';
import {
  AgentLinkError,
  ERROR_CODES,
  MAX_FRAME_BYTES,
  PROTOCOL_VERSION,
  WS_SUBPROTOCOL,
  makeResErr,
  parseReqFrame,
  type ErrorCode,
  type ReqFrame,
  type WireError,
} from '@agentlink/protocol';
import type { Config } from '../config.js';

/**
 * WS 网关（协议 §1、§2、§12）。
 *
 * 只负责信封层：帧大小、版本、未认证拒绝、分发与错误转换。
 * 具体 op 由 `dispatch` 处理，这样网关不认识任何业务概念。
 */

export class Connection {
  readonly id: string;
  readonly ws: WebSocket;
  /** 认证后填充（M1）。 */
  userId: string | null = null;
  authed = false;
  authKind: 'human' | 'agent' | null = null;
  /** 每连接自定义的清理回调（订阅、流式上下文等）。 */
  readonly cleanups = new Set<() => void>();

  constructor(id: string, ws: WebSocket) {
    this.id = id;
    this.ws = ws;
  }

  send(frame: unknown): void {
    if (this.ws.readyState === this.ws.OPEN) {
      this.ws.send(JSON.stringify(frame));
    }
  }

  close(code: number, reason: string): void {
    try {
      this.ws.close(code, reason);
    } catch {
      /* 已关闭 */
    }
  }
}

export interface GatewayOptions {
  readonly config: Config;
  readonly app: FastifyInstance;
  /** 分发一个已通过信封校验的 req。抛 AgentLinkError 会被转成 res.ok=false。 */
  readonly dispatch: (conn: Connection, frame: ReqFrame) => Promise<unknown>;
  /** 该 op 是否要求已认证。默认除 auth 外都要求。 */
  readonly requiresAuth?: (op: string) => boolean;
  readonly onConnect?: (conn: Connection) => void;
  readonly onClose?: (conn: Connection) => void;
  /** 连接建立后、认证前的兜底超时（协议 §2：5 秒）。 */
  readonly authTimeoutMs?: number;
}

export class WsGateway {
  private readonly wss: WebSocketServer;
  private readonly conns = new Set<Connection>();
  private seq = 0;

  constructor(private readonly opts: GatewayOptions) {
    this.wss = new WebSocketServer({
      noServer: true,
      maxPayload: MAX_FRAME_BYTES,
      // 协议 §1 + 施工守则 §7：声明 agentlink.v1 时回显，不声明也接受。
      handleProtocols: (protocols) => (protocols.has(WS_SUBPROTOCOL) ? WS_SUBPROTOCOL : false),
    });
  }

  attach(server: Server): void {
    server.on('upgrade', (req, socket, head) => {
      const url = new URL(req.url ?? '/', 'http://localhost');
      if (url.pathname !== '/ws') {
        socket.destroy();
        return;
      }
      this.wss.handleUpgrade(req, socket, head, (ws) => {
        this.wss.emit('connection', ws, req);
      });
    });

    this.wss.on('connection', (ws: WebSocket) => {
      this.seq += 1;
      const conn = new Connection(`conn-${this.seq}`, ws);
      this.conns.add(conn);
      this.opts.onConnect?.(conn);

      const authTimer = setTimeout(() => {
        if (!conn.authed) {
          // 协议 §2：5 秒不认证 → close(1008)
          conn.close(1008, 'auth timeout');
        }
      }, this.opts.authTimeoutMs ?? 5000);
      authTimer.unref?.();

      ws.on('message', (raw, isBinary) => {
        void this.handleMessage(conn, raw as Buffer, isBinary);
      });

      ws.on('close', () => {
        clearTimeout(authTimer);
        for (const fn of conn.cleanups) {
          try {
            fn();
          } catch {
            /* 清理失败不影响其他清理 */
          }
        }
        conn.cleanups.clear();
        this.conns.delete(conn);
        this.opts.onClose?.(conn);
      });

      ws.on('error', () => {
        // 底层错误一律以 close 收尾
      });
    });
  }

  private async handleMessage(conn: Connection, raw: Buffer, isBinary: boolean): Promise<void> {
    if (isBinary) {
      // 第一版不用二进制帧（协议 §1）
      conn.send(makeResErr('', { code: 'VALIDATION_FAILED', message: '只接受 JSON 文本帧' }));
      return;
    }
    if (raw.byteLength > MAX_FRAME_BYTES) {
      // 协议 §1：超限回 PAYLOAD_TOO_LARGE，**不断开连接**
      conn.send(
        makeResErr('', {
          code: 'PAYLOAD_TOO_LARGE',
          message: `单帧超过 ${MAX_FRAME_BYTES} 字节`,
          details: { limit_bytes: MAX_FRAME_BYTES },
        }),
      );
      return;
    }

    let json: unknown;
    try {
      json = JSON.parse(raw.toString('utf8'));
    } catch {
      conn.send(makeResErr('', { code: 'VALIDATION_FAILED', message: '帧不是合法 JSON' }));
      return;
    }

    const parsed = parseReqFrame(json);
    if (!parsed.ok) {
      if (parsed.reason === 'version') {
        conn.send(
          makeResErr(parsed.id, {
            code: 'UNSUPPORTED_VERSION',
            message: `只支持协议版本 ${PROTOCOL_VERSION}`,
            details: { supported: [PROTOCOL_VERSION], got: parsed.got ?? -1 },
          }),
        );
      } else {
        conn.send(
          makeResErr(parsed.id, {
            code: 'VALIDATION_FAILED',
            message: '帧信封不合法',
            details: { issues: [{ path: 'frame', message: '缺少 v/kind/id/op' }] },
          }),
        );
      }
      return;
    }

    const frame = parsed.frame;
    const requiresAuth = this.opts.requiresAuth?.(frame.op) ?? frame.op !== 'auth';
    if (requiresAuth && !conn.authed) {
      conn.send(makeResErr(frame.id, { code: 'AUTH_REQUIRED', message: '请先发送 auth 帧' }));
      return;
    }

    try {
      const data = await this.opts.dispatch(conn, frame);
      conn.send({ v: PROTOCOL_VERSION, kind: 'res', id: frame.id, ok: true, data });
    } catch (err) {
      if (!(err instanceof AgentLinkError)) {
        this.opts.app.log.error({ err, op: frame.op }, 'op 处理异常');
      }
      conn.send(makeResErr(frame.id, toProtocolError(err)));
      if (frame.op === 'auth') {
        // 协议 §2：认证失败 → 回 error 响应，服务端 close(1008)
        conn.close(1008, 'auth failed');
      }
    }
  }

  /** 向所有已认证连接广播。 */
  broadcast(frame: unknown, filter?: (conn: Connection) => boolean): number {
    let n = 0;
    for (const conn of this.conns) {
      if (!conn.authed) continue;
      if (filter && !filter(conn)) continue;
      conn.send(frame);
      n += 1;
    }
    return n;
  }

  get connections(): readonly Connection[] {
    return [...this.conns];
  }

  /** 关闭某个用户的全部连接（轮换 token / 停用 agent 时用）。 */
  closeUserConnections(userId: string, code = 1008, reason = 'token rotated'): number {
    let n = 0;
    for (const conn of this.conns) {
      if (conn.userId === userId) {
        conn.close(code, reason);
        n += 1;
      }
    }
    return n;
  }

  async close(): Promise<void> {
    for (const conn of this.conns) conn.close(1001, 'server shutdown');
    await new Promise<void>((resolve) => this.wss.close(() => resolve()));
  }
}

/**
 * 内部异常 → 线上错误对象。
 * AgentLinkError 带稳定 code；其余一律回一个客户端可分支的 code。
 */
export function toProtocolError(err: unknown): WireError {
  if (err instanceof AgentLinkError) {
    const pe = err.toProtocolError();
    return pe.details === undefined
      ? { code: pe.code, message: pe.message }
      : { code: pe.code, message: pe.message, details: pe.details };
  }
  if (typeof err === 'object' && err !== null && 'code' in err && 'message' in err) {
    const e = err as { code: unknown; message: unknown; details?: unknown };
    if (typeof e.code === 'string' && isErrorCode(e.code) && typeof e.message === 'string') {
      const out: WireError = { code: e.code, message: e.message };
      if (e.details !== undefined) out.details = e.details;
      return out;
    }
  }
  return { code: 'CONFLICT', message: '服务端内部错误' };
}

function isErrorCode(code: string): code is ErrorCode {
  return (ERROR_CODES as readonly string[]).includes(code);
}
