import { z } from 'zod';
import {
  ConversationSchema,
  ConvIdSchema,
  MemberSchema,
  MessageIdSchema,
  MessageSchema,
  ReactionSummarySchema,
  UserIdSchema,
  UserSummarySchema,
} from './models.js';

/**
 * 事件清单（协议 §6）。`seq` 列表示该事件是否进 `events` 表、能否补发。
 * 未知 `type` 客户端必须忽略（前向兼容硬要求）。
 */

const MessageNewData = z.object({
  conv_id: ConvIdSchema,
  message: MessageSchema,
});

/** 流式增量：seq 恒为 null，不落库、不补发（协议 §8.3）。 */
const MessageUpdateData = z.object({
  conv_id: ConvIdSchema,
  message_id: MessageIdSchema,
  rev: z.number().int().nonnegative(),
  delta: z.string(),
});

const MessageFinalData = z.object({
  conv_id: ConvIdSchema,
  message: MessageSchema,
});

const MessageRevokeData = z.object({
  conv_id: ConvIdSchema,
  message_id: MessageIdSchema,
  by: UserIdSchema,
});

const MemberJoinData = z.object({
  conv_id: ConvIdSchema,
  member: MemberSchema,
});

const MemberLeaveData = z.object({
  conv_id: ConvIdSchema,
  user_id: UserIdSchema,
  reason: z.enum(['kicked', 'left']),
});

const MemberUpdateData = z.object({
  conv_id: ConvIdSchema,
  member: MemberSchema,
});

const GroupUpdateData = z.object({
  conv_id: ConvIdSchema,
  conv: ConversationSchema,
});

const TypingData = z.object({
  conv_id: ConvIdSchema,
  user_id: UserIdSchema,
  user: UserSummarySchema.optional(),
});

const PokeData = z.object({
  conv_id: ConvIdSchema,
  from_user_id: UserIdSchema,
  to_user_id: UserIdSchema,
});

/** 置顶变化（协议扩展 §4）。带 seq：置顶是会话状态，重连要能看到横幅。 */
export const MessagePinData = z.object({
  conv_id: ConvIdSchema,
  /** null = 取消置顶。 */
  message_id: MessageIdSchema.nullable(),
  by: UserIdSchema,
});

/** 消息被编辑（协议扩展 §3）。带 seq：编辑是状态，断线重连要能补齐。 */
export const MessageEditData = z.object({
  conv_id: ConvIdSchema,
  message: MessageSchema,
});

/** 表情回应变化（协议扩展 §2）。带 seq：回应是状态，断线重连要能补齐。 */
export const MessageReactionData = z.object({
  conv_id: ConvIdSchema,
  message_id: MessageIdSchema,
  reactions: z.array(ReactionSummarySchema),
});

/** 已读水位变化（协议扩展 §5）。 */
export const ReadUpdateData = z.object({
  conv_id: ConvIdSchema,
  user_id: UserIdSchema,
  last_seq: z.number().int().min(0),
});

/**
 * 工具权限告警（见 docs/TOOL-TIERS.md）。
 *
 * **瞬时事件**（seq=null，不落库、不补发）：权威记录是 `audit_logs` 里那行，
 * 这个只是给管理员一个实时提醒。补发它没有意义 —— 离线的人重连后
 * 到管理页看审计日志就行。
 *
 * 收件人是管理员（默认全部人类管理员，可用 TOOL_ALERT_USER_IDS 指定），
 * 通过 hub 的 forceUserIds 定向推送：不受会话可见性过滤影响，
 * 因为告警关心的往往是"有人被拒了"，而不在那个会话里的人也该知道。
 */
export const ToolAlertData = z.object({
  kind: z.enum(['denied', 'exec']),
  tool: z.string(),
  tier: z.enum(['host-root', 'sandbox', 'none']),
  conv_id: ConvIdSchema,
  conv_kind: z.enum(['group', 'dm']),
  agent_id: UserIdSchema,
  triggered_by: UserIdSchema,
  args_preview: z.string(),
  /** 审计行 id：管理员点进来能对到具体那一条。 */
  audit_id: z.string(),
});

export const EVENTS = {
  'message.new': { data: MessageNewData, seq: true },
  'message.update': { data: MessageUpdateData, seq: false },
  'message.final': { data: MessageFinalData, seq: true },
  'message.revoke': { data: MessageRevokeData, seq: true },
  'member.join': { data: MemberJoinData, seq: true },
  'member.leave': { data: MemberLeaveData, seq: true },
  'member.update': { data: MemberUpdateData, seq: true },
  'group.update': { data: GroupUpdateData, seq: true },
  typing: { data: TypingData, seq: false },
  /**
   * 已读水位变化（协议扩展 §5）。**瞬时事件**（seq=null）：
   * 已读如果每条都写 events 表，一个人翻历史就能产生几百行，
   * 补发日志会被刷爆；重连后靠 `conv.get` 里的成员水位一次性对齐。
   */
  'read.update': { data: ReadUpdateData, seq: false },
  'message.reaction': { data: MessageReactionData, seq: true },
  'message.edit': { data: MessageEditData, seq: true },
  'message.pin': { data: MessagePinData, seq: true },
  poke: { data: PokeData, seq: false },
  'tool.alert': { data: ToolAlertData, seq: false },
} as const;

export type EvtType = keyof typeof EVENTS;
export type EvtData<T extends EvtType> = z.infer<(typeof EVENTS)[T]['data']>;

export const EVT_TYPES = Object.keys(EVENTS) as EvtType[];

/** 需要进 `events` 表、能补发的类型。 */
export const PERSISTED_EVT_TYPES = EVT_TYPES.filter((t) => EVENTS[t].seq);

export function isKnownEvtType(type: string): type is EvtType {
  return Object.hasOwn(EVENTS, type);
}

export function isPersistedEvtType(type: string): type is EvtType {
  return isKnownEvtType(type) && EVENTS[type].seq;
}

export function parseEvtData<T extends EvtType>(
  type: T,
  data: unknown,
): z.ZodSafeParseResult<EvtData<T>> {
  return EVENTS[type].data.safeParse(data) as z.ZodSafeParseResult<EvtData<T>>;
}
