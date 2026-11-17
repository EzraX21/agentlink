import { AgentLinkError } from '@agentlink/protocol';
import type { Db } from './db/index.js';
import { findMembership, isMember } from './db/queries.js';
import type { MembershipRow } from './db/schema.js';

/**
 * 权限矩阵（协议 §10）。
 *
 * **agent 与人类走同一套代码**（需求 D3）。`is_agent` 只是标记，v1 不参与判定。
 */

export type Action =
  | 'message.send'
  | 'message.revoke.own'
  | 'message.revoke.other'
  | 'member.invite'
  | 'member.kick'
  | 'member.mute'
  | 'group.update'
  /** 置顶消息（协议扩展 §4）：与群名/公告同档，owner/admin 才能改。 */
  | 'message.pin'
  | 'member.role.set'
  | 'stream.begin';

const MATRIX: Record<Action, readonly ('owner' | 'admin' | 'member')[]> = {
  'message.send': ['owner', 'admin', 'member'],
  'message.revoke.own': ['owner', 'admin', 'member'],
  'message.revoke.other': ['owner', 'admin'],
  'member.invite': ['owner', 'admin'],
  'member.kick': ['owner', 'admin'],
  'member.mute': ['owner', 'admin'],
  'group.update': ['owner', 'admin'],
  'message.pin': ['owner', 'admin'],
  'member.role.set': ['owner'],
  'stream.begin': ['owner', 'admin', 'member'],
};

export function roleAllows(role: 'owner' | 'admin' | 'member', action: Action): boolean {
  return MATRIX[action].includes(role);
}

/** 取成员行；不是成员就 PERM_DENIED。 */
export function requireMembership(db: Db, convId: string, userId: string): MembershipRow {
  const m = findMembership(db, convId, userId);
  if (!m) {
    throw new AgentLinkError('PERM_DENIED', '你不在这个会话里', { action: 'member' });
  }
  return m;
}

/** 取成员行并检查角色。 */
export function requireRole(
  db: Db,
  convId: string,
  userId: string,
  action: Action,
): MembershipRow {
  const m = requireMembership(db, convId, userId);
  if (!roleAllows(m.role, action)) {
    throw new AgentLinkError('PERM_DENIED', '你的角色不允许这个操作', { action });
  }
  return m;
}

/** 禁言检查：`muted_until > now` 时不许发消息（协议 §10）。 */
export function assertNotMuted(m: MembershipRow, now = Date.now()): void {
  if (m.mutedUntil > now) {
    throw new AgentLinkError('PERM_DENIED', '你在这个会话里被禁言了', { reason: 'muted' });
  }
}

export function isMemberOf(db: Db, convId: string, userId: string): boolean {
  return isMember(db, convId, userId);
}
