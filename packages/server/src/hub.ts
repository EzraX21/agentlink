import type { SubscriptionFilters } from '@agentlink/protocol';
import { isPersistedEvtType, makeEvt } from '@agentlink/protocol';
import type { Connection } from './ws/gateway.js';
import type { Db } from './db/index.js';
import { appendEvent, findConversation, listMyConvIds } from './db/queries.js';
import { nowMs } from './ids.js';

/**
 * 事件总线与订阅（协议 §5.6、§6）。
 *
 * 两条铁律：
 *   1. **过滤在服务端做**，不是推给客户端再丢（协议 §5.6）。
 *   2. 需要补发的事件必须带 seq，且 seq 在写消息的同一事务里分配（数据模型 §4）。
 */

export interface ClientState {
  readonly conn: Connection;
  userId: string;
  kind: 'human' | 'agent';
  filters: SubscriptionFilters;
  /** 客户端见过的最大 seq（resume 之后用于诊断）。 */
  lastSeq: number;
}

/** 事件是否 @ 了某人 —— 由调用方在 data 里给。 */
export interface PublishInput {
  readonly type: string;
  readonly data: unknown;
  readonly seq: number | null;
  readonly convId: string | null;
  readonly mentions?: readonly string[];
  /**
   * 即使订阅/可见性判定不通过，也要推给这些用户的连接。
   *
   * 用于"被踢的人自己"：踢人要先把 membership 删掉，删掉之后他就不再
   * 通过可见性检查了，但他的客户端必须收到 member.leave 才知道自己已经出群。
   */
  readonly forceUserIds?: readonly string[];
}

export class Hub {
  private readonly clients = new Map<string, ClientState>();

  constructor(private readonly db: Db) {}

  add(state: ClientState): void {
    this.clients.set(state.conn.id, state);
  }

  remove(connId: string): void {
    this.clients.delete(connId);
  }

  get(connId: string): ClientState | undefined {
    return this.clients.get(connId);
  }

  /** 某用户的全部连接（轮换 token / 停用 agent 时用）。 */
  connectionsOfUser(userId: string): ClientState[] {
    return [...this.clients.values()].filter((c) => c.userId === userId);
  }

  setFilters(connId: string, filters: SubscriptionFilters): void {
    const state = this.clients.get(connId);
    if (!state) return;
    state.filters = filters;
  }

  /**
   * 把一个事件推给所有应收到它的连接。
   * 返回实际推送的连接数（验收脚本用它断言"过滤真的在服务端生效"）。
   */
  publish(input: PublishInput): number {
    const evt = makeEvt(input.type, input.seq, nowMs(), input.data);
    const forced = new Set(input.forceUserIds ?? []);
    let sent = 0;
    for (const state of this.clients.values()) {
      if (!state.conn.authed) continue;
      // 强制收件人跳过订阅过滤（见 forceUserIds 的注释）
      if (!forced.has(state.userId) && !this.accepts(state, input)) continue;
      state.conn.send(evt);
      if (input.seq !== null && input.seq > state.lastSeq) state.lastSeq = input.seq;
      sent += 1;
    }
    return sent;
  }

  /** 单个连接是否接受该事件（补发时也复用这一份判定）。 */
  accepts(
    state: ClientState,
    input: { type: string; convId: string | null; mentions?: readonly string[] },
  ): boolean {
    const f = state.filters;

    if (f.event_types !== undefined && f.event_types.length > 0) {
      if (!f.event_types.includes(input.type)) return false;
    }

    if (input.convId !== null) {
      // 只能收到自己可见会话的事件。这一条优先于 conv_ids 过滤：
      // 客户端就算把没权限的 conv 写进 filters，也收不到。
      const visible = listMyConvIds(this.db, state.userId);
      if (!visible.includes(input.convId)) return false;

      if (f.conv_ids !== undefined && f.conv_ids.length > 0) {
        if (!f.conv_ids.includes(input.convId)) return false;
      }
    }

    if (f.only_mentions === true && input.type === 'message.new') {
      // 私聊**不受** only_mentions 约束：一对一对话里没人会 @ 机器人，
      // 按 @ 过滤等于让 agent 在私聊里永远收不到消息（"个人助理"象限直接失效）。
      // 群聊里仍然只在被 @ 时才推 —— 这是群聊不刷屏的关键。
      const convKind =
        input.convId === null ? null : findConversation(this.db, input.convId)?.kind ?? null;
      if (convKind !== 'dm') {
        const mentions = input.mentions ?? [];
        if (!mentions.includes(state.userId)) return false;
      }
    }

    return true;
  }
}

/**
 * 写事件并返回 seq。**必须在调用方的事务内调用**，
 * 否则会出现"有消息无事件"的窗口（数据模型 §4）。
 */
export function recordEvent(
  db: Db,
  input: {
    tenantId: string;
    convId: string | null;
    type: string;
    data: unknown;
    createdAt?: number;
  },
): number {
  if (!isPersistedEvtType(input.type)) {
    throw new Error(`事件类型 ${input.type} 不落库（瞬时事件不该调用 recordEvent）`);
  }
  return appendEvent(db, {
    tenantId: input.tenantId,
    convId: input.convId,
    type: input.type,
    payload: JSON.stringify(input.data),
    createdAt: input.createdAt ?? nowMs(),
  });
}
