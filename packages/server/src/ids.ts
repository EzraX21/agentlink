import { monotonicFactory } from 'ulid';

/**
 * 带前缀的 ULID（数据模型 §0）：`u_`、`c_`、`m_`、`a_`、`e_`。
 * 用单调工厂保证同一毫秒内生成的 ID 也递增 —— 对消息排序有实际意义。
 */
const ulid = monotonicFactory();

export type IdPrefix = 'u' | 'c' | 'm' | 'a' | 'e' | 't';

export function newId(prefix: IdPrefix): string {
  return `${prefix}_${ulid()}`;
}

export const newUserId = (): string => newId('u');
export const newConvId = (): string => newId('c');
export const newMessageId = (): string => newId('m');
export const newAttachmentId = (): string => newId('a');
export const newEventId = (): string => newId('e');
export const newTokenJti = (): string => newId('t');

export function nowMs(): number {
  return Date.now();
}
