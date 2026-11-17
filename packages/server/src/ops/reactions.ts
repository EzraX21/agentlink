import type { Handler, HandlerMap } from './dispatch.js';
import { validateData } from './dispatch.js';
import { addReaction, removeReaction } from '../services/reactions.js';
import { appendEvent } from '../db/queries.js';
import { nowMs } from '../ids.js';

/**
 * `reaction.add` / `reaction.remove`（协议扩展 §2）。
 *
 * 事件 `message.reaction` 带 seq（可补发）——回应是**状态**，
 * 断线重连必须能补齐，否则重连后别人看到的表情和你不一样。
 */
export function registerReactionHandlers(handlers: HandlerMap): void {
  const publish = (
    ctx: Parameters<Handler>[0],
    convId: string,
    messageId: string,
    reactions: Array<{ emoji: string; user_ids: string[] }>,
  ): void => {
    // 回应是状态：带 seq 落库，断线重连能补发
    const seq = appendEvent(ctx.db, {
      tenantId: 'default',
      convId,
      type: 'message.reaction',
      payload: JSON.stringify({ conv_id: convId, message_id: messageId, reactions }),
      createdAt: nowMs(),
    });
    ctx.hub.publish({
      type: 'message.reaction',
      seq,
      convId,
      data: { conv_id: convId, message_id: messageId, reactions },
    });
  };

  const reactionAdd: Handler = (ctx) => {
    const data = validateData('reaction.add', ctx.rawData);
    const reactions = addReaction(ctx.db, {
      convId: data.conv_id,
      messageId: data.message_id,
      userId: ctx.state.userId,
      emoji: data.emoji,
    });
    publish(ctx, data.conv_id, data.message_id, reactions);
    return { reactions };
  };

  const reactionRemove: Handler = (ctx) => {
    const data = validateData('reaction.remove', ctx.rawData);
    const reactions = removeReaction(ctx.db, {
      convId: data.conv_id,
      messageId: data.message_id,
      userId: ctx.state.userId,
      emoji: data.emoji,
    });
    publish(ctx, data.conv_id, data.message_id, reactions);
    return { reactions };
  };

  handlers.set('reaction.add', reactionAdd);
  handlers.set('reaction.remove', reactionRemove);
}
