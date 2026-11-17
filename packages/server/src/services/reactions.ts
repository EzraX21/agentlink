import type { ReactionSummary } from '@agentlink/protocol';
import { AgentLinkError } from '@agentlink/protocol';
import { sql } from 'drizzle-orm';
import type { Db } from '../db/index.js';
import { requireMembership } from '../permissions.js';
import { findMessage } from '../db/queries.js';
import { nowMs } from '../ids.js';

/**
 * 表情回应（协议扩展 §2，见 docs/PROPOSAL-protocol-ext.md §2）。
 *
 * 三条纪律：
 *   1. 回的是**全量汇总**（`[{emoji, user_ids}]`），不是增量 —— 客户端整体替换，
 *      丢一帧也不会不一致。
 *   2. 同一个人重复点同一个表情 = **取消**（主键 (message_id,user_id,emoji)）。
 *   3. 只能回应**终态且未撤回**的消息：流式中的消息内容还在变，撤回的消息不该有回应。
 */

interface ReactionRow {
  emoji: string;
  user_id: string;
}

/** 读出某条消息的回应汇总（按 emoji 分组，顺序稳定）。 */
export function listReactions(db: Db, messageId: string): ReactionSummary[] {
  const rows = db.all<ReactionRow>(sql`
    SELECT emoji, user_id FROM message_reactions
     WHERE message_id = ${messageId}
     ORDER BY emoji ASC, created_at ASC
  `);
  const byEmoji = new Map<string, string[]>();
  for (const row of rows) {
    const list = byEmoji.get(row.emoji);
    if (list === undefined) byEmoji.set(row.emoji, [row.user_id]);
    else list.push(row.user_id);
  }
  return [...byEmoji.entries()].map(([emoji, user_ids]) => ({ emoji, user_ids }));
}

/** 批量取多条消息的回应（历史页一次查完，避免 N+1）。 */
export function listReactionsFor(db: Db, messageIds: readonly string[]): Map<string, ReactionSummary[]> {
  const out = new Map<string, ReactionSummary[]>();
  if (messageIds.length === 0) return out;
  const ids = sql.join(
    messageIds.map((id) => sql`${id}`),
    sql`, `,
  );
  const rows = db.all<ReactionRow & { message_id: string }>(sql`
    SELECT message_id, emoji, user_id FROM message_reactions
     WHERE message_id IN (${ids})
     ORDER BY message_id, emoji ASC, created_at ASC
  `);

  const grouped = new Map<string, Map<string, string[]>>();
  for (const row of rows) {
    let perEmoji = grouped.get(row.message_id);
    if (perEmoji === undefined) {
      perEmoji = new Map<string, string[]>();
      grouped.set(row.message_id, perEmoji);
    }
    const list = perEmoji.get(row.emoji);
    if (list === undefined) perEmoji.set(row.emoji, [row.user_id]);
    else list.push(row.user_id);
  }
  for (const [messageId, perEmoji] of grouped) {
    out.set(
      messageId,
      [...perEmoji.entries()].map(([emoji, user_ids]) => ({ emoji, user_ids })),
    );
  }
  return out;
}

/** 校验：必须是成员 + 消息存在 + 终态 + 未撤回。 */
function assertReactable(
  db: Db,
  input: { convId: string; messageId: string; userId: string },
): void {
  requireMembership(db, input.convId, input.userId);
  const row = findMessage(db, input.messageId);
  if (!row || row.convId !== input.convId) {
    throw new AgentLinkError('NOT_FOUND', '消息不存在', { what: 'message' });
  }
  if (row.state === 'revoked') {
    throw new AgentLinkError('CONFLICT', '消息已撤回，不能回应');
  }
  if (row.state === 'streaming') {
    throw new AgentLinkError('CONFLICT', '消息还在生成中，不能回应');
  }
}

export function addReaction(
  db: Db,
  input: { convId: string; messageId: string; userId: string; emoji: string },
): ReactionSummary[] {
  assertReactable(db, input);
  db.run(sql`
    INSERT INTO message_reactions (message_id, user_id, emoji, tenant_id, created_at)
    VALUES (${input.messageId}, ${input.userId}, ${input.emoji}, 'default', ${nowMs()})
    ON CONFLICT (message_id, user_id, emoji) DO NOTHING
  `);
  return listReactions(db, input.messageId);
}

export function removeReaction(
  db: Db,
  input: { convId: string; messageId: string; userId: string; emoji: string },
): ReactionSummary[] {
  assertReactable(db, input);
  db.run(sql`
    DELETE FROM message_reactions
     WHERE message_id = ${input.messageId} AND user_id = ${input.userId} AND emoji = ${input.emoji}
  `);
  return listReactions(db, input.messageId);
}

/** 撤回消息时清空回应（回应没有历史价值，留着只会让人困惑）。 */
export function clearReactions(db: Db, messageId: string): void {
  db.run(sql`DELETE FROM message_reactions WHERE message_id = ${messageId}`);
}
