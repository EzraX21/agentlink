import type { Handler, HandlerMap } from './dispatch.js';
import { validateData } from './dispatch.js';
import { AgentLinkError, isToolAllowed, toolTierFor, toolsForTier } from '@agentlink/protocol';
import { requireMembership } from '../permissions.js';
import { findConversation, findUserById, insertAudit } from '../db/queries.js';
import { newId, nowMs } from '../ids.js';

/**
 * `agent.tool.request`：工具执行的**前置授权 + 审计**。
 *
 * ## 为什么是前置
 *
 * agent 进程跑在用户机器上，服务端管不到它真的执行了什么。所以让它：
 *   1. 执行**之前**先调本 op
 *   2. 服务端按「会话类型 × 触发者是不是服主」判定层级、落审计
 *   3. 返回 ok → 才允许执行；返回 PERM_DENIED → 必须放弃
 *
 * 这样层级判定的权威在服务端，agent 里的 route() 只是个交互便利
 * （本地算错了也越不过去）。
 *
 * ## 为什么需要 `triggered_by`
 *
 * 是"谁让 agent 干活的"，不是 agent 自己。不给这个字段，agent 声称自己
 * 是干给服主看的就能提权。服务端会校验它是会话成员，再判是不是服主。
 *
 * ## 服务端不认识"服主"这个身份怎么办
 *
 * 服主 = `HOST_OWNER_ID`（显式配置）→ 否则回退到 agent 的 `owner_user_id`
 * （谁建的 agent）。**显式优先**，不能写 `a || b`：那样配了别人之后创建者
 * 仍是服主，权限没真正转移（这条被验收抓到过）。
 */
export function registerToolHandlers(handlers: HandlerMap): void {
  const toolRequest: Handler = (ctx) => {
    // 只有 agent 能申请工具：人类客户端不该走这条路（它有自己的 HTTP 面）
    if (ctx.state.kind !== 'agent') {
      throw new AgentLinkError('PERM_DENIED', '只有 agent 能申请工具执行', {
        action: 'agent.tool.request',
      });
    }

    const data = validateData('agent.tool.request', ctx.rawData);
    const agentId = ctx.state.userId;

    // 1. 会话可见性：agent 必须是成员
    requireMembership(ctx.db, data.conv_id, agentId);

    // 2. 触发者必须也是这个会话的成员 —— 否则就是伪造
    requireMembership(ctx.db, data.conv_id, data.triggered_by);

    const conv = findConversation(ctx.db, data.conv_id);
    if (!conv) throw new AgentLinkError('NOT_FOUND', '会话不存在', { what: 'conv' });

    // 3. 判服主：显式配置优先，没配才回退到创建者
    const agent = findUserById(ctx.db, agentId);
    const hostId = ctx.config.hostOwnerId ?? agent?.ownerUserId ?? null;
    const isHost = hostId !== null && data.triggered_by === hostId;

    // 4. 判层级与工具白名单（分级表在 protocol 包里，服务端与 agent 共用一份）
    const tier = toolTierFor(conv.kind, isHost);
    if (!isToolAllowed(tier, data.tool)) {
      throw new AgentLinkError(
        'PERM_DENIED',
        tier === 'none'
          ? `当前身份没有挂载任何工具（${conv.kind === 'dm' ? '私聊' : '群聊'}里的非服主）`
          : `工具 ${data.tool} 不在 ${tier} 层级里，可用：${toolsForTier(tier).join(' / ')}`,
        {
          action: 'agent.tool',
          tier,
          tool: data.tool,
          conv_kind: conv.kind,
          allowed: [...toolsForTier(tier)],
        },
      );
    }

    // 5. 落审计（授权成功才写；被拒的也可以写，但这里只记成功的执行）
    const auditId = newId('e');
    insertAudit(ctx.db, {
      id: auditId,
      tenantId: 'default',
      actorId: agentId,
      // 动作粒度到工具名：管理页能按 tool.exec / tool.ls 分别筛
      action: `tool.${data.tool}`,
      targetType: 'tool',
      targetId: data.tool,
      detail: JSON.stringify({
        conv_id: data.conv_id,
        conv_kind: conv.kind,
        tier,
        triggered_by: data.triggered_by,
        ...(hostId === null ? {} : { host_id: hostId }),
        args_preview: data.args_preview,
        ...(data.message_id === undefined ? {} : { message_id: data.message_id }),
      }),
      createdAt: nowMs(),
    });

    return { ok: true as const, audit_id: auditId, tier };
  };

  handlers.set('agent.tool.request', toolRequest);
}
