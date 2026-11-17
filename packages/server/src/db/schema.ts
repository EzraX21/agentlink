import { sql, type SQL } from 'drizzle-orm';
import {
  check,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';
import type { AnySQLiteColumn } from 'drizzle-orm/sqlite-core';

/**
 * 表结构（数据模型 §1）。这里的 DDL 是基线，可以加字段，不得删改语义。
 *
 * 所有时间戳为 unix 毫秒整数；所有 ID 为带前缀的 ULID 字符串；
 * `tenant_id` 默认 'default'，v1 恒为此值（需求 D4 的预留）。
 */

function tenantId(): SQLiteColumnBuilder {
  return text('tenant_id').notNull().default('default');
}

function createdAt(name = 'created_at'): SQLiteColumnBuilder {
  return integer(name).notNull();
}

/** 列的构造器类型别名，避免自引用推断成 any。 */
type SQLiteColumnBuilder = ReturnType<typeof text> | ReturnType<typeof integer>;

export const users = sqliteTable(
  'users',
  {
    id: text('id').primaryKey(),
    tenantId: tenantId(),
    kind: text('kind', { enum: ['human', 'agent'] }).notNull(),
    username: text('username').notNull(),
    displayName: text('display_name').notNull(),
    avatarUrl: text('avatar_url'),
    /** 仅 human，argon2id。 */
    passwordHash: text('password_hash'),
    /** 仅 agent，sha256(secret + pepper)（数据模型 §5）。 */
    tokenHash: text('token_hash'),
    /** 仅 agent，展示用。 */
    model: text('model'),
    /** agent 的属主。 */
    ownerUserId: text('owner_user_id').references((): AnySQLiteColumn => users.id),
    disabled: integer('disabled').notNull().default(0),
    /**
     * 全局管理员（Web 管理页的准入）。
     *
     * 数据模型 §1 没有这个字段，但"管理页"必须有个准入概念，否则任何人类账号
     * 都能建 agent / 停用 agent / 读审计。属于"实现可以加字段"（数据模型 §1 开头）。
     * 迁移 0003 加列，并把最早的人类账号提升为管理员（见该迁移）。
     */
    isAdmin: integer('is_admin').notNull().default(0),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('ux_users_username').on(t.tenantId, t.username),
    check('ck_users_kind', sql`${t.kind} IN ('human','agent')`),
  ],
);

export const conversations = sqliteTable(
  'conversations',
  {
    id: text('id').primaryKey(),
    tenantId: tenantId(),
    kind: text('kind', { enum: ['group', 'dm'] }).notNull(),
    title: text('title').notNull().default(''),
    announcement: text('announcement').notNull().default(''),
    createdBy: text('created_by')
      .notNull()
      .references(() => users.id),
    createdAt: createdAt(),
  },
  (t) => [check('ck_conversations_kind', sql`${t.kind} IN ('group','dm')`)],
);

export const memberships = sqliteTable(
  'memberships',
  {
    convId: text('conv_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => users.id),
    role: text('role', { enum: ['owner', 'admin', 'member'] }).notNull(),
    /** 仅标记，v1 不参与鉴权（协议 §10）。 */
    isAgent: integer('is_agent').notNull().default(0),
    mutedUntil: integer('muted_until').notNull().default(0),
    joinedAt: integer('joined_at').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.convId, t.userId] }),
    index('ix_memberships_user').on(t.userId),
    check('ck_memberships_role', sql`${t.role} IN ('owner','admin','member')`),
  ],
);

export const messages = sqliteTable(
  'messages',
  {
    id: text('id').primaryKey(),
    tenantId: tenantId(),
    convId: text('conv_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    senderId: text('sender_id')
      .notNull()
      .references(() => users.id),
    /** 对应 events.seq；streaming 期间为 NULL。 */
    seq: integer('seq'),
    /** 幂等键。 */
    clientMsgId: text('client_msg_id'),
    /** 块数组 JSON。 */
    contentJson: text('content_json').notNull(),
    /** 供 FTS 与 context 使用。 */
    textPlain: text('text_plain').notNull().default(''),
    replyTo: text('reply_to'),
    state: text('state', { enum: ['streaming', 'final', 'revoked'] }).notNull(),
    interrupted: integer('interrupted').notNull().default(0),
    createdAt: createdAt(),
    finalizedAt: integer('finalized_at'),
    revokedAt: integer('revoked_at'),
    revokedBy: text('revoked_by').references(() => users.id),
  },
  (t) => [
    index('ix_messages_conv_seq').on(t.convId, t.seq),
    uniqueIndex('ux_messages_idem')
      .on(t.senderId, t.clientMsgId)
      .where(sql`client_msg_id IS NOT NULL`),
    index('ix_messages_streaming')
      .on(t.state)
      .where(sql`state = 'streaming'`),
    check('ck_messages_state', sql`${t.state} IN ('streaming','final','revoked')`),
  ],
);

/**
 * 事件日志：断线补齐的唯一来源（数据模型 §4）。
 * `seq` 必须是 INTEGER PRIMARY KEY AUTOINCREMENT —— 裸 PRIMARY KEY 在删行后会复用 rowid，
 * 客户端会把新事件当成旧的。这一条由 drizzle 的 autoIncrement 生成，迁移文件里可见。
 */
export const events = sqliteTable(
  'events',
  {
    seq: integer('seq').primaryKey({ autoIncrement: true }),
    tenantId: tenantId(),
    /** 非会话事件为 NULL。 */
    convId: text('conv_id'),
    type: text('type').notNull(),
    /** 完整 evt.data 的 JSON。 */
    payload: text('payload').notNull(),
    createdAt: createdAt(),
  },
  (t) => [index('ix_events_conv_seq').on(t.convId, t.seq)],
);

export const attachments = sqliteTable(
  'attachments',
  {
    id: text('id').primaryKey(),
    tenantId: tenantId(),
    uploaderId: text('uploader_id')
      .notNull()
      .references(() => users.id),
    filename: text('filename').notNull(),
    mime: text('mime').notNull(),
    size: integer('size').notNull(),
    sha256: text('sha256').notNull(),
    /** 相对存储根的 content-addressed 路径。 */
    path: text('path').notNull(),
    createdAt: createdAt(),
  },
  (t) => [index('ix_attachments_sha').on(t.sha256)],
);

export const auditLogs = sqliteTable(
  'audit_logs',
  {
    id: text('id').primaryKey(),
    tenantId: tenantId(),
    actorId: text('actor_id')
      .notNull()
      .references(() => users.id),
    /** member.kick / member.mute / member.role.set / group.update / agent.create ... */
    action: text('action').notNull(),
    /** user / group / agent */
    targetType: text('target_type').notNull(),
    targetId: text('target_id').notNull(),
    detail: text('detail').notNull().default('{}'),
    createdAt: createdAt(),
  },
  (t) => [index('ix_audit_created').on(t.createdAt)],
);

/**
 * refresh token 轮换（M1）。
 *
 * 数据模型 §1 没有这张表，但协议要求 refresh 轮换后"旧 token 立即失效"，
 * 而 JWT 无状态，必须有服务端状态才能作废旧 jti。属于"实现可以加字段"的延伸，
 * 记在 docs/DECISIONS.md。
 */
export const refreshTokens = sqliteTable(
  'refresh_tokens',
  {
    jti: text('jti').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id),
    /** 轮换链：被换掉时写 replaced_by。 */
    replacedBy: text('replaced_by'),
    revokedAt: integer('revoked_at'),
    expiresAt: integer('expires_at').notNull(),
    createdAt: createdAt(),
  },
  (t) => [index('ix_refresh_user').on(t.userId)],
);

export type UserRow = typeof users.$inferSelect;
export type ConversationRow = typeof conversations.$inferSelect;
export type MembershipRow = typeof memberships.$inferSelect;
export type MessageRow = typeof messages.$inferSelect;
export type EventRow = typeof events.$inferSelect;
export type AuditRow = typeof auditLogs.$inferSelect;
export type AttachmentRow = typeof attachments.$inferSelect;
export type RefreshTokenRow = typeof refreshTokens.$inferSelect;
