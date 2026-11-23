import { and, asc, desc, eq, gt, inArray, isNull, lt, ne, or, sql } from 'drizzle-orm';
import type { Db } from './index.js';
import {
  attachments,
  auditLogs,
  conversations,
  events,
  memberships,
  messages,
  refreshTokens,
  users,
  type AttachmentRow,
  type AuditRow,
  type ConversationRow,
  type MembershipRow,
  type MessageRow,
  type UserRow,
} from './schema.js';

/**
 * 数据访问层。路由与 op 处理器**只调这里**，不直接碰 drizzle / SQL
 * （数据模型 §8：所有数据库访问必须收敛在 `src/db/` 内）。
 */

export type { Db };

// ---------------------------------------------------------------------------
// users
// ---------------------------------------------------------------------------

export function findUserById(db: Db, id: string): UserRow | undefined {
  return db.select().from(users).where(eq(users.id, id)).get();
}

export function findUserByUsername(db: Db, tenantId: string, username: string): UserRow | undefined {
  return db
    .select()
    .from(users)
    .where(and(eq(users.tenantId, tenantId), eq(users.username, username)))
    .get();
}

export function findUsersByIds(db: Db, ids: readonly string[]): UserRow[] {
  if (ids.length === 0) return [];
  return db.select().from(users).where(inArray(users.id, [...ids])).all();
}

export function insertUser(db: Db, row: typeof users.$inferInsert): void {
  db.insert(users).values(row).run();
}

export function updateUserTokenHash(db: Db, id: string, tokenHash: string): void {
  db.update(users).set({ tokenHash }).where(eq(users.id, id)).run();
}

export function updateUserPassword(db: Db, id: string, passwordHash: string): void {
  db.update(users).set({ passwordHash }).where(eq(users.id, id)).run();
}

export function setUserAdmin(db: Db, id: string, isAdmin: boolean): void {
  db.update(users)
    .set({ isAdmin: isAdmin ? 1 : 0 })
    .where(eq(users.id, id))
    .run();
}

/** 已启用的管理员数量（用于"不能把最后一个管理员降级"）。 */
export function countActiveAdmins(db: Db): number {
  const row = db
    .select({ n: sql<number>`count(*)` })
    .from(users)
    .where(
      and(eq(users.kind, 'human'), eq(users.isAdmin, 1), eq(users.disabled, 0)),
    )
    .get();
  return row?.n ?? 0;
}

/** 库里是否已经有任何人类管理员（注册时决定要不要自动授予第一个账号）。 */
export function hasAnyAdmin(db: Db): boolean {
  const row = db
    .select({ n: sql<number>`count(*)` })
    .from(users)
    .where(and(eq(users.kind, 'human'), eq(users.isAdmin, 1)))
    .get();
  return (row?.n ?? 0) > 0;
}

/** 管理页概览用的计数（一条 SQL 取完，省得来回查）。 */
export function adminStats(db: Db): {
  humans: number;
  agents: number;
  admins: number;
  disabledAgents: number;
  disabledHumans: number;
  convs: number;
  messages: number;
  events: number;
  /** 近 24 小时全权限命令执行次数（来自审计，重启不丢）。 */
  toolExec24h: number;
  /** 近 24 小时越权尝试次数。 */
  toolDenied24h: number;
} {
  const row = db.get<{
    humans: number;
    agents: number;
    admins: number;
    disabled_agents: number;
    disabled_humans: number;
    convs: number;
    messages: number;
    events: number;
    tool_exec_24h: number;
    tool_denied_24h: number;
  }>(sql`
    SELECT
      (SELECT count(*) FROM users WHERE kind = 'human') AS humans,
      (SELECT count(*) FROM users WHERE kind = 'agent') AS agents,
      (SELECT count(*) FROM users WHERE kind = 'human' AND is_admin = 1) AS admins,
      (SELECT count(*) FROM users WHERE kind = 'agent' AND disabled = 1) AS disabled_agents,
      (SELECT count(*) FROM users WHERE kind = 'human' AND disabled = 1) AS disabled_humans,
      (SELECT count(*) FROM conversations) AS convs,
      (SELECT count(*) FROM messages) AS messages,
      (SELECT count(*) FROM events) AS events,
      (SELECT count(*) FROM audit_logs
         WHERE action = 'tool.exec' AND created_at >= ${Date.now() - 24 * 60 * 60 * 1000})
        AS tool_exec_24h,
      (SELECT count(*) FROM audit_logs
         WHERE action = 'tool.denied' AND created_at >= ${Date.now() - 24 * 60 * 60 * 1000})
        AS tool_denied_24h
  `);
  return {
    humans: row?.humans ?? 0,
    agents: row?.agents ?? 0,
    admins: row?.admins ?? 0,
    disabledAgents: row?.disabled_agents ?? 0,
    disabledHumans: row?.disabled_humans ?? 0,
    convs: row?.convs ?? 0,
    messages: row?.messages ?? 0,
    events: row?.events ?? 0,
    toolExec24h: row?.tool_exec_24h ?? 0,
    toolDenied24h: row?.tool_denied_24h ?? 0,
  };
}

/** 管理页的群组列表：全部会话 + 成员数 + 消息数，不要求调用者是成员。 */
export function adminListConversations(
  db: Db,
  limit: number,
): Array<{
  id: string;
  kind: 'group' | 'dm';
  title: string;
  createdBy: string;
  createdAt: number;
  memberCount: number;
  messageCount: number;
}> {
  const rows = db.all<{
    id: string;
    kind: 'group' | 'dm';
    title: string;
    created_by: string;
    created_at: number;
    member_count: number;
    message_count: number;
  }>(sql`
    SELECT c.id, c.kind, c.title, c.created_by, c.created_at,
           (SELECT count(*) FROM memberships m WHERE m.conv_id = c.id) AS member_count,
           (SELECT count(*) FROM messages msg WHERE msg.conv_id = c.id) AS message_count
    FROM conversations c
    ORDER BY c.created_at DESC
    LIMIT ${limit}
  `);
  return rows.map((r) => ({
    id: r.id,
    kind: r.kind,
    title: r.title,
    createdBy: r.created_by,
    createdAt: r.created_at,
    memberCount: r.member_count,
    messageCount: r.message_count,
  }));
}

/**
 * 管理页看某个群的成员（**不要求调用者是群成员**）。
 * 协议 §5.5 的 member.* 要求调用者是群内 owner/admin；管理页是跨群视角，
 * 所以单独开这条查询，权限由路由层的 is_admin 把关。
 */
export function adminListMembers(
  db: Db,
  convId: string,
): Array<{
  userId: string;
  username: string;
  displayName: string;
  kind: 'human' | 'agent';
  role: 'owner' | 'admin' | 'member';
  mutedUntil: number;
  joinedAt: number;
}> {
  return db
    .select({
      userId: memberships.userId,
      username: users.username,
      displayName: users.displayName,
      kind: users.kind,
      role: memberships.role,
      mutedUntil: memberships.mutedUntil,
      joinedAt: memberships.joinedAt,
    })
    .from(memberships)
    .innerJoin(users, eq(users.id, memberships.userId))
    .where(eq(memberships.convId, convId))
    .orderBy(asc(memberships.joinedAt))
    .all();
}

/** 审计日志可选过滤（管理页要按动作/操作者筛）。 */
export function listAuditFiltered(
  db: Db,
  opts: { tenantId: string; limit: number; action?: string; actorId?: string },
): AuditRow[] {
  const where = [eq(auditLogs.tenantId, opts.tenantId)];
  if (opts.action !== undefined && opts.action !== '') {
    where.push(eq(auditLogs.action, opts.action));
  }
  if (opts.actorId !== undefined && opts.actorId !== '') {
    where.push(eq(auditLogs.actorId, opts.actorId));
  }
  return db
    .select()
    .from(auditLogs)
    .where(and(...where))
    .orderBy(desc(auditLogs.createdAt), desc(auditLogs.id))
    .limit(opts.limit)
    .all();
}

/** 审计日志里出现过的动作名（给管理页做筛选下拉）。 */
export function listAuditActions(db: Db, tenantId: string): string[] {
  return db
    .select({ action: auditLogs.action })
    .from(auditLogs)
    .where(eq(auditLogs.tenantId, tenantId))
    .groupBy(auditLogs.action)
    .orderBy(asc(auditLogs.action))
    .all()
    .map((r) => r.action);
}

export function setUserDisabled(db: Db, id: string, disabled: boolean): void {
  db.update(users)
    .set({ disabled: disabled ? 1 : 0 })
    .where(eq(users.id, id))
    .run();
}

export function listAgents(db: Db, tenantId: string): UserRow[] {
  return db
    .select()
    .from(users)
    .where(and(eq(users.tenantId, tenantId), eq(users.kind, 'agent')))
    .orderBy(asc(users.createdAt))
    .all();
}

/** 已启用的人类管理员（工具告警的默认收件人）。 */
export function listHumanAdmins(db: Db, tenantId = 'default'): UserRow[] {
  return db
    .select()
    .from(users)
    .where(
      and(
        eq(users.tenantId, tenantId),
        eq(users.kind, 'human'),
        eq(users.isAdmin, 1),
        eq(users.disabled, 0),
      ),
    )
    .all();
}

export function listHumans(db: Db, tenantId: string): UserRow[] {
  return db
    .select()
    .from(users)
    .where(and(eq(users.tenantId, tenantId), eq(users.kind, 'human')))
    .orderBy(asc(users.createdAt))
    .all();
}

export function countHumans(db: Db): number {
  const row = db
    .select({ n: sql<number>`count(*)` })
    .from(users)
    .where(eq(users.kind, 'human'))
    .get();
  return row?.n ?? 0;
}

// ---------------------------------------------------------------------------
// refresh tokens（轮换）
// ---------------------------------------------------------------------------

export function insertRefreshToken(
  db: Db,
  row: typeof refreshTokens.$inferInsert,
): void {
  db.insert(refreshTokens).values(row).run();
}

export function findRefreshToken(db: Db, jti: string) {
  return db.select().from(refreshTokens).where(eq(refreshTokens.jti, jti)).get();
}

/**
 * 轮换：把旧 jti 标记为 replaced_by 并置 revoked_at。
 * 返回是否真的由本次调用完成轮换（并发下只有一个能成功）。
 */
export function consumeRefreshToken(db: Db, jti: string, replacedBy: string): boolean {
  const res = db
    .update(refreshTokens)
    .set({ replacedBy, revokedAt: Date.now() })
    .where(and(eq(refreshTokens.jti, jti), isNull(refreshTokens.revokedAt)))
    .run();
  return res.changes === 1;
}

export function revokeAllRefreshTokensForUser(db: Db, userId: string): number {
  const res = db
    .update(refreshTokens)
    .set({ revokedAt: Date.now() })
    .where(and(eq(refreshTokens.userId, userId), isNull(refreshTokens.revokedAt)))
    .run();
  return res.changes;
}

export function purgeExpiredRefreshTokens(db: Db, now = Date.now()): number {
  const res = db.delete(refreshTokens).where(lt(refreshTokens.expiresAt, now)).run();
  return res.changes;
}

// ---------------------------------------------------------------------------
// conversations + memberships
// ---------------------------------------------------------------------------

export function insertConversation(
  db: Db,
  row: typeof conversations.$inferInsert,
): void {
  db.insert(conversations).values(row).run();
}

export function updateConversation(
  db: Db,
  id: string,
  patch: { title?: string; announcement?: string },
): void {
  if (patch.title === undefined && patch.announcement === undefined) return;
  db.update(conversations).set(patch).where(eq(conversations.id, id)).run();
}

export function findConversation(db: Db, id: string): ConversationRow | undefined {
  return db.select().from(conversations).where(eq(conversations.id, id)).get();
}

export function insertMembership(
  db: Db,
  row: typeof memberships.$inferInsert,
): void {
  db.insert(memberships).values(row).run();
}

export function findMembership(
  db: Db,
  convId: string,
  userId: string,
): MembershipRow | undefined {
  return db
    .select()
    .from(memberships)
    .where(and(eq(memberships.convId, convId), eq(memberships.userId, userId)))
    .get();
}

/**
 * 更新已读水位（协议扩展 §5）。
 *
 * 用 `MAX(last_read_seq, ?)` 在 SQL 里做单调保护：即使两个客户端并发上报，
 * 也不会因为后到的小值把水位改小。
 */
export function setLastReadSeq(db: Db, convId: string, userId: string, lastSeq: number): void {
  db.run(
    sql`UPDATE memberships
           SET last_read_seq = MAX(last_read_seq, ${lastSeq})
         WHERE conv_id = ${convId} AND user_id = ${userId}`,
  );
}

export function listMemberships(db: Db, convId: string): MembershipRow[] {
  return db
    .select()
    .from(memberships)
    .where(eq(memberships.convId, convId))
    .orderBy(asc(memberships.joinedAt))
    .all();
}

export function deleteMembership(db: Db, convId: string, userId: string): boolean {
  const res = db
    .delete(memberships)
    .where(and(eq(memberships.convId, convId), eq(memberships.userId, userId)))
    .run();
  return res.changes === 1;
}

export function updateMembership(
  db: Db,
  convId: string,
  userId: string,
  patch: { role?: 'owner' | 'admin' | 'member'; mutedUntil?: number },
): void {
  if (patch.role === undefined && patch.mutedUntil === undefined) return;
  db.update(memberships)
    .set(patch)
    .where(and(eq(memberships.convId, convId), eq(memberships.userId, userId)))
    .run();
}

/**
 * `conv.list`：我加入了哪些会话，最近活跃优先（按会话最大 seq 倒序）。
 *
 * 这里用原始 SQL 而不是 drizzle 的查询构造器：需要按子查询算出的别名排序，
 * SQLite 在 ORDER BY 里不接受 drizzle 生成的列别名引用。
 */
export function listConversationsForUser(
  db: Db,
  userId: string,
  limit: number,
  cursor?: string,
): { rows: Array<ConversationRow & { memberCount: number; lastSeq: number }>; hasMore: boolean } {
  const cursorSeq = cursor === undefined ? null : Number(cursor.split(':')[0] ?? '0');
  const rows = db.all<{
    id: string;
    tenant_id: string;
    kind: 'group' | 'dm';
    title: string;
    announcement: string;
    pinned_message_id: string | null;
    created_by: string;
    created_at: number;
    member_count: number;
    last_seq: number;
  }>(sql`
    SELECT c.id, c.tenant_id, c.kind, c.title, c.announcement, c.pinned_message_id,
           c.created_by, c.created_at,
           (SELECT count(*) FROM memberships mm WHERE mm.conv_id = c.id) AS member_count,
           COALESCE((SELECT max(m.seq) FROM messages m WHERE m.conv_id = c.id), 0) AS last_seq
    FROM conversations c
    JOIN memberships me ON me.conv_id = c.id AND me.user_id = ${userId}
    WHERE ${cursorSeq === null ? sql`1=1` : sql`COALESCE((SELECT max(m2.seq) FROM messages m2 WHERE m2.conv_id = c.id), 0) < ${cursorSeq}`}
    ORDER BY last_seq DESC, c.id ASC
    LIMIT ${limit + 1}
  `);

  const hasMore = rows.length > limit;
  return {
    rows: rows.slice(0, limit).map((r) => ({
      id: r.id,
      tenantId: r.tenant_id,
      kind: r.kind,
      title: r.title,
      announcement: r.announcement,
      pinnedMessageId: r.pinned_message_id ?? null,
      createdBy: r.created_by,
      createdAt: r.created_at,
      memberCount: r.member_count,
      lastSeq: r.last_seq,
    })),
    hasMore,
  };
}

export function isMember(db: Db, convId: string, userId: string): boolean {
  return findMembership(db, convId, userId) !== undefined;
}

/** 我在哪些会话里（用于订阅过滤的默认范围）。 */
export function listMyConvIds(db: Db, userId: string): string[] {
  return db
    .select({ convId: memberships.convId })
    .from(memberships)
    .where(eq(memberships.userId, userId))
    .all()
    .map((r) => r.convId);
}

/**
 * 成员 + 展示名 + 用户名，用于 @ 提及判定（`only_mentions` 订阅）。
 *
 * 三种写法都要认：`@u_xxx`（ID，SDK 最省事）、`@昵称`（人类常用）、
 * `@username`（agent 最常用，因为 agent 的用户名是稳定的英文标识）。
 */
export function listMemberCandidates(
  db: Db,
  convId: string,
): Array<{ id: string; displayName: string; username: string }> {
  return db
    .select({ id: users.id, displayName: users.displayName, username: users.username })
    .from(memberships)
    .innerJoin(users, eq(users.id, memberships.userId))
    .where(eq(memberships.convId, convId))
    .all();
}

export function listMemberUserIds(db: Db, convId: string): string[] {
  return db
    .select({ userId: memberships.userId })
    .from(memberships)
    .where(eq(memberships.convId, convId))
    .all()
    .map((r) => r.userId);
}

// ---------------------------------------------------------------------------
// messages
// ---------------------------------------------------------------------------

/** 置顶/取消置顶（协议扩展 §4）。`messageId = null` 表示取消。 */
export function setPinnedMessage(db: Db, convId: string, messageId: string | null): void {
  db.update(conversations).set({ pinnedMessageId: messageId }).where(eq(conversations.id, convId)).run();
}

export function insertMessage(db: Db, row: typeof messages.$inferInsert): void {
  db.insert(messages).values(row).run();
}

export function findMessage(db: Db, id: string): MessageRow | undefined {
  return db.select().from(messages).where(eq(messages.id, id)).get();
}

export function findMessageByClientId(
  db: Db,
  senderId: string,
  clientMsgId: string,
): MessageRow | undefined {
  return db
    .select()
    .from(messages)
    .where(and(eq(messages.senderId, senderId), eq(messages.clientMsgId, clientMsgId)))
    .get();
}

export function updateMessageContent(
  db: Db,
  id: string,
  contentJson: string,
  textPlain: string,
): void {
  db.update(messages)
    .set({ contentJson, textPlain })
    .where(and(eq(messages.id, id), eq(messages.state, 'streaming')))
    .run();
}

/**
 * 编辑已终结的消息内容（协议扩展 §3）。
 *
 * 与 `updateMessageContent` 的区别：那个只改 streaming 的行（流式增量用）；
 * 这个改 final 的行，并打上 edited_at。分开写是为了让两处的 WHERE 条件一目了然 ——
 * 混用一个函数很容易把"编辑"误用到"流式刷新"上。
 */
export function updateMessageForEdit(
  db: Db,
  id: string,
  contentJson: string,
  textPlain: string,
  editedAt: number,
): void {
  db.update(messages)
    .set({ contentJson, textPlain, editedAt })
    .where(and(eq(messages.id, id), eq(messages.state, 'final')))
    .run();
}

export function finalizeMessage(
  db: Db,
  id: string,
  patch: {
    contentJson?: string;
    textPlain?: string;
    seq?: number;
    interrupted?: number;
    finalizedAt: number;
  },
): void {
  db.update(messages)
    .set({ ...patch, state: 'final' })
    .where(eq(messages.id, id))
    .run();
}

export function revokeMessage(db: Db, id: string, by: string, at: number): void {
  db.update(messages)
    .set({ state: 'revoked', revokedAt: at, revokedBy: by })
    .where(eq(messages.id, id))
    .run();
}

export function deleteMessage(db: Db, id: string): void {
  db.delete(messages).where(eq(messages.id, id)).run();
}

/**
 * `history.fetch`：按 seq 降序分页（协议 §5.3）。
 * 只返回终态消息；已撤回的不返回（M2 验收 5）。
 */
export function listHistory(
  db: Db,
  convId: string,
  limit: number,
  beforeSeq?: number,
): { rows: MessageRow[]; hasMore: boolean } {
  const where =
    beforeSeq === undefined
      ? and(eq(messages.convId, convId), ne(messages.state, 'revoked'), sql`${messages.seq} IS NOT NULL`)
      : and(
          eq(messages.convId, convId),
          ne(messages.state, 'revoked'),
          sql`${messages.seq} IS NOT NULL`,
          lt(messages.seq, beforeSeq),
        );
  const rows = db
    .select()
    .from(messages)
    .where(where)
    .orderBy(desc(messages.seq))
    .limit(limit + 1)
    .all();
  return { rows: rows.slice(0, limit), hasMore: rows.length > limit };
}

/** `context.fetch` 用：锚点之前的 N 条（升序返回由调用方处理）。 */
export function listContextBefore(
  db: Db,
  convId: string,
  limit: number,
  anchorSeq?: number,
): MessageRow[] {
  const where =
    anchorSeq === undefined
      ? and(eq(messages.convId, convId), eq(messages.state, 'final'))
      : and(eq(messages.convId, convId), eq(messages.state, 'final'), lt(messages.seq, anchorSeq));
  return db
    .select()
    .from(messages)
    .where(where)
    .orderBy(desc(messages.seq))
    .limit(limit)
    .all();
}

export function listContextAfter(
  db: Db,
  convId: string,
  anchorSeq: number,
  limit: number,
): MessageRow[] {
  return db
    .select()
    .from(messages)
    .where(
      and(
        eq(messages.convId, convId),
        eq(messages.state, 'final'),
        gt(messages.seq, anchorSeq),
      ),
    )
    .orderBy(asc(messages.seq))
    .limit(limit)
    .all();
}

export function listStreamingMessages(db: Db, olderThan: number): MessageRow[] {
  return db
    .select()
    .from(messages)
    .where(and(eq(messages.state, 'streaming'), lt(messages.createdAt, olderThan)))
    .all();
}

export function listAllStreaming(db: Db): MessageRow[] {
  return db.select().from(messages).where(eq(messages.state, 'streaming')).all();
}

// ---------------------------------------------------------------------------
// events（seq 分配的唯一入口）
// ---------------------------------------------------------------------------

/**
 * 分配 seq 并写入事件行（数据模型 §4）。
 *
 * **必须在调用方的事务里**：消息写入与 seq 分配同事务，否则会出现
 * "有消息无事件"的窗口。`seq` 由 AUTOINCREMENT 分配，绝不用时间戳或 max+1。
 */
export function appendEvent(
  db: Db,
  row: { tenantId: string; convId: string | null; type: string; payload: string; createdAt: number },
): number {
  const inserted = db
    .insert(events)
    .values({
      tenantId: row.tenantId,
      convId: row.convId,
      type: row.type,
      payload: row.payload,
      createdAt: row.createdAt,
    })
    .returning({ seq: events.seq })
    .get();
  if (!inserted) throw new Error('events insert returned no seq');
  return inserted.seq;
}

/**
 * 回填事件的 payload。
 *
 * 为什么需要它：`message.final` 的 payload 里要带完整 message，而 message.seq
 * 正是这次 appendEvent 分配的 seq —— 只有 insert 之后才知道。所以先占位插入，
 * 同一事务内再回填。两步同事务，外部看不到中间态（数据模型 §4）。
 */
export function updateEventPayload(db: Db, seq: number, payload: string): void {
  db.update(events).set({ payload }).where(eq(events.seq, seq)).run();
}

export interface ReplayRow {
  seq: number;
  type: string;
  payload: string;
  createdAt: number;
  convId: string | null;
}

export function listEventsAfter(
  db: Db,
  afterSeq: number,
  limit: number,
): ReplayRow[] {
  return db
    .select({
      seq: events.seq,
      type: events.type,
      payload: events.payload,
      createdAt: events.createdAt,
      convId: events.convId,
    })
    .from(events)
    .where(gt(events.seq, afterSeq))
    .orderBy(asc(events.seq))
    .limit(limit)
    .all();
}

export function maxEventSeq(db: Db): number {
  const row = db.select({ n: sql<number>`COALESCE(max(seq), 0)` }).from(events).get();
  return row?.n ?? 0;
}

export function minEventSeq(db: Db): number {
  const row = db.select({ n: sql<number>`COALESCE(min(seq), 0)` }).from(events).get();
  return row?.n ?? 0;
}

/** 删掉 created_at < cutoff 的审计行（保留期外）。0 表示调用方不该调。 */
export function deleteAuditOlderThan(db: Db, cutoff: number): number {
  const res = db.delete(auditLogs).where(lt(auditLogs.createdAt, cutoff)).run();
  return res.changes;
}

export function deleteEventsOlderThan(db: Db, cutoff: number): number {
  const res = db.delete(events).where(lt(events.createdAt, cutoff)).run();
  return res.changes;
}

export function countEvents(db: Db): number {
  const row = db.select({ n: sql<number>`count(*)` }).from(events).get();
  return row?.n ?? 0;
}

export function countMessages(db: Db, convId?: string): number {
  const q = db.select({ n: sql<number>`count(*)` }).from(messages);
  const row = convId === undefined ? q.get() : q.where(eq(messages.convId, convId)).get();
  return row?.n ?? 0;
}

export function countAudit(db: Db, action?: string): number {
  const q = db.select({ n: sql<number>`count(*)` }).from(auditLogs);
  const row = action === undefined ? q.get() : q.where(eq(auditLogs.action, action)).get();
  return row?.n ?? 0;
}

// ---------------------------------------------------------------------------
// audit
// ---------------------------------------------------------------------------

export function insertAudit(
  db: Db,
  row: typeof auditLogs.$inferInsert,
): void {
  db.insert(auditLogs).values(row).run();
}

export function listAudit(
  db: Db,
  tenantId: string,
  limit: number,
  cursor?: string,
): { rows: AuditRow[]; hasMore: boolean } {
  const q = db
    .select()
    .from(auditLogs)
    .where(
      cursor === undefined
        ? eq(auditLogs.tenantId, tenantId)
        : and(eq(auditLogs.tenantId, tenantId), lt(auditLogs.id, cursor)),
    )
    .orderBy(desc(auditLogs.createdAt), desc(auditLogs.id))
    .limit(limit + 1);
  const rows = q.all();
  return { rows: rows.slice(0, limit), hasMore: rows.length > limit };
}

// ---------------------------------------------------------------------------
// attachments
// ---------------------------------------------------------------------------

export function insertAttachment(
  db: Db,
  row: typeof attachments.$inferInsert,
): void {
  db.insert(attachments).values(row).run();
}

export function findAttachment(db: Db, id: string): AttachmentRow | undefined {
  return db.select().from(attachments).where(eq(attachments.id, id)).get();
}

export function findAttachmentBySha(db: Db, sha256: string): AttachmentRow | undefined {
  return db.select().from(attachments).where(eq(attachments.sha256, sha256)).get();
}

/**
 * 哪些会话里的消息引用了这个附件（附件下载的权限判定用）。
 * content_json 里出现 attachment_id 即视为引用；LIKE 足够，附件引用是低频查询。
 */
export function listConvsReferencingAttachment(
  db: Db,
  attachmentId: string,
): Array<{ convId: string }> {
  const rows = db.all<{ conv_id: string }>(sql`
    SELECT DISTINCT conv_id FROM messages
    WHERE content_json LIKE '%' || ${attachmentId} || '%'
    LIMIT 100
  `);
  return rows.map((r) => ({ convId: r.conv_id }));
}

export function countAttachments(db: Db, sha256?: string): number {
  const row =
    sha256 === undefined
      ? db.select({ n: sql<number>`count(*)` }).from(attachments).get()
      : db
          .select({ n: sql<number>`count(*)` })
          .from(attachments)
          .where(eq(attachments.sha256, sha256))
          .get();
  return row?.n ?? 0;
}

// ---------------------------------------------------------------------------
// 事务
// ---------------------------------------------------------------------------

/**
 * better-sqlite3 的同步事务。数据模型 §4 要求"消息与事件同一事务"，
 * 所有写消息的路径都必须包在这里面。
 */
export function transaction<T>(db: Db, fn: () => T): T {
  return db.transaction(fn);
}

export { and, asc, desc, eq, gt, inArray, isNull, lt, ne, or, sql };
