import type { Handler, HandlerMap } from './dispatch.js';
import { validateData } from './dispatch.js';
import { AgentLinkError } from '@agentlink/protocol';
import { requireRole } from '../permissions.js';
import { getConversation } from '../services/conversations.js';
import { findMessage } from '../db/queries.js';
import { setPinnedMessage } from '../db/queries.js';
import { appendEvent } from '../db/queries.js';
import { nowMs } from '../ids.js';

/**
 * `message.pin` / `message.unpin`（协议扩展 §4）。
 *
 * v1 只做**单条置顶**（TG 桌面版默认行为）。权限与群名/公告同档（owner/admin）——
 * 置顶是"所有人都会看到"的内容，不该由普通成员决定。
 *
 * 事件 `message.pin` 带 seq（可补发）：置顶是会话状态，重连后横幅要还在。
 */
export function registerPinHandlers(handlers: HandlerMap): void {
  const publish = (
    ctx: Parameters<Handler>[0],
    convId: string,
    messageId: string | null,
  ): void => {
    const seq = appendEvent(ctx.db, {
      tenantId: 'default',
      convId,
      type: 'message.pin',
      payload: JSON.stringify({ conv_id: convId, message_id: messageId, by: ctx.state.userId }),
      createdAt: nowMs(),
    });
    ctx.hub.publish({
      type: 'message.pin',
      seq,
      convId,
      data: { conv_id: convId, message_id: messageId, by: ctx.state.userId },
    });
  };

  const pin: Handler = (ctx) => {
    const data = validateData('message.pin', ctx.rawData);
    requireRole(ctx.db, data.conv_id, ctx.state.userId, 'message.pin');

    const row = findMessage(ctx.db, data.message_id);
    if (!row || row.convId !== data.conv_id) {
      throw new AgentLinkError('NOT_FOUND', '消息不存在', { what: 'message' });
    }
    if (row.state === 'revoked') {
      throw new AgentLinkError('CONFLICT', '已撤回的消息不能置顶');
    }

    setPinnedMessage(ctx.db, data.conv_id, data.message_id);
    publish(ctx, data.conv_id, data.message_id);
    return { conv: getConversation(ctx.db, data.conv_id, ctx.state.userId).conv };
  };

  const unpin: Handler = (ctx) => {
    const data = validateData('message.unpin', ctx.rawData);
    requireRole(ctx.db, data.conv_id, ctx.state.userId, 'message.pin');
    setPinnedMessage(ctx.db, data.conv_id, null);
    publish(ctx, data.conv_id, null);
    return { conv: getConversation(ctx.db, data.conv_id, ctx.state.userId).conv };
  };

  handlers.set('message.pin', pin);
  handlers.set('message.unpin', unpin);
}
