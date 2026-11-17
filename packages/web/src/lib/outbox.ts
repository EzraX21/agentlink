/**
 * 离线发件箱（outbox）。
 *
 * 断线时用户仍然可以按发送 —— 消息先落这里，连接恢复后按 `client_msg_id`
 * **原样重发**。
 *
 * 为什么不用改协议：协议 §5.3 的 `client_msg_id` 本来就是幂等键，
 * 服务端遇到重复的 `(sender_id, client_msg_id)` 不报错、直接返回已有消息
 * （M2 验收专门验过）。所以"断线重发 + 恢复后可能重发一次"是安全的：
 * 最多产生一条消息，不会重复。
 *
 * 存在 localStorage：刷新页面后没发出去的消息还在（用户不会以为丢了）。
 */

const KEY = 'agentlink.outbox';
/** 上限：防止长期离线把 localStorage 塞爆。 */
const MAX_ENTRIES = 100;

export interface OutboxEntry {
  /** 本地占位消息 id（用于在列表里标"待发送"）。 */
  readonly localId: string;
  readonly convId: string;
  /** 幂等键，恢复后重发必须原样带上（协议 §5.3）。 */
  readonly clientMsgId: string;
  readonly content: unknown;
  readonly replyTo: string | null;
  readonly createdAt: number;
  /** 已经尝试过几次（仅用于展示/排查，不做退避判断）。 */
  readonly attempts: number;
}

function safeParse(raw: string | null): OutboxEntry[] {
  if (raw === null) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((e): e is OutboxEntry => {
      if (e === null || typeof e !== 'object') return false;
      const x = e as Partial<OutboxEntry>;
      return (
        typeof x.localId === 'string' &&
        typeof x.convId === 'string' &&
        typeof x.clientMsgId === 'string' &&
        typeof x.createdAt === 'number'
      );
    });
  } catch {
    return [];
  }
}

export function loadOutbox(): OutboxEntry[] {
  try {
    return safeParse(localStorage.getItem(KEY));
  } catch {
    return [];
  }
}

function save(entries: OutboxEntry[]): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(entries.slice(-MAX_ENTRIES)));
  } catch {
    /* 隐私模式/配额满：静默失败，不影响在线聊天 */
  }
}

export function enqueueOutbox(entry: OutboxEntry): void {
  const existing = loadOutbox();
  // 同一个 client_msg_id 只留一份（避免重复点发送时排队两条）
  const without = existing.filter((e) => e.clientMsgId !== entry.clientMsgId);
  save([...without, entry]);
}

export function removeFromOutbox(clientMsgId: string): void {
  save(loadOutbox().filter((e) => e.clientMsgId !== clientMsgId));
}

/** 重发前自增尝试次数（失败时保留原条目）。 */
export function bumpAttempts(clientMsgId: string): OutboxEntry | null {
  const entries = loadOutbox();
  const idx = entries.findIndex((e) => e.clientMsgId === clientMsgId);
  if (idx < 0) return null;
  const current = entries[idx];
  if (current === undefined) return null;
  const next: OutboxEntry = { ...current, attempts: current.attempts + 1 };
  entries[idx] = next;
  save(entries);
  return next;
}

export function clearOutbox(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* 忽略 */
  }
}

export function outboxCount(): number {
  return loadOutbox().length;
}