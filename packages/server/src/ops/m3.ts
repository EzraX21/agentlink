import { validateData, type Handler, type HandlerMap } from './dispatch.js';
import { resume } from '../services/resume.js';

/**
 * M3 的 op：resume（断线补齐，协议 §4.2）。
 */
export function registerM3Handlers(handlers: HandlerMap): void {
  const resumeHandler: Handler = (ctx) => {
    const data = validateData('resume', ctx.rawData);
    return resume(ctx.db, ctx.hub, ctx.state, data.last_seq);
  };
  handlers.set('resume', resumeHandler);
}
