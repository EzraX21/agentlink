import { makeEvt, type EvtFrame } from '@agentlink/protocol';
import type { Db } from '../db/index.js';
import {
  deleteAuditOlderThan,
  deleteEventsOlderThan,
  listEventsAfter,
  maxEventSeq,
  minEventSeq,
} from '../db/queries.js';
import type { ClientState, Hub } from '../hub.js';
import { EVENTS_RETENTION_MS, EVENTS_CLEANUP_INTERVAL_MS } from '@agentlink/protocol';
/** 只要求 info 方法，Fastify 的 FastifyBaseLogger 直接满足。 */
export interface InfoLogger {
  info(obj: unknown, msg?: string): void;
}

/**
 * 断线补齐（协议 §4、实现计划 M3）——验收标准第 3 条的唯一实现方式。
 *
 * 要点：
 *   - 按 seq 升序补发 `seq > last_seq` 且该连接**有权接收**的事件
 *   - `gap:true` 当且仅当 last_seq 早于最早保留的事件（events 只留 30 天）
 *   - **seq 有空洞是正常的**：全局计数器下别人会话的事件不会推给你，
 *     客户端不得按连续序列校验，只记录最大值
 *   - 补完再回 res（协议 §4.2 的时序要求）
 */

export interface ResumeResult {
  readonly replayed: number;
  readonly up_to: number;
  readonly gap: boolean;
}

const REPLAY_BATCH = 500;

export function resume(
  db: Db,
  hub: Hub,
  state: ClientState,
  lastSeq: number,
): ResumeResult {
  const upTo = maxEventSeq(db);
  const minSeq = minEventSeq(db);

  // gap 判定（协议 §4.2）：last_seq 早于最早保留的事件 → 中间可能有已被清理的事件，
  // 补发不可能完整，必须让客户端走全量重同步。
  // minSeq === 0（表空）或 lastSeq === 0（全新客户端）时不算 gap：没有"缺口"可谈。
  const gap = minSeq > 0 && lastSeq > 0 && lastSeq < minSeq;

  let replayed = 0;
  let cursor = lastSeq;

  for (;;) {
    const rows = listEventsAfter(db, cursor, REPLAY_BATCH);
    if (rows.length === 0) break;

    for (const row of rows) {
      cursor = row.seq;
      const data = JSON.parse(row.payload) as unknown;
      const mentions = extractMentionsFromPayload(data);
      const input =
        mentions === undefined
          ? { type: row.type, convId: row.convId }
          : { type: row.type, convId: row.convId, mentions };

      // 订阅过滤同样作用于补发（协议 §5.6：过滤在服务端做）
      if (!hub.accepts(state, input)) continue;

      const evt: EvtFrame = makeEvt(row.type, row.seq, row.createdAt, data);
      state.conn.send(evt);
      replayed += 1;
      if (row.seq > state.lastSeq) state.lastSeq = row.seq;
    }

    if (rows.length < REPLAY_BATCH) break;
  }

  // 即使没有补发任何事件，last_seq 也推进到当前水位：
  // 客户端要知道"我已经同步到这个点"（协议 §4.1 只记最大值）。
  if (upTo > state.lastSeq) state.lastSeq = upTo;

  return { replayed, up_to: upTo, gap };
}

/**
 * 从事件 payload 里取 @ 提及。
 * `message.new` 的 payload 是 `{conv_id, message}`；这里只看纯文本里的 `@u_xxx`。
 * 补发路径不重算 @（那需要查成员表），改为在 payload 里带上 `mentions` 字段，
 * 由发送方写入。见 messages.ts 的 publish 调用。
 */
function extractMentionsFromPayload(data: unknown): string[] | undefined {
  if (typeof data !== 'object' || data === null) return undefined;
  const maybe = (data as { mentions?: unknown }).mentions;
  if (Array.isArray(maybe) && maybe.every((x) => typeof x === 'string')) {
    return maybe as string[];
  }
  return undefined;
}

/**
 * 审计日志保留期清理。
 *
 * 与 events 的 30 天分开：安全审计通常要留得更久（合规上常见 180 天～1 年），
 * 而 events 只是补发用的中间数据。`days = 0` 表示**永不删除**（返回空操作），
 * 这是有意的：有些部署要把审计永久保留。
 */
export function startAuditCleanup(db: Db, days: number, logger: InfoLogger): () => void {
  if (days <= 0) return () => {};
  const run = (): void => {
    const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
    const deleted = deleteAuditOlderThan(db, cutoff);
    if (deleted > 0) logger.info({ deleted, days }, '审计日志清理完成');
  };
  // 启动时先跑一次：否则长期运行的进程要等一个周期才清
  run();
  const timer = setInterval(run, 10 * 60 * 1000);
  timer.unref();
  return () => clearInterval(timer);
}

/**
 * 30 天保留的清理任务（数据模型 §6.3）。
 * 每 10 分钟删一次 `created_at < now - 30d` 的行。
 */
export function startEventsCleanup(db: Db, logger: InfoLogger): () => void {
  const run = (): void => {
    const cutoff = Date.now() - EVENTS_RETENTION_MS;
    const deleted = deleteEventsOlderThan(db, cutoff);
    if (deleted > 0) logger.info({ deleted }, 'events 清理完成');
  };

  const timer = setInterval(run, EVENTS_CLEANUP_INTERVAL_MS);
  timer.unref();
  return () => clearInterval(timer);
}
