import { TYPING_THROTTLE_MS } from '@agentlink/protocol';
import { validateData, type Handler, type HandlerMap } from './dispatch.js';
import { requireMembership } from '../permissions.js';
import { findUserById } from '../db/queries.js';

/**
 * `typing.send`（协议扩展，见 docs/PROPOSAL-protocol-ext.md §1）。
 *
 * 协议 §6 早就定义了 `typing` 事件，但 §5 一直没有能触发它的 op ——
 * 这也是 M6 验收第 2 条（"一个窗输入时另一个窗看到 typing"）此前无法实现的原因。
 *
 * 三个刻意的设计：
 *
 * 1. **不落库、不补发**：`typing` 是 `seq: null` 的瞬时事件。补发三分钟前的
 *    "正在输入"毫无意义，还会污染补发日志。
 * 2. **不设状态机**：客户端只上报"我在打字"，没有 start/stop。过期由客户端按
 *    `TYPING_TTL_MS` 处理。少一个状态就少一类"卡在正在输入"的 bug。
 * 3. **服务端自己去重**：同一 (user, conv) 在 `TYPING_THROTTLE_MS` 内重复上报
 *    **静默丢弃**（不报 `RATE_LIMITED`）——打字指示是尽力而为的信号，
 *    给正常打字回一个错误码只会让客户端多写一堆分支。
 */

/** (userId:convId) → 上次广播时间。进程内即可，重启丢失无所谓。 */
const lastBroadcast = new Map<string, number>();

export function resetTypingThrottle(): void {
  lastBroadcast.clear();
}

export function registerTypingHandlers(handlers: HandlerMap): void {
  const typingSend: Handler = (ctx) => {
    const data = validateData('typing.send', ctx.rawData);
    const userId = ctx.state.userId;
    // 必须是该会话成员（协议 §10：非成员连会话存在性都不该知道）
    requireMembership(ctx.db, data.conv_id, userId);

    const key = `${userId}:${data.conv_id}`;
    const now = Date.now();
    const last = lastBroadcast.get(key);
    if (last !== undefined && now - last < TYPING_THROTTLE_MS) {
      // 静默丢弃：重复上报不广播，但也不报错
      return { ok: true as const };
    }
    lastBroadcast.set(key, now);

    const user = findUserById(ctx.db, userId);
    ctx.hub.publish({
      type: 'typing',
      seq: null,
      convId: data.conv_id,
      data: {
        conv_id: data.conv_id,
        user_id: userId,
        ...(user === undefined || user === null
          ? {}
          : {
              user: {
                id: user.id,
                kind: user.kind,
                display_name: user.displayName,
              },
            }),
      },
    });

    return { ok: true as const };
  };

  handlers.set('typing.send', typingSend);
}
