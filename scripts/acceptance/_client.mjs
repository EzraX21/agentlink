#!/usr/bin/env node
/**
 * 极简 WS 验收客户端。
 *
 * 只依赖 node: 内置模块 + ws。刻意不引用 @agentlink/protocol ——
 * 验收脚本要能独立验证协议，如果它和服务端共用一份解析代码，
 * 协议写错时两边会一起错，测不出来。
 */
import { WebSocket } from 'ws';

export const V = 1;

let counter = 0;
function nextId(prefix = 'r') {
  counter += 1;
  return `${prefix}${counter}`;
}

export class WsClient {
  /** @param {string} url */
  constructor(url, opts = {}) {
    this.url = url;
    this.ws = new WebSocket(url, opts.subprotocols ?? [], opts.wsOptions ?? {});
    this.pending = new Map();
    this.events = [];
    this.waiters = [];
    this.closed = false;
    this.closeCode = null;
    this.closeReason = null;
    this.log = opts.log ?? (() => {});
    this.opened = new Promise((resolve, reject) => {
      this.ws.once('open', resolve);
      this.ws.once('error', reject);
    });
    this.ws.on('message', (raw) => this.#onMessage(raw));
    this.ws.on('close', (code, reason) => {
      this.closed = true;
      this.closeCode = code;
      this.closeReason = reason?.toString() ?? '';
      for (const [, p] of this.pending) {
        p.reject(new Error(`连接已关闭 (${code}) 等待 ${p.op} 响应`));
      }
      this.pending.clear();
      this.#wake();
    });
  }

  #onMessage(raw) {
    let frame;
    try {
      frame = JSON.parse(raw.toString());
    } catch {
      this.log(`[client] 收到非 JSON 帧: ${raw.toString().slice(0, 120)}`);
      return;
    }
    this.log(`[client] << ${raw.toString().slice(0, 400)}`);
    if (frame.kind === 'res') {
      const p = this.pending.get(frame.id);
      if (p) {
        this.pending.delete(frame.id);
        p.resolve(frame);
      } else {
        this.log(`[client] 收到未知 id 的响应: ${frame.id}`);
      }
      return;
    }
    if (frame.kind === 'evt') {
      this.events.push(frame);
      this.#wake();
    }
  }

  #wake() {
    const ws = this.waiters;
    this.waiters = [];
    for (const w of ws) w();
  }

  async connect() {
    await this.opened;
    return this;
  }

  /** 发一个 req 帧，返回 res 帧（ok 或 error 都返回，不抛）。 */
  async request(op, data, { id, timeoutMs = 5000 } = {}) {
    const rid = id ?? nextId();
    const frame = { v: V, kind: 'req', id: rid, op };
    if (data !== undefined) frame.data = data;
    const promise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(rid);
        reject(new Error(`op=${op} 超时 ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(rid, {
        op,
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
    });
    this.sendRaw(frame);
    return promise;
  }

  sendRaw(frame) {
    const json = typeof frame === 'string' ? frame : JSON.stringify(frame);
    this.log(`[client] >> ${json.slice(0, 400)}`);
    this.ws.send(json);
  }

  /** 等下一个满足条件的 evt。可传 type 或 predicate。 */
  async nextEvent(match, timeoutMs = 5000) {
    const pred =
      typeof match === 'function'
        ? match
        : (e) => e.type === match;
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const idx = this.events.findIndex(pred);
      if (idx >= 0) return this.events.splice(idx, 1)[0];
      if (this.closed) throw new Error(`连接已关闭 (${this.closeCode})，等不到事件`);
      const remain = deadline - Date.now();
      if (remain <= 0) {
        throw new Error(
          `等事件超时 ${timeoutMs}ms；已收到: ${JSON.stringify(this.events.map((e) => e.type))}`,
        );
      }
      await new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error('timeout')), remain);
        this.waiters.push(() => {
          clearTimeout(t);
          resolve();
        });
      }).catch((err) => {
        if (err.message === 'timeout') throw new Error(
          `等事件超时 ${timeoutMs}ms；已收到: ${JSON.stringify(this.events.map((e) => e.type))}`,
        );
        throw err;
      });
    }
  }

  /** 收集窗口内所有事件（用于断言“不应收到”）。 */
  async drain(ms = 300) {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      const remain = deadline - Date.now();
      if (remain <= 0) break;
      await new Promise((resolve) => {
        const t = setTimeout(resolve, remain);
        this.waiters.push(() => {
          clearTimeout(t);
          resolve();
        });
      });
    }
    const out = this.events;
    this.events = [];
    return out;
  }

  async waitClose(timeoutMs = 5000) {
    if (this.closed) return { code: this.closeCode, reason: this.closeReason };
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`等关闭超时 ${timeoutMs}ms`)), timeoutMs);
      this.ws.once('close', (code, reason) => {
        clearTimeout(t);
        resolve({ code, reason: reason?.toString() ?? '' });
      });
    });
    return { code: this.closeCode, reason: this.closeReason };
  }

  close() {
    try {
      this.ws.close();
    } catch {
      /* 已关闭 */
    }
  }
}

/** 连上并完成 auth 的便捷函数。 */
export async function connectAuthed(url, token, opts = {}) {
  const c = new WsClient(url, opts);
  await c.connect();
  const res = await c.request('auth', { token }, { timeoutMs: opts.authTimeoutMs ?? 5000 });
  return { client: c, res };
}
