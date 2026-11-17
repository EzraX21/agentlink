import {
  AgentLinkError,
  type Conversation,
  type Member,
  type UserSummary,
} from '@agentlink/protocol';
import type { Db } from '../db/index.js';
import {
  findConversation,
  findMembership,
  findUserById,
  findUsersByIds,
  insertConversation,
  insertMembership,
  listConversationsForUser,
  listMemberships,
  updateConversation,
} from '../db/queries.js';
import type { ConversationRow, MembershipRow, UserRow } from '../db/schema.js';
import { newConvId, nowMs } from '../ids.js';
import { requireMembership } from '../permissions.js';

/**
 * 会话与成员（实现计划 M1 的 op：conv.create / conv.list / conv.get / group.update）。
 */

export function toUserSummary(user: UserRow): UserSummary {
  const out: UserSummary = {
    id: user.id,
    kind: user.kind,
    display_name: user.displayName,
  };
  if (user.avatarUrl !== null) out.avatar_url = user.avatarUrl;
  return out;
}

export function toConversation(row: ConversationRow, memberCount?: number): Conversation {
  const conv: Conversation = {
    id: row.id,
    kind: row.kind,
    title: row.title,
    announcement: row.announcement,
    created_by: row.createdBy,
    created_at: row.createdAt,
  };
  if (memberCount !== undefined) conv.member_count = memberCount;
  return conv;
}

export function toMember(row: MembershipRow, user: UserRow): Member {
  return {
    conv_id: row.convId,
    user_id: row.userId,
    role: row.role,
    is_agent: row.isAgent === 1,
    muted_until: row.mutedUntil,
    joined_at: row.joinedAt,
    // 协议扩展 §5：已读水位。老行默认 0，语义是"没读过"。
    last_read_seq: row.lastReadSeq ?? 0,
    user: toUserSummary(user),
  };
}

export interface CreateConversationInput {
  readonly kind: 'group' | 'dm';
  readonly title?: string | undefined;
  readonly memberIds?: readonly string[] | undefined;
  readonly creatorId: string;
}

/** 建会话：创建者自动成为 owner，其余成员是 member（协议 §5.2）。 */
export function createConversation(db: Db, input: CreateConversationInput): Conversation {
  const memberIds = [...new Set(input.memberIds ?? [])].filter((id) => id !== input.creatorId);

  if (memberIds.length > 0) {
    const found = findUsersByIds(db, memberIds);
    if (found.length !== memberIds.length) {
      const missing = memberIds.filter((id) => !found.some((u) => u.id === id));
      throw new AgentLinkError('NOT_FOUND', `成员不存在: ${missing.join(', ')}`, {
        what: 'user',
      });
    }
  }

  if (input.kind === 'dm' && memberIds.length !== 1) {
    throw new AgentLinkError('VALIDATION_FAILED', 'dm 必须正好一个对方成员', {
      issues: [{ path: 'member_ids', message: 'dm 需要恰好 1 个成员' }],
    });
  }

  const now = nowMs();
  const id = newConvId();
  const all = [input.creatorId, ...memberIds];
  const title =
    input.title ?? (input.kind === 'dm' ? '' : `群聊 ${new Date(now).toISOString().slice(0, 10)}`);

  db.transaction(() => {
    insertConversation(db, {
      id,
      tenantId: 'default',
      kind: input.kind,
      title,
      announcement: '',
      createdBy: input.creatorId,
      createdAt: now,
    });

    for (const [idx, userId] of all.entries()) {
      const user = findUserById(db, userId);
      insertMembership(db, {
        convId: id,
        userId,
        role: idx === 0 ? 'owner' : 'member',
        isAgent: user?.kind === 'agent' ? 1 : 0,
        mutedUntil: 0,
        joinedAt: now,
      });
    }
  });

  const row = findConversation(db, id);
  if (!row) throw new AgentLinkError('CONFLICT', '会话创建失败');
  return toConversation(row, all.length);
}

export function listConversations(
  db: Db,
  userId: string,
  limit: number,
  cursor?: string,
): { items: Conversation[]; next_cursor?: string } {
  const { rows, hasMore } = listConversationsForUser(db, userId, limit, cursor);
  const items = rows.map((r) => toConversation(r, r.memberCount));
  if (!hasMore || rows.length === 0) return { items };
  const last = rows[rows.length - 1];
  if (!last) return { items };
  return { items, next_cursor: `${last.lastSeq}:${last.id}` };
}

export function getConversation(
  db: Db,
  convId: string,
  userId: string,
): { conv: Conversation; members: Member[] } {
  requireMembership(db, convId, userId);
  const row = findConversation(db, convId);
  if (!row) throw new AgentLinkError('NOT_FOUND', '会话不存在', { what: 'conv' });
  const memberRows = listMemberships(db, convId);
  const users = findUsersByIds(db, memberRows.map((m) => m.userId));
  const byId = new Map(users.map((u) => [u.id, u]));
  const members: Member[] = [];
  for (const m of memberRows) {
    const u = byId.get(m.userId);
    if (u) members.push(toMember(m, u));
  }
  return { conv: toConversation(row, members.length), members };
}

export function updateGroup(
  db: Db,
  convId: string,
  patch: { title?: string | undefined; announcement?: string | undefined },
): Conversation {
  updateConversation(db, convId, {
    ...(patch.title === undefined ? {} : { title: patch.title }),
    ...(patch.announcement === undefined ? {} : { announcement: patch.announcement }),
  });
  const row = findConversation(db, convId);
  if (!row) throw new AgentLinkError('NOT_FOUND', '会话不存在', { what: 'conv' });
  const memberCount = listMemberships(db, convId).length;
  return toConversation(row, memberCount);
}

export function membershipOrThrow(db: Db, convId: string, userId: string): MembershipRow {
  const m = findMembership(db, convId, userId);
  if (!m) throw new AgentLinkError('PERM_DENIED', '你不在这个会话里');
  return m;
}
