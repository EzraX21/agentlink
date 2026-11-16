import { z } from 'zod';
import {
  ConversationSchema,
  ConvIdSchema,
  MemberSchema,
  MessageIdSchema,
  MessageSchema,
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
  poke: { data: PokeData, seq: false },
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
