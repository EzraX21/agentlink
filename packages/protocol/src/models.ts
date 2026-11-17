import { z } from 'zod';

/**
 * 协议里的共享对象（协议 §3.2、§5、§6、§7）。
 * 所有 ID 都是带前缀的 ULID 字符串（数据模型 §0）。
 */

const ULID_BODY = '[0-9A-HJKMNP-TV-Z]{26}';

export const UserIdSchema = z.string().regex(new RegExp(`^u_${ULID_BODY}$`), 'expected u_<ULID>');
export const ConvIdSchema = z.string().regex(new RegExp(`^c_${ULID_BODY}$`), 'expected c_<ULID>');
export const MessageIdSchema = z.string().regex(new RegExp(`^m_${ULID_BODY}$`), 'expected m_<ULID>');
export const AttachmentIdSchema = z
  .string()
  .regex(new RegExp(`^a_${ULID_BODY}$`), 'expected a_<ULID>');

export const IdSchema = z.union([
  UserIdSchema,
  ConvIdSchema,
  MessageIdSchema,
  AttachmentIdSchema,
]);

export const UnixMsSchema = z.number().int().nonnegative();

/** 人类与 agent 共用（需求 D3）。 */
export const UserKindSchema = z.enum(['human', 'agent']);
export type UserKind = z.infer<typeof UserKindSchema>;

export const RoleSchema = z.enum(['owner', 'admin', 'member']);
export type Role = z.infer<typeof RoleSchema>;

export const ConvKindSchema = z.enum(['group', 'dm']);
export type ConvKind = z.infer<typeof ConvKindSchema>;

export const MessageStateSchema = z.enum(['streaming', 'final', 'revoked']);
export type MessageState = z.infer<typeof MessageStateSchema>;

// ---------------------------------------------------------------------------
// content 块（协议 §5.3）：块数组，不是字符串
// ---------------------------------------------------------------------------

export const TextBlockSchema = z.object({
  type: z.literal('text'),
  text: z.string().min(1).max(8000),
});

export const ImageBlockSchema = z.object({
  type: z.literal('image'),
  attachment_id: AttachmentIdSchema,
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
});

export const FileBlockSchema = z.object({
  type: z.literal('file'),
  attachment_id: AttachmentIdSchema,
  filename: z.string().min(1).max(255).optional(),
  size: z.number().int().nonnegative().optional(),
});

export const ContentBlockSchema = z.discriminatedUnion('type', [
  TextBlockSchema,
  ImageBlockSchema,
  FileBlockSchema,
]);
export type ContentBlock = z.infer<typeof ContentBlockSchema>;

/** 单条消息最多 20 块（协议 §5.3）。 */
export const ContentSchema = z.array(ContentBlockSchema).min(1).max(20);
export type Content = z.infer<typeof ContentSchema>;

// ---------------------------------------------------------------------------
// 展示对象
// ---------------------------------------------------------------------------

export const UserSummarySchema = z.object({
  id: UserIdSchema,
  kind: UserKindSchema,
  display_name: z.string(),
  avatar_url: z.string().nullable().optional(),
});
export type UserSummary = z.infer<typeof UserSummarySchema>;

/** `auth` 成功返回的 `self`（协议 §2.2）。 */
export const SelfSchema = z.object({
  id: UserIdSchema,
  kind: UserKindSchema,
  display_name: z.string(),
  tenant_id: z.string(),
});
export type Self = z.infer<typeof SelfSchema>;

/**
 * 一条消息上的某种表情汇总（协议扩展 §2）。
 *
 * 回的是**全量**而不是增量：客户端整体替换，丢帧也不会不一致。
 * `user_ids` 直接给出（群上限 50 人，payload 可控），前端据此判断"我点过没有"。
 */
export const ReactionSummarySchema = z.object({
  emoji: z.string().min(1).max(32),
  user_ids: z.array(UserIdSchema).max(500),
});
export type ReactionSummary = z.infer<typeof ReactionSummarySchema>;

export const MessageSchema = z.object({
  id: MessageIdSchema,
  conv_id: ConvIdSchema,
  /** streaming 期间为 null（协议 §4.1）。 */
  seq: z.number().int().nonnegative().nullable(),
  sender: UserSummarySchema,
  content: ContentSchema,
  reply_to: MessageIdSchema.nullable(),
  state: MessageStateSchema,
  interrupted: z.boolean(),
  created_at: UnixMsSchema,
  revoked_at: UnixMsSchema.nullable(),
  /**
   * 表情回应汇总（协议扩展 §2）。可选：老服务端不返回时客户端按"没有回应"处理。
   * 撤回的消息一律为空数组。
   */
  reactions: z.array(ReactionSummarySchema).optional(),
  /**
   * 最后一次被编辑的时间（协议扩展 §3）。null / 缺省 = 从未编辑。
   * 不做编辑历史（需求确认书 §5 排除），只标记"改过"。
   */
  edited_at: UnixMsSchema.nullable().optional(),
});
export type Message = z.infer<typeof MessageSchema>;

export const ConversationSchema = z.object({
  id: ConvIdSchema,
  kind: ConvKindSchema,
  title: z.string(),
  announcement: z.string(),
  created_by: UserIdSchema,
  created_at: UnixMsSchema,
  member_count: z.number().int().nonnegative().optional(),
  /**
   * 置顶消息 id（协议扩展 §4）。null / 缺省 = 没有置顶。
   * v1 只支持单条置顶；被置顶的消息可能已被撤回，客户端要按 id 找不到就忽略。
   */
  pinned_message_id: z.string().nullable().optional(),
});
export type Conversation = z.infer<typeof ConversationSchema>;


export const MemberSchema = z.object({
  conv_id: ConvIdSchema,
  user_id: UserIdSchema,
  role: RoleSchema,
  /** 仅标记，v1 不参与鉴权（协议 §10）。 */
  is_agent: z.boolean(),
  muted_until: UnixMsSchema,
  joined_at: UnixMsSchema,
  /**
   * 该成员在该会话里读到的最大 seq（协议扩展 §5）。
   *
   * 可选是为了兼容：老服务端不返回这个字段时客户端按 0 处理（等于"没已读"）。
   */
  last_read_seq: z.number().int().min(0).optional(),
  user: UserSummarySchema,
});
export type Member = z.infer<typeof MemberSchema>;

/** `context.fetch` 返回的一条（协议 §7）：可直接拼 prompt。 */
export const ContextMessageSchema = z.object({
  seq: z.number().int().nonnegative(),
  ts: UnixMsSchema,
  sender: z.string(),
  sender_id: UserIdSchema,
  sender_kind: UserKindSchema,
  text: z.string(),
  quote: z.string().nullable(),
});
export type ContextMessage = z.infer<typeof ContextMessageSchema>;

export const SearchHitSchema = z.object({
  message_id: MessageIdSchema,
  conv_id: ConvIdSchema,
  seq: z.number().int().nonnegative(),
  sender_id: UserIdSchema,
  excerpt: z.string(),
  created_at: UnixMsSchema,
});
export type SearchHit = z.infer<typeof SearchHitSchema>;

/** 订阅过滤器（协议 §5.6）。三个字段都可省略。 */
export const SubscriptionFiltersSchema = z.object({
  conv_ids: z.array(ConvIdSchema).max(200).optional(),
  event_types: z.array(z.string()).max(50).optional(),
  only_mentions: z.boolean().optional(),
});
export type SubscriptionFilters = z.infer<typeof SubscriptionFiltersSchema>;
