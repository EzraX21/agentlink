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
 * M0 只做信封层：帧大小、版本、未知 op、未认证拒绝。
 * 认证与 op 分发在 M1 起接入。
 */

export interface OpContext {
  readonly conn: Connection;
  readonly frame: ReqFrame;
}

export type OpHandler = (ctx: OpContext) => Promise<unknown> | unknown;

export class Connection {
  readonly id: string;
  readonly ws: WebSocket;
  /** 认证后填充（M1）。 */
  userId: string | null = null;
  authed = false;

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
  /** op 名 → 处理函数。未注册的 op 回 UNSUPPORTED_OP。 */
  readonly handlers: ReadonlyMap<string, OpHandler>;
  readonly onConnect?: (conn: Connection) => void;
  readonly onClose?: (conn: Connection) => void;
  /** 连接建立后、认证前的兜底超时（协议 §2：5 秒）。 */
  readonly authTimeoutMs?: number;
  readonly requiresAuth?: (op: string) => boolean;
}

export class WsGateway {
  private readonly wss: WebSocketServer;
  private readonly conns = new Set<Connection>();
  private seq = 0;

  constructor(private readonly opts: GatewayOptions) {
    this.wss = new WebSocketServer({
      noServer: true,
      maxPayload: MAX_FRAME_BYTES,
      // 协议 §1：只接受 JSON 文本帧；子协议 agentlink.v1 可选（浏览器不方便设置时也接受）
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
        this.conns.delete(conn);
        this.opts.onClose?.(conn);
      });

      ws.on('error', () => {
        // 底层错误一律以 close 收尾，不额外处理
      });
    });
  }

  private async handleMessage(conn: Connection, raw: Buffer, isBinary: boolean): Promise<void> {
    if (isBinary) {
      // 第一版不用二进制帧（协议 §1）
      conn.send(
        makeResErr('', { code: 'VALIDATION_FAILED', message: '只接受 JSON 文本帧' }),
      );
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
    const handler = this.opts.handlers.get(frame.op);
    if (!handler) {
      // 协议 §12：未知 op 回 UNSUPPORTED_OP，**不断开连接**
      conn.send(
        makeResErr(frame.id, {
          code: 'UNSUPPORTED_OP',
          message: `不支持的操作 ${frame.op}`,
          details: { op: frame.op },
        }),
      );
      return;
    }

    const requiresAuth = this.opts.requiresAuth?.(frame.op) ?? true;
    if (requiresAuth && !conn.authed) {
      conn.send(makeResErr(frame.id, { code: 'AUTH_REQUIRED', message: '请先发送 auth 帧' }));
      return;
    }

    try {
      const data = await handler({ conn, frame });
      conn.send({ v: PROTOCOL_VERSION, kind: 'res', id: frame.id, ok: true, data });
    } catch (err) {
      conn.send(makeResErr(frame.id, toProtocolError(err)));
    }
  }

  /** 向所有已认证连接广播（后续里程碑用）。 */
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
