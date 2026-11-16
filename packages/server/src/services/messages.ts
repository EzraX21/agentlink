import {
  AgentLinkError,
  type Content,
  type ContextMessage,
  type Message,
  type UserSummary,
} from '@agentlink/protocol';
import { and, eq, sql } from 'drizzle-orm';
import type { Db } from '../db/index.js';
import {
  appendEvent,
  findMessage,
  findMessageByClientId,
  findUserById,
  findUsersByIds,
  insertMessage,
  listContextAfter,
  listContextBefore,
  listHistory,
  listMemberCandidates,
  revokeMessage,
  transaction,
} from '../db/queries.js';
import { messages as messagesTable, type MessageRow, type UserRow } from '../db/schema.js';
import { newMessageId, nowMs } from '../ids.js';
import { assertNotMuted, requireMembership } from '../permissions.js';

/**
 * 消息服务（实现计划 M2）。
 *
 * 三条硬性要求：
 *   1. seq 由 events 表分配，**绝不用时间戳**（数据模型 §4）
 *   2. 消息写入与 seq 分配在**同一个事务**里
 *   3. `client_msg_id` 幂等：重复不报错，返回已有消息
 */

/** content 块数组 → 纯文本（供 FTS 与 context.fetch 用，协议 §7）。 */
export function contentToPlainText(content: Content): string {
  const parts: string[] = [];
  for (const block of content) {
    switch (block.type) {
      case 'text':
        parts.push(block.text);
        break;
      case 'image':
        parts.push('[图片]');
        break;
      case 'file':
        parts.push(`[文件: ${block.filename ?? block.attachment_id}]`);
        break;
    }
  }
  return parts.join('\n');
}

/** 从 content 里抽出被 @ 的用户（`only_mentions` 订阅用）。 */
export function extractMentions(
  content: Content,
  candidates: ReadonlyArray<{ id: string; displayName: string }>,
): string[] {
  const text = content
    .map((b) => (b.type === 'text' ? b.text : ''))
    .join('\n');
  const hits: string[] = [];
  for (const c of candidates) {
    // 支持 `@u_xxx`（ID 形式，SDK 常用）与 `@昵称` 两种
    if (text.includes(`@${c.id}`) || text.includes(`@${c.displayName}`)) {
      hits.push(c.id);
    }
  }
  return hits;
}

export function toMessage(row: MessageRow, sender: UserRow): Message {
  const senderSummary: UserSummary = {
    id: sender.id,
    kind: sender.kind,
    display_name: sender.displayName,
  };
  if (sender.avatarUrl !== null) senderSummary.avatar_url = sender.avatarUrl;
  return {
    id: row.id,
    conv_id: row.convId,
    seq: row.seq,
    sender: senderSummary,
    content: JSON.parse(row.contentJson) as Content,
    reply_to: row.replyTo,
    state: row.state,
    interrupted: row.interrupted === 1,
    created_at: row.createdAt,
    revoked_at: row.revokedAt,
  };
}

/** 从 DB 行重建 Message（批量查 sender，避免 N+1）。 */
export function hydrateMessages(db: Db, rows: readonly MessageRow[]): Message[] {
  if (rows.length === 0) return [];
  const senders = findUsersByIds(db, [...new Set(rows.map((r) => r.senderId))]);
  const byId = new Map(senders.map((u) => [u.id, u]));
  const out: Message[] = [];
  for (const row of rows) {
    const sender = byId.get(row.senderId);
    if (!sender) continue;
    out.push(toMessage(row, sender));
  }
  return out;
}

export interface SendMessageInput {
  readonly convId: string;
  readonly senderId: string;
  readonly clientMsgId: string;
  readonly content: Content;
  readonly replyTo?: string | undefined;
}

export interface SendMessageResult {
  readonly messageId: string;
  readonly seq: number;
  readonly clientMsgId: string;
  readonly createdAt: number;
  /** 幂等命中已有消息时为 true。 */
  readonly duplicate: boolean;
  /** 供 hub 推事件用（已含完整 message 对象）。 */
  readonly message: Message;
  readonly mentions: string[];
}

/**
 * 发消息。幂等键命中时**不报错**，直接返回已有消息（协议 §5.3）。
 *
 * 事务边界：插消息 → 分配 seq（appendEvent）→ 回填 messages.seq，
 * 三步在一个事务里，否则会出现"有消息无事件"的窗口。
 */
export function sendMessage(db: Db, input: SendMessageInput): SendMessageResult {
  const member = requireMembership(db, input.convId, input.senderId);
  assertNotMuted(member);

  if (input.replyTo !== undefined) {
    const target = findMessage(db, input.replyTo);
    if (!target || target.convId !== input.convId) {
      throw new AgentLinkError('NOT_FOUND', '被引用的消息不存在', { what: 'message' });
    }
  }

  // 幂等：快路径先查；并发下靠 ux_messages_idem 唯一索引兜底（见 catch）
  const existing = findMessageByClientId(db, input.senderId, input.clientMsgId);
  if (existing) {
    const sender = findUserById(db, existing.senderId);
    if (!sender) throw new AgentLinkError('NOT_FOUND', '发送者不存在', { what: 'user' });
    return {
      messageId: existing.id,
      seq: existing.seq ?? 0,
      clientMsgId: input.clientMsgId,
      createdAt: existing.createdAt,
      duplicate: true,
      message: toMessage(existing, sender),
      mentions: [],
    };
  }

  const contentJson = JSON.stringify(input.content);
  const textPlain = contentToPlainText(input.content);
  const createdAt = nowMs();
  const messageId = newMessageId();

  const sender = findUserById(db, input.senderId);
  if (!sender) throw new AgentLinkError('NOT_FOUND', '发送者不存在', { what: 'user' });

  // @ 提及在发送时算一次，写进事件 payload。
  // 这样 resume 补发时不用再查成员表，过滤结果与实时推送完全一致。
  const mentions = extractMentions(input.content, listMemberCandidates(db, input.convId));

  try {
    return transaction(db, (): SendMessageResult => {
      insertMessage(db, {
        id: messageId,
        tenantId: 'default',
        convId: input.convId,
        senderId: input.senderId,
        seq: null,
        clientMsgId: input.clientMsgId,
        contentJson,
        textPlain,
        replyTo: input.replyTo ?? null,
        state: 'final',
        interrupted: 0,
        createdAt,
        finalizedAt: createdAt,
      });

      // 分配 seq（与消息写入同一事务）
      const seq = appendEvent(db, {
        tenantId: 'default',
        convId: input.convId,
        type: 'message.new',
        payload: JSON.stringify({
          conv_id: input.convId,
          mentions,
          message: toMessage(
            {
              id: messageId,
              tenantId: 'default',
              convId: input.convId,
              senderId: input.senderId,
              seq: null,
              clientMsgId: input.clientMsgId,
              contentJson,
              textPlain,
              replyTo: input.replyTo ?? null,
              state: 'final',
              interrupted: 0,
              createdAt,
              finalizedAt: createdAt,
              revokedAt: null,
              revokedBy: null,
            },
            sender,
          ),
        }),
        createdAt,
      });

      // 回填 seq
      db.update(messagesTable).set({ seq }).where(eq(messagesTable.id, messageId)).run();

      const stored = findMessage(db, messageId);
      if (!stored) throw new AgentLinkError('CONFLICT', '消息写入失败');

      return {
        messageId,
        seq,
        clientMsgId: input.clientMsgId,
        createdAt,
        duplicate: false,
        message: toMessage(stored, sender),
        mentions,
      };
    });
  } catch (err) {
    // 并发下同 client_msg_id 撞唯一索引：不报错，返回已有消息（协议 §5.3）
    if (isUniqueViolation(err)) {
      const dup = findMessageByClientId(db, input.senderId, input.clientMsgId);
      if (dup) {
        const s = findUserById(db, dup.senderId);
        if (!s) throw new AgentLinkError('NOT_FOUND', '发送者不存在', { what: 'user' });
        return {
          messageId: dup.id,
          seq: dup.seq ?? 0,
          clientMsgId: input.clientMsgId,
          createdAt: dup.createdAt,
          duplicate: true,
          message: toMessage(dup, s),
          mentions: [],
        };
      }
    }
    throw err;
  }
}

function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    typeof (err as { code: unknown }).code === 'string' &&
    ((err as { code: string }).code === 'SQLITE_CONSTRAINT_UNIQUE' ||
      (err as { code: string }).code === 'SQLITE_CONSTRAINT_PRIMARYKEY')
  );
}

/**
 * `message.get`。
 *
 * 流式消息的**真值在内存里**（落库是 500ms/512 字符节流的），所以这里必须
 * 把内存里累积的文本覆盖上去 —— 协议 §8.2 要求客户端在 rev 跳变时调它拿到
 * "当前完整文本"，如果只读库，会拿到最多落后 500ms 的旧内容。
 */
export function getMessage(
  db: Db,
  convId: string,
  messageId: string,
  userId: string,
  liveTextOf?: (messageId: string) => string | undefined,
): Message {
  requireMembership(db, convId, userId);
  const row = findMessage(db, messageId);
  if (!row || row.convId !== convId) {
    throw new AgentLinkError('NOT_FOUND', '消息不存在', { what: 'message' });
  }
  const sender = findUserById(db, row.senderId);
  if (!sender) throw new AgentLinkError('NOT_FOUND', '发送者不存在', { what: 'user' });

  const live = row.state === 'streaming' ? liveTextOf?.(messageId) : undefined;
  if (live !== undefined) {
    const patched = { ...row, contentJson: JSON.stringify([{ type: 'text', text: live }]) };
    return toMessage(patched as MessageRow, sender);
  }
  return toMessage(row, sender);
}

/** `message.revoke`：自己或 admin/owner（协议 §10）。返回事件 seq 供推送用。 */
export function revokeMessageById(
  db: Db,
  input: { convId: string; messageId: string; userId: string },
): { ok: true; messageId: string; seq: number } {
  const member = requireMembership(db, input.convId, input.userId);
  const row = findMessage(db, input.messageId);
  if (!row || row.convId !== input.convId) {
    throw new AgentLinkError('NOT_FOUND', '消息不存在', { what: 'message' });
  }
  if (row.state === 'revoked') {
    throw new AgentLinkError('CONFLICT', '消息已撤回');
  }
  const isOwn = row.senderId === input.userId;
  const canOther = member.role === 'owner' || member.role === 'admin';
  if (!isOwn && !canOther) {
    throw new AgentLinkError('PERM_DENIED', '只能撤回自己的消息', {
      action: 'message.revoke.other',
    });
  }

  const at = nowMs();
  const seq = transaction(db, () => {
    revokeMessage(db, input.messageId, input.userId, at);
    return appendEvent(db, {
      tenantId: 'default',
      convId: input.convId,
      type: 'message.revoke',
      payload: JSON.stringify({
        conv_id: input.convId,
        message_id: input.messageId,
        by: input.userId,
      }),
      createdAt: at,
    });
  });

  return { ok: true, messageId: input.messageId, seq };
}

/** `history.fetch`：seq 降序（协议 §5.3）。 */
export function fetchHistory(
  db: Db,
  input: { convId: string; userId: string; beforeSeq?: number | undefined; limit?: number | undefined },
): { messages: Message[]; has_more: boolean } {
  requireMembership(db, input.convId, input.userId);
  const limit = input.limit ?? 50;
  const { rows, hasMore } = listHistory(db, input.convId, limit, input.beforeSeq);
  return { messages: hydrateMessages(db, rows), has_more: hasMore };
}

/**
 * `context.fetch`（协议 §7）：本项目最关键的一个接口。
 *
 * 目标：agent 拿到返回结果就能直接拼 prompt。
 * - messages 按 seq **升序**（旧 → 新）
 * - sender 是展示名，sender_id 单独给
 * - quote 是被引用消息的纯文本（最长 200 字符）
 * - 超出 max_chars 时从**最旧**的消息开始丢弃
 * - 已撤回消息不返回，也不占 dropped_count
 */
export function fetchContext(
  db: Db,
  input: {
    convId: string;
    userId: string;
    anchorSeq?: number | undefined;
    before?: number | undefined;
    after?: number | undefined;
    includeQuoted?: boolean | undefined;
    maxChars?: number | undefined;
  },
): { messages: ContextMessage[]; truncated: boolean; dropped_count: number } {
  requireMembership(db, input.convId, input.userId);

  const before = input.before ?? 20;
  const after = input.after ?? 0;
  const includeQuoted = input.includeQuoted ?? true;
  const maxChars = input.maxChars ?? 8000;

  const beforeRows = listContextBefore(db, input.convId, before, input.anchorSeq);
  const afterRows =
    after > 0 && input.anchorSeq !== undefined
      ? listContextAfter(db, input.convId, input.anchorSeq, after)
      : [];

  // 升序拼接
  const rows = [...beforeRows.reverse(), ...afterRows].filter((r) => r.state === 'final');

  // 批量取 sender 与 quote
  const senderIds = [...new Set(rows.map((r) => r.senderId))];
  const senders = findUsersByIds(db, senderIds);
  const senderById = new Map(senders.map((u) => [u.id, u]));

  const quoteIds = rows
    .map((r) => r.replyTo)
    .filter((id): id is string => id !== null && id !== undefined);
  const quotes = new Map<string, string>();
  if (includeQuoted && quoteIds.length > 0) {
    for (const qid of [...new Set(quoteIds)]) {
      const q = findMessage(db, qid);
      if (q && q.state !== 'revoked') {
        const text = q.textPlain.slice(0, 200);
        if (text !== '') quotes.set(qid, text);
      }
    }
  }

  const items: ContextMessage[] = [];
  for (const row of rows) {
    const sender = senderById.get(row.senderId);
    if (!sender) continue;
    const quote = row.replyTo !== null ? (quotes.get(row.replyTo) ?? null) : null;
    items.push({
      seq: row.seq ?? 0,
      ts: row.createdAt,
      sender: sender.displayName,
      sender_id: sender.id,
      sender_kind: sender.kind,
      text: row.textPlain,
      quote,
    });
  }

  // 预算：从最旧开始丢弃
  let total = items.reduce((n, m) => n + m.text.length, 0);
  let dropped = 0;
  while (total > maxChars && items.length > 0) {
    const removed = items.shift();
    if (!removed) break;
    total -= removed.text.length;
    dropped += 1;
  }

  return { messages: items, truncated: dropped > 0, dropped_count: dropped };
}

/** 撤回后从 FTS 里消失由触发器负责；这里只返回有效消息数。 */
export function countVisibleMessages(db: Db, convId: string): number {
  const row = db
    .select({ n: sql<number>`count(*)` })
    .from(messagesTable)
    .where(and(eq(messagesTable.convId, convId), eq(messagesTable.state, 'final')))
    .get();
  return row?.n ?? 0;
}
