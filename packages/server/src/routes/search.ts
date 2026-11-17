import type { FastifyInstance } from 'fastify';
import { AgentLinkError } from '@agentlink/protocol';
import type { AppServices } from '../services/index.js';
import { searchMessages } from '../services/search.js';
import { requireUser } from './auth.js';
import { sendError } from './errors.js';

/**
 * 检索的 HTTP 入口（协议 §1：控制面 = 登录、历史分页、**搜索**、文件上传、管理）。
 *
 * 协议 §5.7 把 `search.messages` 定义为 WS op；这里再开一个 HTTP GET，
 * 是因为浏览器的搜索框天然是"输入 → 请求 → 渲染列表"，走 HTTP 更简单，
 * 也让 SSR/脚本/curl 好验证。两者共用同一份 `searchMessages` 实现，
 * 权限与过滤规则完全一致（只搜自己可见的会话）。
 */
export async function searchRoutes(app: FastifyInstance, services: AppServices): Promise<void> {
  app.get('/api/search', async (req, reply) => {
    try {
      const who = await requireUser(services, req.headers);
      const q = req.query as {
        q?: string;
        conv_id?: string;
        from_user_id?: string;
        before?: string;
        after?: string;
        limit?: string;
      };

      if (q.q === undefined || q.q.trim() === '') {
        throw new AgentLinkError('VALIDATION_FAILED', '查询串不能为空', {
          issues: [{ path: 'q', message: '不能为空' }],
        });
      }

      // 限流与 WS 侧同一套配额（协议 §11：搜索 20 次 / 60 秒）
      services.limiter.assert(who.userId, 'search');

      const num = (v: string | undefined): number | undefined => {
        if (v === undefined || v === '') return undefined;
        const n = Number(v);
        return Number.isFinite(n) ? n : undefined;
      };

      const result = searchMessages(services.dbc.db, {
        userId: who.userId,
        q: q.q,
        ...(q.conv_id === undefined ? {} : { convId: q.conv_id }),
        ...(q.from_user_id === undefined ? {} : { fromUserId: q.from_user_id }),
        ...(num(q.before) === undefined ? {} : { before: num(q.before) }),
        ...(num(q.after) === undefined ? {} : { after: num(q.after) }),
        ...(num(q.limit) === undefined ? {} : { limit: num(q.limit) }),
      });
      return reply.send(result);
    } catch (err) {
      return sendError(reply, err);
    }
  });
}