import { validateData, type Handler, type HandlerMap } from './dispatch.js';
import { searchMessages } from '../services/search.js';

/**
 * M8 的 op：search.messages（协议 §5.7）。
 */
export function registerM8Handlers(handlers: HandlerMap): void {
  const searchHandler: Handler = (ctx) => {
    const data = validateData('search.messages', ctx.rawData);
    // 限流：搜索 20 次 / 60 秒（协议 §11）
    ctx.services.limiter.assert(ctx.state.userId, 'search');
    return searchMessages(ctx.db, {
      userId: ctx.state.userId,
      q: data.q,
      convId: data.conv_id,
      fromUserId: data.from_user_id,
      before: data.before,
      after: data.after,
      limit: data.limit,
    });
  };
  handlers.set('search.messages', searchHandler);
}
