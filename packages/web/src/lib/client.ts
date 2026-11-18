import { apiUrl } from './endpoint.js';
import {
  PROTOCOL_VERSION,
  WS_SUBPROTOCOL,
  type EvtFrame,
  type ReqFrame,
  type ResFrame,
} from '@agentlink/protocol';

/**
 * 浏览器侧的 WS 客户端。
 *
 * 职责（协议 §2、§4、§8）：
 *   - 首帧 auth，token **只放在帧体里**，不进 URL
 *   - 持久化 `last_seq`，重连用 `resume` 而不是重拉全量
 *   - `gap:true` 时回调上层做全量重同步
 *   - 流式按 rev 拼接；检测到 rev 跳变时回调上层调 message.get 重置
 *   - 指数退避重连
 */

export type ConnState = 'idle' | 'connecting' | 'authenticating' | 'ready' | 'closed';

export interface ClientEvents {
  onState: (state: ConnState) => void;
  onEvent: (evt: EvtFrame) => void;
  /** 需要全量重同步（gap:true 或首次连接）。 */
  onResync: () => void;
  /** 流式 rev 跳变：上层应调 message.get 并重置本地状态。 */
  onRevGap: (convId: string, messageId: string, expectedRev: number, gotRev: number) => void;
  onError: (message: string) => void;
}

const LAST_SEQ_KEY = 'agentlink.last_seq';
const TOKEN_KEY = 'agentlink.access_token';
const REFRESH_KEY = 'agentlink.refresh_token';

export function loadLastSeq(): number {
  const raw = localStorage.getItem(LAST_SEQ_KEY);
  const n = raw === null ? 0 : Number(raw);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

export function saveLastSeq(seq: number): void {
  localStorage.setItem(LAST_SEQ_KEY, String(seq));
}

export function loadTokens(): { access: string | null; refresh: string | null } {
  return {
    access: localStorage.getItem(TOKEN_KEY),
    refresh: localStorage.getItem(REFRESH_KEY),
  };
}

export function saveTokens(access: string, refresh: string): void {
  localStorage.setItem(TOKEN_KEY, access);
  localStorage.setItem(REFRESH_KEY, refresh);
}

export function clearTokens(): void {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(REFRESH_KEY);
  localStorage.removeItem(LAST_SEQ_KEY);
}

export class ProtocolClient {
  private ws: WebSocket | null = null;
  private pending = new Map<string, { resolve: (f: ResFrame) => void; reject: (e: Error) => void }>();
  private seq = 0;
  private backoffMs = 500;
  private stopped = false;
  private reconnectTimer: number | null = null;
  private pingTimer: number | null = null;
  private accessToken: string | null = null;
  private refreshToken: string | null = null;
  private authInFlight: Promise<void> | null = null;

  constructor(
    private readonly url: string,
    private readonly events: ClientEvents,
  ) {}

  get connected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  setTokens(access: string, refresh: string): void {
    this.accessToken = access;
    this.refreshToken = refresh;
  }

  /** 建立连接并完成 auth + resume。 */
  async connect(): Promise<void> {
    this.stopped = false;
    await this.#openAndAuth();
  }

  async #openAndAuth(): Promise<void> {
    if (this.authInFlight) return this.authInFlight;
    this.authInFlight = (async () => {
      this.events.onState('connecting');
      const ws = new WebSocket(this.url, [WS_SUBPROTOCOL]);
      this.ws = ws;

      await new Promise<void>((resolve, reject) => {
        const onOpen = (): void => {
          ws.removeEventListener('error', onErr);
          resolve();
        };
        const onErr = (): void => {
          ws.removeEventListener('open', onOpen);
          reject(new Error('WS 连接失败'));
        };
        ws.addEventListener('open', onOpen, { once: true });
        ws.addEventListener('error', onErr, { once: true });
      });

      ws.addEventListener('message', (e) => this.#onMessage(String(e.data)));
      ws.addEventListener('close', () => this.#onClose());
      ws.addEventListener('error', () => {
        /* close 会跟着来 */
      });

      this.events.onState('authenticating');
      if (this.accessToken === null) {
        throw new Error('没有 access token');
      }
      // 协议 §2：token 只在帧体内
      const res = await this.request('auth', { token: this.accessToken });
      if (!res.ok) {
        if (res.error.code === 'AUTH_EXPIRED' && this.refreshToken !== null) {
          await this.#refreshTokens();
          this.authInFlight = null;
          return this.#openAndAuth();
        }
        throw new Error(`认证失败: ${res.error.code}`);
      }

      this.events.onState('ready');
      this.backoffMs = 500;

      // 协议 §4.2：用 resume 补齐，而不是重拉全量
      const lastSeq = loadLastSeq();
      const resumeRes = await this.request('resume', { last_seq: lastSeq });
      if (resumeRes.ok) {
        const data = resumeRes.data as { replayed: number; up_to: number; gap: boolean };
        if (data.gap) {
          // 协议 §4.2：gap:true 必须全量重同步
          this.events.onResync();
        }
        if (data.up_to > loadLastSeq()) saveLastSeq(data.up_to);
      }

      this.#startPing();
    })().finally(() => {
      this.authInFlight = null;
    });
    return this.authInFlight;
  }

  async #refreshTokens(): Promise<void> {
    if (this.refreshToken === null) throw new Error('没有 refresh token');
    const res = await fetch(apiUrl('/api/auth/refresh'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ refresh_token: this.refreshToken }),
    });
    if (!res.ok) {
      clearTokens();
      throw new Error('refresh 失败，需要重新登录');
    }
    const data = (await res.json()) as { access_token: string; refresh_token: string };
    this.accessToken = data.access_token;
    this.refreshToken = data.refresh_token;
    saveTokens(data.access_token, data.refresh_token);
  }

  #onMessage(raw: string): void {
    let frame: unknown;
    try {
      frame = JSON.parse(raw);
    } catch {
      return;
    }
    const f = frame as { kind?: string };
    if (f.kind === 'res') {
      const res = frame as ResFrame;
      const p = this.pending.get(res.id);
      if (p) {
        this.pending.delete(res.id);
        p.resolve(res);
      }
      return;
    }
    if (f.kind === 'evt') {
      const evt = frame as EvtFrame;
      // 未知 evt.type 必须忽略（协议 §6），这里只记录 seq
      if (evt.seq !== null && evt.seq > loadLastSeq()) saveLastSeq(evt.seq);

      if (evt.type === 'message.update') {
        const data = evt.data as { conv_id: string; message_id: string; rev: number; delta: string };
        // rev 跳变检测：上层负责调 message.get 重置（协议 §8.2）
        const localRev = this.revTracker.get(data.message_id);
        if (localRev !== undefined && data.rev !== localRev + 1) {
          this.events.onRevGap(data.conv_id, data.message_id, localRev + 1, data.rev);
        }
        this.revTracker.set(data.message_id, data.rev);
      }
      this.events.onEvent(evt);
    }
  }

  private revTracker = new Map<string, number>();

  /** 上层在 message.get / 新流开始时同步本地 rev。 */
  setLocalRev(messageId: string, rev: number): void {
    this.revTracker.set(messageId, rev);
  }

  #onClose(): void {
    this.#stopPing();
    this.events.onState('closed');
    for (const [, p] of this.pending) p.reject(new Error('连接已关闭'));
    this.pending.clear();
    if (!this.stopped) this.#scheduleReconnect();
  }

  #scheduleReconnect(): void {
    if (this.reconnectTimer !== null) return;
    const delay = Math.min(this.backoffMs, 10_000);
    this.backoffMs = Math.min(this.backoffMs * 2, 10_000);
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      void this.#openAndAuth().catch(() => {
        this.#scheduleReconnect();
      });
    }, delay);
  }

  #startPing(): void {
    this.#stopPing();
    // 协议 §5.1：客户端每 30s 发一次 ping
    this.pingTimer = window.setInterval(() => {
      void this.request('ping', {}).catch(() => {
        /* 断线由 close 处理 */
      });
    }, 30_000);
  }

  #stopPing(): void {
    if (this.pingTimer !== null) {
      window.clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }

  /** 发一个 req，等 res。超时 10 秒。 */
  request(op: string, data: unknown, timeoutMs = 10_000): Promise<ResFrame> {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error('连接未建立'));
    }
    this.seq += 1;
    const id = `c${this.seq}`;
    const frame: ReqFrame = {
      v: PROTOCOL_VERSION,
      kind: 'req',
      id,
      op,
      data: data ?? {},
    };
    return new Promise<ResFrame>((resolve, reject) => {
      const timer = window.setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${op} 超时`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (f) => {
          window.clearTimeout(timer);
          resolve(f);
        },
        reject: (e) => {
          window.clearTimeout(timer);
          reject(e);
        },
      });
      ws.send(JSON.stringify(frame));
    });
  }

  /** 请求并断言成功，失败抛错。 */
  async call<T>(op: string, data: unknown): Promise<T> {
    const res = await this.request(op, data);
    if (!res.ok) {
      throw new Error(`${op} 失败: ${res.error.code} ${res.error.message}`);
    }
    return res.data as T;
  }

  /**
   * 立即重连（跳过指数退避）。
   * 断线横幅上"立即重试"按钮用：用户不想等 10 秒的退避。
   */
  retryNow(): void {
    if (this.reconnectTimer !== null) {
      window.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.backoffMs = 500;
    void this.#openAndAuth().catch(() => {
      this.#scheduleReconnect();
    });
  }

  disconnect(): void {
    this.stopped = true;
    if (this.reconnectTimer !== null) {
      window.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.#stopPing();
    this.ws?.close();
    this.ws = null;
  }
}
