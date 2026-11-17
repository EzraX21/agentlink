import type { Handler, HandlerMap } from './dispatch.js';
import { validateData } from './dispatch.js';
import { requireMembership } from '../permissions.js';
import { findMembership, setLastReadSeq } from '../db/queries.js';

/**
 * `read.set`（协议扩展 §5，见 docs/PROPOSAL-protocol-ext.md §5）。
 *
 * 客户端只报"我读到哪个 seq 了"。服务端**只增不减**：
 * 用户往上翻历史时会上报更小的 seq，若不忽略就会让已读状态倒退
 * （别人的双勾消失、群里显示"未读"增加）。
 *
 * 事件是**瞬时**的（`seq: null`）：已读如果每条都落库，一个人翻历史就能写几百行，
 * 补发日志会被刷爆。重连后靠 `conv.get` 里的成员水位一次性对齐 ——
 * 这也是为什么 `Member.last_read_seq` 是必须的。
 */
export function registerReadHandlers(handlers: HandlerMap): void {
  const readSet: Handler = (ctx) => {
    const data = validateData('read.set', ctx.rawData);
    const userId = ctx.state.userId;
    requireMembership(ctx.db, data.conv_id, userId);

    const current = findMembership(ctx.db, data.conv_id, userId);
    const previous = current?.lastReadSeq ?? 0;
    if (data.last_seq <= previous) {
      // 倒退一律忽略：不是错误，只是"你翻旧消息了"
      return { ok: true as const };
    }
    setLastReadSeq(ctx.db, data.conv_id, userId, data.last_seq);

    ctx.hub.publish({
      type: 'read.update',
      seq: null,
      convId: data.conv_id,
      data: { conv_id: data.conv_id, user_id: userId, last_seq: data.last_seq },
    });

    return { ok: true as const };
  };

  handlers.set('read.set', readSet);
}
