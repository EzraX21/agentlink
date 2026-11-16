import { AgentLinkError } from '@agentlink/protocol';
import { validateData, type Handler, type HandlerMap } from './dispatch.js';
import {
  fetchContext,
  fetchHistory,
  getMessage,
  revokeMessageById,
  sendMessage,
} from '../services/messages.js';

/**
 * M2 的 op：message.send / message.get / message.revoke / history.fetch / context.fetch。
 */
export function registerM2Handlers(handlers: HandlerMap): void {
  const messageSend: Handler = (ctx) => {
    const data = validateData('message.send', ctx.rawData);
    // 限流：30 条 / 60 秒（协议 §11）。超限回 RATE_LIMITED，不静默丢弃。
    ctx.services.limiter.assert(ctx.state.userId, 'message_send');
    const result = sendMessage(ctx.db, {
      convId: data.conv_id,
      senderId: ctx.state.userId,
      clientMsgId: data.client_msg_id,
      content: data.content,
      replyTo: data.reply_to,
    });

    // 幂等命中不重复推事件（否则客户端会看到两条）
    if (!result.duplicate) {
      // mentions 已由 sendMessage 算好并写进事件 payload（供 resume 复用）
      ctx.hub.publish({
        type: 'message.new',
        data: { conv_id: data.conv_id, mentions: result.mentions, message: result.message },
        seq: result.seq,
        convId: data.conv_id,
        mentions: result.mentions,
      });
    }

    return {
      message_id: result.messageId,
      seq: result.seq,
      client_msg_id: result.clientMsgId,
      created_at: result.createdAt,
    };
  };

  const messageGet: Handler = (ctx) => {
    const data = validateData('message.get', ctx.rawData);
    // 流式消息的真值在内存里，见 getMessage 的注释
    return {
      message: getMessage(
        ctx.db,
        data.conv_id,
        data.message_id,
        ctx.state.userId,
        (id) => ctx.services.streams.get(id)?.text,
      ),
    };
  };

  const messageRevoke: Handler = (ctx) => {
    const data = validateData('message.revoke', ctx.rawData);
    const { seq } = revokeMessageById(ctx.db, {
      convId: data.conv_id,
      messageId: data.message_id,
      userId: ctx.state.userId,
    });
    ctx.hub.publish({
      type: 'message.revoke',
      data: { conv_id: data.conv_id, message_id: data.message_id, by: ctx.state.userId },
      seq,
      convId: data.conv_id,
    });
    return { ok: true as const };
  };

  const historyFetch: Handler = (ctx) => {
    const data = validateData('history.fetch', ctx.rawData);
    return fetchHistory(ctx.db, {
      convId: data.conv_id,
      userId: ctx.state.userId,
      beforeSeq: data.before_seq,
      limit: data.limit,
    });
  };

  const contextFetch: Handler = (ctx) => {
    const data = validateData('context.fetch', ctx.rawData);
    return fetchContext(ctx.db, {
      convId: data.conv_id,
      userId: ctx.state.userId,
      anchorSeq: data.anchor_seq,
      before: data.before,
      after: data.after,
      includeQuoted: data.include_quoted,
      maxChars: data.max_chars,
    });
  };

  handlers.set('message.send', messageSend);
  handlers.set('message.get', messageGet);
  handlers.set('message.revoke', messageRevoke);
  handlers.set('history.fetch', historyFetch);
  handlers.set('context.fetch', contextFetch);
}
