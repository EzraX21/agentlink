import { WebSocket } from 'ws';
import {
  PROTOCOL_VERSION,
  WS_SUBPROTOCOL,
  type ContextMessage,
  type EvtFrame,
  type Message,
  type ResFrame,
  type SubscriptionFilters,
} from '@agentlink/protocol';

/**
 * AgentLink agent SDK（实现计划 M9）。
 *
 * 目标：agent 作者只写业务，不碰协议细节。
 *
 *   const client = new Client({ url, token });
 *   client.onMessage(async (msg, ctx) => {
 *     const history = await client.context({ conv_id: msg.conv_id });
 *     const stream = await client.stream(msg.conv_id);
 *     await stream.write('你好');
 *     await stream.commit();
 *   });
 *   await client.connect();
 *
 * SDK 负责：自动重连 + resume、@ 订阅、流式状态机、打断处理、限流退避。
 */

export interface ClientOptions {
  readonly url: string;
  readonly token: string;
  /** 只关心被 @ 的消息（默认 true，这是 agent 最常见的用法）。 */
  readonly onlyMentions?: boolean;
  /** 只关心这些会话；省略 = 全部可见。 */
  readonly convIds?: string[];
  /** 重连退避上限，默认 10 秒。 */
  readonly maxBackoffMs?: number;
  readonly logger?: (level: 'info' | 'warn' | 'error', msg: string, extra?: unknown) => void;
}

export interface MessageContext {
  readonly convId: string;
  /** 消息里 @ 本 agent 的文本（已去掉 @ 前缀）。 */
  readonly text: string;
  readonly message: Message;
  readonly client: Client;
}

export type MessageHandler = (ctx: MessageContext) => void | Promise<void>;

export interface StreamHandle {
  readonly messageId: string;
  write(delta: string): Promise<void>;
  commit(): Promise<Message>;
  abort(reason?: string): Promise<void>;
  /** 被人类打断后为 true（之后 write 会抛 STREAM_CLOSED）。 */
  readonly interrupted: boolean;
}

export class StreamClosedError extends Error {
  constructor(messageId: string) {
    super(`流 ${messageId} 已关闭（commit / abort / 被打断）`);
    this.name = 'StreamClosedError';
  }
}

const PING_INTERVAL_MS = 30_000;

export class Client {
  private ws: WebSocket | null = null;
  private pending = new Map<string, { resolve: (f: ResFrame) => void; reject: (e: Error) => void }>();
  private reqSeq = 0;
  private lastSeq = 0;
  private stopped = false;
  private backoffMs = 500;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private pingTimer: NodeJS.Timeout | null = null;
  private handlers: MessageHandler[] = [];
  private streams = new Map<string, { interrupted: boolean }>();
  private ready: Promise<void> | null = null;
  private selfId: string | null = null;
  private selfName: string | null = null;

  constructor(private readonly opts: ClientOptions) {}

  get id(): string | null {
    return this.selfId;
  }

  get displayName(): string | null {
    return this.selfName;
  }

  get connected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  private log(level: 'info' | 'warn' | 'error', msg: string, extra?: unknown): void {
    this.opts.logger?.(level, msg, extra);
  }

  /** 注册消息处理函数（收到 @ 或订阅范围内的新消息时调用）。 */
  onMessage(handler: MessageHandler): void {
    this.handlers.push(handler);
  }

  async connect(): Promise<void> {
    this.stopped = false;
    this.ready = this.#openAndAuth();
    return this.ready;
  }

  async #openAndAuth(): Promise<void> {
    this.log('info', '连接中…');
    const ws = new WebSocket(this.opts.url, [WS_SUBPROTOCOL]);
    this.ws = ws;

    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve());
      ws.once('error', (err) => reject(err));
    });

    ws.on('message', (raw) => {
      this.#onMessage(raw.toString());
    });
    ws.on('close', () => {
      this.#stopPing();
      for (const [, p] of this.pending) p.reject(new Error('连接已关闭'));
      this.pending.clear();
      if (!this.stopped) this.#scheduleReconnect();
    });
    ws.on('error', () => {
      /* close 会跟着来 */
    });

    const authRes = await this.request('auth', { token: this.opts.token });
    if (!authRes.ok) {
      throw new Error(`认证失败: ${authRes.error.code} ${authRes.error.message}`);
    }
    const self = (authRes.data as { self: { id: string; display_name: string } }).self;
    this.selfId = self.id;
    this.selfName = self.display_name;

    // 订阅：默认只关心被 @ 的消息（需求确认书 §4 第 1 项）
    const filters: SubscriptionFilters = {
      only_mentions: this.opts.onlyMentions ?? true,
      ...(this.opts.convIds === undefined ? {} : { conv_ids: this.opts.convIds }),
    };
    await this.request('subscribe.set', { filters });

    // 断线补齐：用 last_seq，而不是重拉全量
    const resumeRes = await this.request('resume', { last_seq: this.lastSeq });
    if (resumeRes.ok) {
      const data = resumeRes.data as { replayed: number; up_to: number; gap: boolean };
      this.log('info', `resume 完成 replayed=${data.replayed} up_to=${data.up_to} gap=${data.gap}`);
      if (data.up_to > this.lastSeq) this.lastSeq = data.up_to;
    }

    this.backoffMs = 500;
    this.#startPing();
    this.log('info', `已连接，身份 ${this.selfName} (${this.selfId})`);
  }

  #scheduleReconnect(): void {
    if (this.reconnectTimer !== null) return;
    const delay = Math.min(this.backoffMs, this.opts.maxBackoffMs ?? 10_000);
    this.backoffMs = Math.min(this.backoffMs * 2, this.opts.maxBackoffMs ?? 10_000);
    this.log('warn', `${delay}ms 后重连…`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.#openAndAuth().catch((err: unknown) => {
        this.log('error', '重连失败', err);
        this.#scheduleReconnect();
      });
    }, delay);
  }

  #startPing(): void {
    this.#stopPing();
    this.pingTimer = setInterval(() => {
      void this.request('ping', {}).catch(() => undefined);
    }, PING_INTERVAL_MS);
    this.pingTimer.unref?.();
  }

  #stopPing(): void {
    if (this.pingTimer !== null) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }

  #onMessage(raw: string): void {
    let frame: unknown;
    try {
      frame = JSON.parse(raw);
    } catch {
      return;
    }
    const kind = (frame as { kind?: string }).kind;
    if (kind === 'res') {
      const res = frame as ResFrame;
      const p = this.pending.get(res.id);
      if (p) {
        this.pending.delete(res.id);
        p.resolve(res);
      }
      return;
    }
    if (kind !== 'evt') return;

    const evt = frame as EvtFrame;
    if (evt.seq !== null && evt.seq > this.lastSeq) this.lastSeq = evt.seq;

    switch (evt.type) {
      case 'message.new': {
        const data = evt.data as { conv_id: string; message: Message };
        // 自己发的消息不回调（否则 agent 会回复自己）
        if (data.message.sender.id === this.selfId) return;
        void this.#dispatch(data.conv_id, data.message);
        break;
      }
      case 'message.update': {
        const data = evt.data as {
          message_id: string;
          rev: number;
          delta: string;
          stream_closed?: boolean;
        };
        // 服务端打断时推的哨兵帧：把该流标记为已关闭
        if (data.stream_closed === true) {
          const st = this.streams.get(data.message_id);
          if (st) st.interrupted = true;
          this.log('warn', `流 ${data.message_id} 被服务端关闭（被打断）`);
        }
        break;
      }
      default:
        // 未知 evt.type 忽略（协议 §6）
        break;
    }
  }

  async #dispatch(convId: string, message: Message): Promise<void> {
    const text = message.content
      .map((b) => (b.type === 'text' ? b.text : ''))
      .join('\n');
    // 去掉 @ 前缀，方便 agent 直接用
    const cleaned = text.replace(/@\S+/g, '').trim();
    for (const h of this.handlers) {
      try {
        await h({ convId, text: cleaned, message, client: this });
      } catch (err) {
        this.log('error', '消息处理器抛错', err);
      }
    }
  }

  request(op: string, data: unknown, timeoutMs = 15_000): Promise<ResFrame> {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error('连接未建立'));
    }
    this.reqSeq += 1;
    const id = `sdk${this.reqSeq}`;
    const frame = { v: PROTOCOL_VERSION, kind: 'req' as const, id, op, data: data ?? {} };
    return new Promise<ResFrame>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${op} 超时`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (f) => {
          clearTimeout(timer);
          resolve(f);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      ws.send(JSON.stringify(frame));
    });
  }

  async call<T>(op: string, data: unknown): Promise<T> {
    const res = await this.request(op, data);
    if (!res.ok) {
      const err = new Error(`${op}: ${res.error.code} ${res.error.message}`) as Error & {
        code?: string;
        details?: unknown;
      };
      err.code = res.error.code;
      err.details = res.error.details;
      throw err;
    }
    return res.data as T;
  }

  // -------------------------------------------------------------------------
  // 业务 API
  // -------------------------------------------------------------------------

  /**
   * 取一段可直接拼 prompt 的会话上下文（协议 §7）。
   * 这是本项目相对"QQ 协议端"的核心差异：agent 不用自己攒历史。
   */
  async context(input: {
    conv_id: string;
    anchor_seq?: number;
    before?: number;
    after?: number;
    include_quoted?: boolean;
    max_chars?: number;
  }): Promise<{ messages: ContextMessage[]; truncated: boolean; dropped_count: number }> {
    return this.call('context.fetch', input);
  }

  /** 发一条普通消息。 */
  async send(input: {
    conv_id: string;
    text: string;
    client_msg_id?: string;
    reply_to?: string;
  }): Promise<{ message_id: string; seq: number }> {
    return this.call('message.send', {
      conv_id: input.conv_id,
      client_msg_id: input.client_msg_id ?? cryptoRandomId(),
      content: [{ type: 'text', text: input.text }],
      ...(input.reply_to === undefined ? {} : { reply_to: input.reply_to }),
    });
  }

  /** 开一条流式回复（协议 §8）。 */
  async stream(convId: string, opts: { replyTo?: string } = {}): Promise<StreamHandle> {
    const begin = await this.call<{ message_id: string; conv_id: string; rev: number }>(
      'stream.begin',
      {
        conv_id: convId,
        client_msg_id: cryptoRandomId(),
        ...(opts.replyTo === undefined ? {} : { reply_to: opts.replyTo }),
      },
    );
    const state = { interrupted: false };
    this.streams.set(begin.message_id, state);

    const self = this;
    const handle: StreamHandle = {
      messageId: begin.message_id,
      get interrupted() {
        return state.interrupted;
      },
      async write(delta: string) {
        if (state.interrupted) throw new StreamClosedError(begin.message_id);
        try {
          await self.call('stream.delta', {
            conv_id: convId,
            message_id: begin.message_id,
            delta,
          });
        } catch (err) {
          if ((err as { code?: string }).code === 'STREAM_CLOSED') {
            state.interrupted = true;
            throw new StreamClosedError(begin.message_id);
          }
          throw err;
        }
      },
      async commit() {
        const res = await self.call<{ message: Message }>('stream.commit', {
          conv_id: convId,
          message_id: begin.message_id,
        });
        self.streams.delete(begin.message_id);
        return res.message;
      },
      async abort(reason?: string) {
        await self.call('stream.abort', {
          conv_id: convId,
          message_id: begin.message_id,
          ...(reason === undefined ? {} : { reason }),
        });
        self.streams.delete(begin.message_id);
      },
    };
    return handle;
  }

  /** 人类打断别人的流（agent 一般不需要，但协议允许）。 */
  async interrupt(convId: string, messageId: string): Promise<void> {
    await this.call('stream.interrupt', { conv_id: convId, message_id: messageId });
  }

  async convList(): Promise<{ items: Array<{ id: string; title: string }> }> {
    return this.call('conv.list', { limit: 100 });
  }

  /** 关闭连接并停止重连。 */
  disconnect(): void {
    this.stopped = true;
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.#stopPing();
    this.ws?.close();
    this.ws = null;
  }

  /** 等待直到连接就绪（测试用）。 */
  async waitReady(timeoutMs = 10_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (this.connected && this.selfId !== null) return;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error('连接未就绪');
  }
}

function cryptoRandomId(): string {
  return globalThis.crypto.randomUUID();
}

export type { EvtFrame, Message, ContextMessage };