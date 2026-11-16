import { z } from 'zod';
import {
  AttachmentIdSchema,
  ContextMessageSchema,
  ConvIdSchema,
  ContentSchema,
  ConversationSchema,
  MemberSchema,
  MessageIdSchema,
  MessageSchema,
  RoleSchema,
  SearchHitSchema,
  SelfSchema,
  SubscriptionFiltersSchema,
  UnixMsSchema,
  UserIdSchema,
} from './models.js';

/**
 * 操作清单（协议 §5）。每个 op 的入参/出参 schema 都在这里，
 * 服务端与客户端都从本文件取，不许各写一份。
 */

const OkSchema = z.object({ ok: z.literal(true) });
export type Ok = z.infer<typeof OkSchema>;

// ---------------------------------------------------------------------------
// §5.1 认证与连接
// ---------------------------------------------------------------------------

const AuthReq = z.object({
  token: z.string().min(1),
});
const AuthRes = z.object({
  protocol: z.literal(1),
  self: SelfSchema,
  server_time: UnixMsSchema,
});

const ResumeReq = z.object({
  last_seq: z.number().int().nonnegative(),
});
const ResumeRes = z.object({
  replayed: z.number().int().nonnegative(),
  up_to: z.number().int().nonnegative(),
  gap: z.boolean(),
});

const SubscribeSetReq = z.object({
  filters: SubscriptionFiltersSchema,
});
const SubscribeSetRes = z.object({ applied: z.literal(true) });

const PingReq = z.object({}).strict();
const PingRes = z.object({ server_time: UnixMsSchema });

// ---------------------------------------------------------------------------
// §5.2 会话
// ---------------------------------------------------------------------------

const ConvListReq = z.object({
  limit: z.number().int().min(1).max(100).optional(),
  cursor: z.string().optional(),
});
const ConvListRes = z.object({
  items: z.array(ConversationSchema),
  next_cursor: z.string().optional(),
});

const ConvCreateReq = z.object({
  kind: z.enum(['group', 'dm']),
  title: z.string().max(128).optional(),
  member_ids: z.array(UserIdSchema).max(200).optional(),
});
const ConvCreateRes = z.object({ conv: ConversationSchema });

const ConvGetReq = z.object({ conv_id: ConvIdSchema });
const ConvGetRes = z.object({
  conv: ConversationSchema,
  members: z.array(MemberSchema),
});

const GroupUpdateReq = z.object({
  conv_id: ConvIdSchema,
  title: z.string().max(128).optional(),
  announcement: z.string().max(4000).optional(),
});
const GroupUpdateRes = z.object({ conv: ConversationSchema });

// ---------------------------------------------------------------------------
// §5.3 消息
// ---------------------------------------------------------------------------

const MessageSendReq = z.object({
  conv_id: ConvIdSchema,
  client_msg_id: z.string().min(1).max(128),
  content: ContentSchema,
  reply_to: MessageIdSchema.optional(),
});
const MessageSendRes = z.object({
  message_id: MessageIdSchema,
  seq: z.number().int().nonnegative(),
  client_msg_id: z.string(),
  created_at: UnixMsSchema,
});

const MessageGetReq = z.object({
  conv_id: ConvIdSchema,
  message_id: MessageIdSchema,
});
const MessageGetRes = z.object({ message: MessageSchema });

const MessageRevokeReq = z.object({
  conv_id: ConvIdSchema,
  message_id: MessageIdSchema,
});
const MessageRevokeRes = OkSchema;

const HistoryFetchReq = z.object({
  conv_id: ConvIdSchema,
  before_seq: z.number().int().nonnegative().optional(),
  limit: z.number().int().min(1).max(100).optional(),
});
const HistoryFetchRes = z.object({
  messages: z.array(MessageSchema),
  has_more: z.boolean(),
});

// §7 context.fetch —— 本项目最关键的一个接口
const ContextFetchReq = z.object({
  conv_id: ConvIdSchema,
  anchor_seq: z.number().int().nonnegative().optional(),
  before: z.number().int().min(0).max(100).optional(),
  after: z.number().int().min(0).max(100).optional(),
  include_quoted: z.boolean().optional(),
  max_chars: z.number().int().min(1).max(200_000).optional(),
});
const ContextFetchRes = z.object({
  messages: z.array(ContextMessageSchema),
  truncated: z.boolean(),
  dropped_count: z.number().int().nonnegative(),
});

// ---------------------------------------------------------------------------
// §5.4 流式
// ---------------------------------------------------------------------------

const StreamBeginReq = z.object({
  conv_id: ConvIdSchema,
  client_msg_id: z.string().min(1).max(128),
  reply_to: MessageIdSchema.optional(),
});
const StreamBeginRes = z.object({
  message_id: MessageIdSchema,
  conv_id: ConvIdSchema,
  rev: z.number().int().nonnegative(),
});

const StreamDeltaReq = z.object({
  conv_id: ConvIdSchema,
  message_id: MessageIdSchema,
  delta: z.string().min(1).max(8000),
});
const StreamDeltaRes = OkSchema;

const StreamCommitReq = z.object({
  conv_id: ConvIdSchema,
  message_id: MessageIdSchema,
});
const StreamCommitRes = z.object({ message: MessageSchema });

const StreamAbortReq = z.object({
  conv_id: ConvIdSchema,
  message_id: MessageIdSchema,
  reason: z.string().max(200).optional(),
});
const StreamAbortRes = z.object({ message: MessageSchema });

const StreamInterruptReq = z.object({
  conv_id: ConvIdSchema,
  message_id: MessageIdSchema,
});
const StreamInterruptRes = OkSchema;

// ---------------------------------------------------------------------------
// §5.5 成员与群管理
// ---------------------------------------------------------------------------

const MemberInviteReq = z.object({
  conv_id: ConvIdSchema,
  user_ids: z.array(UserIdSchema).min(1).max(50),
});
const MemberInviteRes = z.object({ members: z.array(MemberSchema) });

const MemberKickReq = z.object({
  conv_id: ConvIdSchema,
  user_id: UserIdSchema,
});
const MemberKickRes = OkSchema;

const MemberMuteReq = z.object({
  conv_id: ConvIdSchema,
  user_id: UserIdSchema,
  /** 0 = 解除禁言。 */
  until_ms: UnixMsSchema,
});
const MemberMuteRes = OkSchema;

const MemberRoleSetReq = z.object({
  conv_id: ConvIdSchema,
  user_id: UserIdSchema,
  role: RoleSchema,
});
const MemberRoleSetRes = OkSchema;

const PokeSendReq = z.object({
  conv_id: ConvIdSchema,
  user_id: UserIdSchema,
});
const PokeSendRes = OkSchema;

// ---------------------------------------------------------------------------
// §5.7 检索
// ---------------------------------------------------------------------------

const SearchMessagesReq = z.object({
  q: z.string().min(1).max(200),
  conv_id: ConvIdSchema.optional(),
  from_user_id: UserIdSchema.optional(),
  before: UnixMsSchema.optional(),
  after: UnixMsSchema.optional(),
  limit: z.number().int().min(1).max(100).optional(),
});
const SearchMessagesRes = z.object({ hits: z.array(SearchHitSchema) });

// ---------------------------------------------------------------------------
// 注册表
// ---------------------------------------------------------------------------

export const OPS = {
  auth: { req: AuthReq, res: AuthRes },
  resume: { req: ResumeReq, res: ResumeRes },
  'subscribe.set': { req: SubscribeSetReq, res: SubscribeSetRes },
  ping: { req: PingReq, res: PingRes },

  'conv.list': { req: ConvListReq, res: ConvListRes },
  'conv.create': { req: ConvCreateReq, res: ConvCreateRes },
  'conv.get': { req: ConvGetReq, res: ConvGetRes },
  'group.update': { req: GroupUpdateReq, res: GroupUpdateRes },

  'message.send': { req: MessageSendReq, res: MessageSendRes },
  'message.get': { req: MessageGetReq, res: MessageGetRes },
  'message.revoke': { req: MessageRevokeReq, res: MessageRevokeRes },
  'history.fetch': { req: HistoryFetchReq, res: HistoryFetchRes },
  'context.fetch': { req: ContextFetchReq, res: ContextFetchRes },

  'stream.begin': { req: StreamBeginReq, res: StreamBeginRes },
  'stream.delta': { req: StreamDeltaReq, res: StreamDeltaRes },
  'stream.commit': { req: StreamCommitReq, res: StreamCommitRes },
  'stream.abort': { req: StreamAbortReq, res: StreamAbortRes },
  'stream.interrupt': { req: StreamInterruptReq, res: StreamInterruptRes },

  'member.invite': { req: MemberInviteReq, res: MemberInviteRes },
  'member.kick': { req: MemberKickReq, res: MemberKickRes },
  'member.mute': { req: MemberMuteReq, res: MemberMuteRes },
  'member.role.set': { req: MemberRoleSetReq, res: MemberRoleSetRes },
  'poke.send': { req: PokeSendReq, res: PokeSendRes },

  'search.messages': { req: SearchMessagesReq, res: SearchMessagesRes },
} as const;

export type OpName = keyof typeof OPS;
export type OpReq<N extends OpName> = z.infer<(typeof OPS)[N]['req']>;
export type OpRes<N extends OpName> = z.infer<(typeof OPS)[N]['res']>;

export const OP_NAMES = Object.keys(OPS) as OpName[];

export function isKnownOp(op: string): op is OpName {
  return Object.hasOwn(OPS, op);
}

/** 解析某个 op 的入参；`data` 缺省等价于 `{}`（协议 §3.1）。 */
export function parseOpData<N extends OpName>(
  op: N,
  data: unknown,
): z.ZodSafeParseResult<OpReq<N>> {
  return OPS[op].req.safeParse(data ?? {}) as z.ZodSafeParseResult<OpReq<N>>;
}

export { AttachmentIdSchema };
