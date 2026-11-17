import type { Handler, HandlerMap } from './dispatch.js';
import { validateData } from './dispatch.js';
import { editMessageById } from '../services/messages.js';
import { appendEvent } from '../db/queries.js';
import { nowMs } from '../ids.js';

/**
 * `message.edit`（协议扩展 §3，见 docs/PROPOSAL-protocol-ext.md §3）。
 *
 * 事件 `message.edit` 带 seq（可补发）：编辑是**状态**，重连后必须看到新内容。
 * 全文索引由 0002 的 UPDATE 触发器自动重建；旧词条删除、新词条插入 ——
 * 验收里专门断言"旧关键词搜不到、新关键词能搜到"。
 */
export function registerEditHandlers(handlers: HandlerMap): void {
  const messageEdit: Handler = (ctx) => {
    const data = validateData('message.edit', ctx.rawData);
    const message = editMessageById(ctx.db, {
      convId: data.conv_id,
      messageId: data.message_id,
      userId: ctx.state.userId,
      content: data.content,
    });

    const seq = appendEvent(ctx.db, {
      tenantId: 'default',
      convId: data.conv_id,
      type: 'message.edit',
      payload: JSON.stringify({ conv_id: data.conv_id, message }),
      createdAt: nowMs(),
    });

    ctx.hub.publish({
      type: 'message.edit',
      seq,
      convId: data.conv_id,
      data: { conv_id: data.conv_id, message },
    });

    return { message };
  };

  handlers.set('message.edit', messageEdit);
}
