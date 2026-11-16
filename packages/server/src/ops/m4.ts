import { AgentLinkError, RATE_LIMITS } from '@agentlink/protocol';
import { validateData, type Handler, type HandlerMap } from './dispatch.js';
import type { StreamRegistry } from '../services/stream.js';
import { findMessage, findUserById, listMemberCandidates } from '../db/queries.js';
import { extractMentions } from '../services/messages.js';
import type { StreamHooks } from '../services/stream.js';

/**
 * M4 的 op：stream.begin / stream.delta / stream.commit / stream.abort / stream.interrupt。
 * evt：message.update（seq=null）、message.final。
 */
export function registerM4Handlers(handlers: HandlerMap, streams: StreamRegistry): void {
  const streamBegin: Handler = (ctx) => {
    const data = validateData('stream.begin', ctx.rawData);
    const res = streams.begin({
      convId: data.conv_id,
      senderId: ctx.state.userId,
      clientMsgId: data.client_msg_id,
      replyTo: data.reply_to,
    });

    // 协议 §8.1：先推 message.new（state=streaming, content=[]），再回 res
    if (res.rev === 0 && res.message.content.length === 0) {
      const members = listMemberCandidates(ctx.db, data.conv_id);
      const mentions: string[] = [];
      ctx.hub.publish({
        type: 'message.new',
        data: { conv_id: data.conv_id, mentions, message: res.message },
        seq: null,
        convId: data.conv_id,
      });
    }

    return { message_id: res.messageId, conv_id: res.convId, rev: res.rev };
  };

  const streamDelta: Handler = (ctx) => {
    const data = validateData('stream.delta', ctx.rawData);
    streams.appendDelta({
      convId: data.conv_id,
      messageId: data.message_id,
      senderId: ctx.state.userId,
      delta: data.delta,
    });
    return { ok: true as const };
  };

  const streamCommit: Handler = (ctx) => {
    const data = validateData('stream.commit', ctx.rawData);
    const message = streams.commit({
      convId: data.conv_id,
      messageId: data.message_id,
      senderId: ctx.state.userId,
    });
    return { message };
  };

  const streamAbort: Handler = (ctx) => {
    const data = validateData('stream.abort', ctx.rawData);
    const message = streams.abort({
      convId: data.conv_id,
      messageId: data.message_id,
      senderId: ctx.state.userId,
      reason: data.reason,
    });
    if (message === null) {
      // 空内容被删除：返回最后状态的一条空消息视图，避免 res.data.message 缺失
      throw new AgentLinkError('CONFLICT', '流式内容为空，消息已删除');
    }
    return { message };
  };

  const streamInterrupt: Handler = (ctx) => {
    const data = validateData('stream.interrupt', ctx.rawData);
    return streams.interrupt({
      convId: data.conv_id,
      messageId: data.message_id,
      byUserId: ctx.state.userId,
    });
  };

  handlers.set('stream.begin', streamBegin);
  handlers.set('stream.delta', streamDelta);
  handlers.set('stream.commit', streamCommit);
  handlers.set('stream.abort', streamAbort);
  handlers.set('stream.interrupt', streamInterrupt);
}

/** 流式事件推给 hub 的钩子（由 app.ts 装配）。 */
export function makeStreamHooks(
  hub: { publish: (input: {
    type: string;
    data: unknown;
    seq: number | null;
    convId: string | null;
    mentions?: readonly string[];
  }) => number },
  notifyGenerator: (messageId: string) => void,
): StreamHooks {
  return {
    onUpdate(convId, messageId, rev, delta) {
      // message.update 的 seq 恒为 null：不落库、不补发（协议 §8.3）
      hub.publish({
        type: 'message.update',
        data: { conv_id: convId, message_id: messageId, rev, delta },
        seq: null,
        convId,
      });
    },
    onFinal(convId, message, seq) {
      hub.publish({
        type: 'message.final',
        data: { conv_id: convId, message },
        seq,
        convId,
      });
    },
    onDeleted(convId, messageId, seq, by) {
      hub.publish({
        type: 'message.revoke',
        data: { conv_id: convId, message_id: messageId, by },
        seq,
        convId,
      });
    },
    onInterrupted(_convId, messageId) {
      notifyGenerator(messageId);
    },
  };
}
