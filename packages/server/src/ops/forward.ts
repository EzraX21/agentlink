import type { Handler, HandlerMap } from './dispatch.js';
import { validateData } from './dispatch.js';
import { AgentLinkError } from '@agentlink/protocol';
import { requireMembership } from '../permissions.js';
import { findMessage, appendEvent } from '../db/queries.js';
import { sendMessage } from '../services/messages.js';
import { newId, nowMs } from '../ids.js';

/**
 * `message.forward`（协议扩展 §6）。
 *
 * 转发 = 把源消息的 `content` 复制成目标会话里的一条新消息。
 * **不新增事件**：它天然就是一次 `message.new`，客户端不需要额外分支。
 *
 * 附件跟着 `attachment_id` 走（内容寻址，天然可跨会话引用）；
 * 下载权限按"引用它的任一消息所在群"判定，所以转发后目标群的成员就能下载 ——
 * 这条语义由 `AttachmentService.#canAccess` 保证，不需要为转发写权限代码。
 */
export function registerForwardHandlers(handlers: HandlerMap): void {
  const forward: Handler = (ctx) => {
    const data = validateData('message.forward', ctx.rawData);
    // 两个会话都必须是成员：否则等于给了"读别人群内容"的旁路
    requireMembership(ctx.db, data.conv_id, ctx.state.userId);
    requireMembership(ctx.db, data.from_conv_id, ctx.state.userId);

    const source = findMessage(ctx.db, data.message_id);
    if (!source || source.convId !== data.from_conv_id) {
      throw new AgentLinkError('NOT_FOUND', '源消息不存在', { what: 'message' });
    }
    if (source.state === 'revoked') {
      throw new AgentLinkError('CONFLICT', '已撤回的消息不能转发');
    }
    if (source.state === 'streaming') {
      throw new AgentLinkError('CONFLICT', '消息还在生成中，不能转发');
    }

    const result = sendMessage(ctx.db, {
      convId: data.conv_id,
      senderId: ctx.state.userId,
      // 每次转发都是一条新消息：用新的幂等键（转发同一个源两次应当产生两条）
      clientMsgId: `fwd_${newId('e')}`,
      content: JSON.parse(source.contentJson) as never,
    });

    ctx.hub.publish({
      type: 'message.new',
      seq: result.seq,
      convId: data.conv_id,
      data: { conv_id: data.conv_id, message: result.message, mentions: result.mentions },
    });

    return {
      message_id: result.messageId,
      seq: result.seq,
      created_at: result.createdAt,
    };
  };

  handlers.set('message.forward', forward);
  // 保留 nowMs/appendEvent 的引用意图说明：转发本身不写额外事件，
  // 消息事件由 sendMessage 内部写（与普通发送完全一致）。
  void nowMs;
  void appendEvent;
}
