import { AgentLinkError, type Member } from '@agentlink/protocol';
import type { Db } from '../db/index.js';
import {
  deleteMembership,
  findConversation,
  findMembership,
  findUserById,
  findUsersByIds,
  insertAudit,
  insertMembership,
  listMemberships,
  transaction,
  updateMembership,
} from '../db/queries.js';
import { appendEvent } from '../db/queries.js';
import { newId, nowMs } from '../ids.js';
import { requireMembership, requireRole } from '../permissions.js';
import { toMember } from './conversations.js';
import type { MembershipRow } from '../db/schema.js';

/**
 * 群管理与审计（实现计划 M5、协议 §10）。
 *
 * 铁律：
 *   - 权限判定对 agent 与人类走**同一套代码**（`permissions.ts`）
 *   - 审计日志**只写成功的动作**（施工守则 §8）—— 所以 insertAudit 只在这些
 *     函数真正完成变更之后调用；任何抛错路径都不会留下审计行
 */

export interface MutationResult {
  readonly seq: number;
  readonly member?: Member;
  readonly members?: Member[];
}

function audit(
  db: Db,
  actorId: string,
  action: string,
  targetType: 'user' | 'group' | 'agent',
  targetId: string,
  detail: Record<string, unknown> = {},
): void {
  insertAudit(db, {
    id: newId('e'),
    tenantId: 'default',
    actorId,
    action,
    targetType,
    targetId,
    detail: JSON.stringify(detail),
    createdAt: nowMs(),
  });
}

export function inviteMembers(
  db: Db,
  input: { convId: string; actorId: string; userIds: readonly string[] },
): MutationResult {
  requireRole(db, input.convId, input.actorId, 'member.invite');

  const users = findUsersByIds(db, [...input.userIds]);
  if (users.length !== input.userIds.length) {
    const found = new Set(users.map((u) => u.id));
    const missing = input.userIds.filter((id) => !found.has(id));
    throw new AgentLinkError('NOT_FOUND', `用户不存在: ${missing.join(', ')}`, { what: 'user' });
  }

  const at = nowMs();
  const added: Member[] = [];

  const seq = transaction(db, () => {
    let lastSeq = 0;
    for (const user of users) {
      if (findMembership(db, input.convId, user.id)) continue; // 已在群里，跳过
      insertMembership(db, {
        convId: input.convId,
        userId: user.id,
        role: 'member',
        isAgent: user.kind === 'agent' ? 1 : 0,
        mutedUntil: 0,
        joinedAt: at,
      });
      const row = findMembership(db, input.convId, user.id);
      if (!row) continue;
      const member = toMember(row, user);
      added.push(member);
      lastSeq = appendEvent(db, {
        tenantId: 'default',
        convId: input.convId,
        type: 'member.join',
        payload: JSON.stringify({ conv_id: input.convId, member }),
        createdAt: at,
      });
    }
    return lastSeq;
  });

  // 审计在成功之后（失败动作不写审计）
  audit(db, input.actorId, 'member.invite', 'group', input.convId, {
    user_ids: added.map((m) => m.user_id),
  });

  return { seq, members: added };
}

export function kickMember(
  db: Db,
  input: { convId: string; actorId: string; userId: string },
): MutationResult {
  const actor = requireRole(db, input.convId, input.actorId, 'member.kick');
  const target = findMembership(db, input.convId, input.userId);
  if (!target) {
    throw new AgentLinkError('NOT_FOUND', '该用户不在群里', { what: 'user' });
  }
  if (target.role === 'owner') {
    throw new AgentLinkError('PERM_DENIED', '不能踢出群主', { action: 'member.kick' });
  }
  if (actor.role === 'admin' && target.role === 'admin') {
    // admin 之间平级，不能互踢；只有 owner 能
    throw new AgentLinkError('PERM_DENIED', '管理员不能踢出其他管理员', {
      action: 'member.kick',
    });
  }

  const at = nowMs();
  const seq = transaction(db, () => {
    deleteMembership(db, input.convId, input.userId);
    return appendEvent(db, {
      tenantId: 'default',
      convId: input.convId,
      type: 'member.leave',
      payload: JSON.stringify({
        conv_id: input.convId,
        user_id: input.userId,
        reason: 'kicked',
      }),
      createdAt: at,
    });
  });

  audit(db, input.actorId, 'member.kick', 'user', input.userId, { conv_id: input.convId });
  return { seq };
}

export function muteMember(
  db: Db,
  input: { convId: string; actorId: string; userId: string; untilMs: number },
): MutationResult & { member: Member } {
  const actor = requireRole(db, input.convId, input.actorId, 'member.mute');
  const target = findMembership(db, input.convId, input.userId);
  if (!target) {
    throw new AgentLinkError('NOT_FOUND', '该用户不在群里', { what: 'user' });
  }
  if (target.role === 'owner') {
    throw new AgentLinkError('PERM_DENIED', '不能禁言群主', { action: 'member.mute' });
  }
  if (actor.role === 'admin' && target.role === 'admin') {
    throw new AgentLinkError('PERM_DENIED', '管理员不能禁言其他管理员', {
      action: 'member.mute',
    });
  }

  const at = nowMs();
  const { seq, member } = transaction(db, () => {
    updateMembership(db, input.convId, input.userId, { mutedUntil: input.untilMs });
    const row = findMembership(db, input.convId, input.userId);
    const user = findUserById(db, input.userId);
    if (!row || !user) throw new AgentLinkError('NOT_FOUND', '成员不存在', { what: 'user' });
    const m = toMember(row, user);
    const s = appendEvent(db, {
      tenantId: 'default',
      convId: input.convId,
      type: 'member.update',
      payload: JSON.stringify({ conv_id: input.convId, member: m }),
      createdAt: at,
    });
    return { seq: s, member: m };
  });

  audit(db, input.actorId, 'member.mute', 'user', input.userId, {
    conv_id: input.convId,
    until_ms: input.untilMs,
  });
  return { seq, member };
}

export function setMemberRole(
  db: Db,
  input: {
    convId: string;
    actorId: string;
    userId: string;
    role: 'owner' | 'admin' | 'member';
  },
): MutationResult & { member: Member } {
  requireRole(db, input.convId, input.actorId, 'member.role.set');
  const target = findMembership(db, input.convId, input.userId);
  if (!target) {
    throw new AgentLinkError('NOT_FOUND', '该用户不在群里', { what: 'user' });
  }
  if (input.userId === input.actorId) {
    throw new AgentLinkError('PERM_DENIED', '不能改自己的角色', { action: 'member.role.set' });
  }

  const at = nowMs();
  const { seq, member } = transaction(db, () => {
    updateMembership(db, input.convId, input.userId, { role: input.role });
    // 转移 owner：原 owner 降为 admin（保证群始终有且只有一个 owner）
    if (input.role === 'owner') {
      updateMembership(db, input.convId, input.actorId, { role: 'admin' });
    }
    const row = findMembership(db, input.convId, input.userId);
    const user = findUserById(db, input.userId);
    if (!row || !user) throw new AgentLinkError('NOT_FOUND', '成员不存在', { what: 'user' });
    const m = toMember(row, user);
    const s = appendEvent(db, {
      tenantId: 'default',
      convId: input.convId,
      type: 'member.update',
      payload: JSON.stringify({ conv_id: input.convId, member: m }),
      createdAt: at,
    });
    return { seq: s, member: m };
  });

  audit(db, input.actorId, 'member.role.set', 'user', input.userId, {
    conv_id: input.convId,
    role: input.role,
  });
  return { seq, member };
}

/** `poke.send`：瞬时事件，seq=null，不落库（协议 §6）。 */
export function poke(
  db: Db,
  input: { convId: string; actorId: string; userId: string },
): { ok: true } {
  requireMembership(db, input.convId, input.actorId);
  const target = findMembership(db, input.convId, input.userId);
  if (!target) {
    throw new AgentLinkError('NOT_FOUND', '该用户不在群里', { what: 'user' });
  }
  return { ok: true };
}

/** `typing`：瞬时事件，seq=null。 */
export function typing(
  db: Db,
  input: { convId: string; actorId: string },
): { ok: true } {
  requireMembership(db, input.convId, input.actorId);
  return { ok: true };
}

export function memberCount(db: Db, convId: string): number {
  return listMemberships(db, convId).length;
}

export function convExists(db: Db, convId: string): boolean {
  return findConversation(db, convId) !== undefined;
}

export function memberRow(db: Db, convId: string, userId: string): MembershipRow | undefined {
  return findMembership(db, convId, userId);
}
