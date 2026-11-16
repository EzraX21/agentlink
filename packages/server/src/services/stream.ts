import {
  AgentLinkError,
  STREAM_FLUSH_CHARS,
  STREAM_FLUSH_INTERVAL_MS,
  STREAM_IDLE_TIMEOUT_MS,
  STREAM_ZOMBIE_AGE_MS,
  type Content,
  type Message,
} from '@agentlink/protocol';
import type { Db } from '../db/index.js';
import {
  appendEvent,
  deleteMessage,
  finalizeMessage,
  findMessage,
  findMessageByClientId,
  findUserById,
  insertMessage,
  listStreamingMessages,
  transaction,
  updateEventPayload,
  updateMessageContent,
} from '../db/queries.js';
import { newMessageId, nowMs } from '../ids.js';
import { assertNotMuted, requireMembership } from '../permissions.js';
import { contentToPlainText, toMessage } from './messages.js';

/**
 * 流式协议（协议 §8，实现计划 M4）。
 *
 * 设计约束与落实：
 *   - `message.update` 的 seq 恒为 **null**，不写 events 表、不补发
 *   - `rev` 从 0 开始，每次 delta 后 +1，客户端据此检测丢帧
 *   - 流式期间按 **500ms 或 512 字符**（先到者）落库，不是每个 token 都写
 *   - 60 秒无 delta 自动 abort
 *   - 启动时清理残留的 streaming 消息（120 秒阈值，见数据模型 §6.4）
 */

export interface StreamContext {
  readonly messageId: string;
  readonly convId: string;
  readonly senderId: string;
  rev: number;
  /** 内存里累积的全文（落库是节流的，这里才是真值）。 */
  text: string;
  /** 上次落库时的字符数。 */
  flushedChars: number;
  lastFlushAt: number;
  lastDeltaAt: number;
  idleTimer: NodeJS.Timeout | null;
  closed: boolean;
}

export interface StreamHooks {
  /** 推 message.update（seq=null）。 */
  onUpdate(convId: string, messageId: string, rev: number, delta: string): void;
  /** 推 message.final（带 seq）。 */
  onFinal(convId: string, message: Message, seq: number): void;
  /** 内容为空被删除时推 message.revoke。 */
  onDeleted(convId: string, messageId: string, seq: number, by: string): void;
  /** 打断时通知生成方。 */
  onInterrupted?(convId: string, messageId: string): void;
}

/** 统计流式期间的落库次数，验收脚本用它断言"节流真的生效"。 */
export interface FlushStats {
  flushes: number;
}

export class StreamRegistry {
  private readonly streams = new Map<string, StreamContext>();
  readonly stats: FlushStats = { flushes: 0 };

  constructor(
    private readonly db: Db,
    private readonly hooks: StreamHooks,
  ) {}

  get(messageId: string): StreamContext | undefined {
    return this.streams.get(messageId);
  }

  get activeCount(): number {
    return this.streams.size;
  }

  /** `stream.begin`：建一条空消息，state=streaming，seq=NULL。 */
  begin(input: {
    convId: string;
    senderId: string;
    clientMsgId: string;
    replyTo?: string | undefined;
  }): { messageId: string; convId: string; rev: number; message: Message } {
    const member = requireMembership(this.db, input.convId, input.senderId);
    assertNotMuted(member);

    const existingRow = findMessageByClientId(this.db, input.senderId, input.clientMsgId);
    if (existingRow) {
      const existingCtx = this.streams.get(existingRow.id);
      if (existingCtx && !existingCtx.closed) {
        // 幂等：同一 client_msg_id 再次 begin，复用已有流式上下文
        const sender = findUserById(this.db, input.senderId);
        if (!sender) throw new AgentLinkError('NOT_FOUND', '发送者不存在', { what: 'user' });
        return {
          messageId: existingRow.id,
          convId: input.convId,
          rev: existingCtx.rev,
          message: toMessage(existingRow, sender),
        };
      }
      if (existingRow.state === 'streaming') {
        // 僵尸：上一次进程崩了，先按兜底规则收尾
        this.recoverZombie(existingRow.id);
      }
    }

    const createdAt = nowMs();
    const messageId = newMessageId();

    insertMessage(this.db, {
      id: messageId,
      tenantId: 'default',
      convId: input.convId,
      senderId: input.senderId,
      seq: null,
      clientMsgId: input.clientMsgId,
      contentJson: '[]',
      textPlain: '',
      replyTo: input.replyTo ?? null,
      state: 'streaming',
      interrupted: 0,
      createdAt,
      finalizedAt: null,
    });

    const ctx: StreamContext = {
      messageId,
      convId: input.convId,
      senderId: input.senderId,
      rev: 0,
      text: '',
      flushedChars: 0,
      lastFlushAt: createdAt,
      lastDeltaAt: createdAt,
      idleTimer: null,
      closed: false,
    };
    this.streams.set(messageId, ctx);
    this.#armIdleTimer(ctx);

    const sender = findUserById(this.db, input.senderId);
    if (!sender) throw new AgentLinkError('NOT_FOUND', '发送者不存在', { what: 'user' });
    const row = findMessage(this.db, messageId);
    if (!row) throw new AgentLinkError('CONFLICT', '流式消息创建失败');

    return { messageId, convId: input.convId, rev: 0, message: toMessage(row, sender) };
  }

  /** `stream.delta`：内存累积 + 节流落库 + 推 message.update。 */
  appendDelta(input: {
    convId: string;
    messageId: string;
    senderId: string;
    delta: string;
  }): { rev: number } {
    const ctx = this.#requireOpen(input.messageId, input.senderId, input.convId);
    ctx.text += input.delta;
    ctx.rev += 1;
    ctx.lastDeltaAt = nowMs();
    this.#armIdleTimer(ctx);

    // 节流：每 500ms 或每 512 字符，先到者触发一次 UPDATE（协议 §8.3）
    const dueByChars = ctx.text.length - ctx.flushedChars >= STREAM_FLUSH_CHARS;
    const dueByTime = ctx.lastDeltaAt - ctx.lastFlushAt >= STREAM_FLUSH_INTERVAL_MS;
    if (dueByChars || dueByTime) {
      this.#flush(ctx);
    }

    // message.update 走内存，seq=null，不落库
    this.hooks.onUpdate(ctx.convId, ctx.messageId, ctx.rev, input.delta);
    return { rev: ctx.rev };
  }

  /**
   * `stream.commit`：落最终态 + 分配 seq + 推 message.final。
   * commit 时空内容也保留（协议 §8.5 的删除只针对 abort/超时）。
   */
  commit(input: { convId: string; messageId: string; senderId: string }): Message {
    const ctx = this.#requireOpen(input.messageId, input.senderId, input.convId);
    const message = this.#finalize(ctx, { interrupted: false, deleteIfEmpty: false });
    if (message === null) {
      throw new AgentLinkError('CONFLICT', '流式提交未产生消息');
    }
    return message;
  }

  /** `stream.abort`：内容为空则删消息并推 message.revoke。 */
  abort(input: {
    convId: string;
    messageId: string;
    senderId: string;
    reason?: string | undefined;
  }): Message | null {
    const ctx = this.streams.get(input.messageId);
    if (!ctx || ctx.closed) {
      throw new AgentLinkError('STREAM_CLOSED', '这条流已经结束', {
        message_id: input.messageId,
      });
    }
    if (ctx.senderId !== input.senderId) {
      throw new AgentLinkError('PERM_DENIED', '不能中止别人的流');
    }
    return this.#finalize(ctx, { interrupted: false, deleteIfEmpty: true });
  }

  /**
   * `stream.interrupt`：人类打断 agent 生成（协议 §8.4）。
   * 以当前已累积文本 commit，标记 interrupted=true，并关闭生成方的流式上下文。
   */
  interrupt(input: { convId: string; messageId: string; byUserId: string }): { ok: true } {
    const ctx = this.streams.get(input.messageId);
    if (!ctx || ctx.closed) {
      throw new AgentLinkError('STREAM_CLOSED', '这条流已经结束', {
        message_id: input.messageId,
      });
    }
    requireMembership(this.db, input.convId, input.byUserId);
    this.hooks.onInterrupted?.(input.convId, input.messageId);
    this.#finalize(ctx, { interrupted: true, deleteIfEmpty: false });
    return { ok: true };
  }

  /** 生成方连接断开时收尾它名下的流（按 abort 语义：空则删）。 */
  abortAllOf(senderId: string): void {
    for (const ctx of [...this.streams.values()]) {
      if (ctx.senderId !== senderId || ctx.closed) continue;
      try {
        this.#finalize(ctx, { interrupted: false, deleteIfEmpty: true });
      } catch {
        /* 尽力而为 */
      }
    }
  }

  // -------------------------------------------------------------------------

  #requireOpen(messageId: string, senderId: string, convId: string): StreamContext {
    const ctx = this.streams.get(messageId);
    if (!ctx || ctx.closed) {
      // 协议 §8.4：打断/结束后继续发 delta → STREAM_CLOSED
      throw new AgentLinkError('STREAM_CLOSED', '这条流已经结束，停止发送 delta', {
        message_id: messageId,
      });
    }
    if (ctx.senderId !== senderId) {
      throw new AgentLinkError('PERM_DENIED', '不能向别人的流里写');
    }
    if (ctx.convId !== convId) {
      throw new AgentLinkError('NOT_FOUND', '消息不在该会话里', { what: 'message' });
    }
    return ctx;
  }

  #flush(ctx: StreamContext): void {
    if (ctx.closed) return;
    const content: Content = [{ type: 'text', text: ctx.text }];
    updateMessageContent(this.db, ctx.messageId, JSON.stringify(content), contentToPlainText(content));
    ctx.flushedChars = ctx.text.length;
    ctx.lastFlushAt = nowMs();
    this.stats.flushes += 1;
  }

  #armIdleTimer(ctx: StreamContext): void {
    if (ctx.idleTimer) clearTimeout(ctx.idleTimer);
    const timer = setTimeout(() => {
      if (ctx.closed) return;
      // 协议 §8.5：60 秒无 delta 自动 abort
      try {
        this.#finalize(ctx, { interrupted: false, deleteIfEmpty: true });
      } catch {
        /* 已被别处收尾 */
      }
    }, STREAM_IDLE_TIMEOUT_MS);
    timer.unref?.();
    ctx.idleTimer = timer;
  }

  #finalize(
    ctx: StreamContext,
    opts: { interrupted: boolean; deleteIfEmpty: boolean },
  ): Message | null {
    if (ctx.closed) {
      throw new AgentLinkError('STREAM_CLOSED', '这条流已经结束', {
        message_id: ctx.messageId,
      });
    }
    ctx.closed = true;
    if (ctx.idleTimer) clearTimeout(ctx.idleTimer);
    ctx.idleTimer = null;
    this.streams.delete(ctx.messageId);

    const content: Content = ctx.text === '' ? [] : [{ type: 'text', text: ctx.text }];
    const contentJson = JSON.stringify(content);
    const textPlain = contentToPlainText(content);
    const at = nowMs();

    // 内容为空且是 abort/超时 → 删除消息并推 message.revoke（协议 §8.5）
    if (opts.deleteIfEmpty && ctx.text === '') {
      const seq = transaction(this.db, () => {
        deleteMessage(this.db, ctx.messageId);
        return appendEvent(this.db, {
          tenantId: 'default',
          convId: ctx.convId,
          type: 'message.revoke',
          payload: JSON.stringify({
            conv_id: ctx.convId,
            message_id: ctx.messageId,
            by: ctx.senderId,
          }),
          createdAt: at,
        });
      });
      this.hooks.onDeleted(ctx.convId, ctx.messageId, seq, ctx.senderId);
      return null;
    }

    // 先分配 seq，再把带完整 message 的 payload 写回去：
    // message.seq 就是刚分配的这个 seq，而 seq 只有 insert 之后才知道，
    // 所以分两步，但两步在同一个事务里（数据模型 §4）。
    const result = transaction(this.db, () => {
      const seq = appendEvent(this.db, {
        tenantId: 'default',
        convId: ctx.convId,
        type: 'message.final',
        payload: '{}',
        createdAt: at,
      });

      finalizeMessage(this.db, ctx.messageId, {
        contentJson,
        textPlain,
        seq,
        interrupted: opts.interrupted ? 1 : 0,
        finalizedAt: at,
      });

      const row = findMessage(this.db, ctx.messageId);
      if (!row) throw new AgentLinkError('CONFLICT', '流式消息落库失败');
      const sender = findUserById(this.db, ctx.senderId);
      if (!sender) throw new AgentLinkError('NOT_FOUND', '发送者不存在', { what: 'user' });
      const message = toMessage(row, sender);

      updateEventPayload(
        this.db,
        seq,
        JSON.stringify({ conv_id: ctx.convId, message }),
      );

      return { seq, message };
    });

    this.hooks.onFinal(ctx.convId, result.message, result.seq);
    return result.message;
  }

  /**
   * 启动时清理残留的 streaming 消息（数据模型 §6.4）。
   * 120 秒是崩溃残留的兜底阈值，**不是**业务超时（业务超时是 60 秒，见 §8.5）。
   */
  recoverStaleOnBoot(): { finalized: number; deleted: number } {
    const cutoff = nowMs() - STREAM_ZOMBIE_AGE_MS;
    const rows = listStreamingMessages(this.db, cutoff);
    let finalized = 0;
    let deleted = 0;
    for (const row of rows) {
      const res = this.recoverZombie(row.id);
      if (res === 'finalized') finalized += 1;
      if (res === 'deleted') deleted += 1;
    }
    return { finalized, deleted };
  }

  /** 收尾一条僵尸流式消息：内容非空则 finalize 保留，空则删除。 */
  recoverZombie(messageId: string): 'finalized' | 'deleted' | 'skipped' {
    const row = findMessage(this.db, messageId);
    if (!row || row.state !== 'streaming') return 'skipped';

    const at = nowMs();
    if (row.textPlain === '') {
      deleteMessage(this.db, messageId);
      return 'deleted';
    }

    transaction(this.db, () => {
      const seq = appendEvent(this.db, {
        tenantId: 'default',
        convId: row.convId,
        type: 'message.final',
        payload: '{}',
        createdAt: at,
      });
      finalizeMessage(this.db, messageId, { seq, interrupted: 0, finalizedAt: at });
      const updated = findMessage(this.db, messageId);
      const sender = findUserById(this.db, row.senderId);
      if (updated && sender) {
        updateEventPayload(
          this.db,
          seq,
          JSON.stringify({ conv_id: row.convId, message: toMessage(updated, sender) }),
        );
      }
    });
    return 'finalized';
  }
}
