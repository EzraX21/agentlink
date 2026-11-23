import type { Handler, HandlerMap } from './dispatch.js';
import { validateData } from './dispatch.js';
import { AgentLinkError, isToolAllowed, toolTierFor, toolsForTier } from '@agentlink/protocol';
import { requireMembership } from '../permissions.js';
import { findConversation, findUserById, insertAudit, listHumanAdmins } from '../db/queries.js';
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
      // 被拒也要留痕！否则"有人反复试探 exec"在系统里完全不可见 ——
      // 这是安全审计最容易漏的一类信号（失败的尝试往往比成功的更重要）。
      const deniedId = recordAudit(ctx, {
        actorId: agentId,
        action: 'tool.denied',
        tool: data.tool,
        targetId: data.tool,
        detail: {
          conv_id: data.conv_id,
          conv_kind: conv.kind,
          tier,
          triggered_by: data.triggered_by,
          args_preview: data.args_preview,
          ...(data.message_id === undefined ? {} : { message_id: data.message_id }),
          allowed: [...toolsForTier(tier)],
        },
      });
      alert(ctx, {
        kind: 'denied',
        tool: data.tool,
        tier,
        convId: data.conv_id,
        convKind: conv.kind,
        agentId,
        triggeredBy: data.triggered_by,
        argsPreview: data.args_preview,
        auditId: deniedId,
      });

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

    // 5. 落审计（授权成功）
    const auditId = recordAudit(ctx, {
      actorId: agentId,
      // 动作粒度到工具名：管理页能按 tool.exec / tool.ls 分别筛
      action: `tool.${data.tool}`,
      tool: data.tool,
      targetId: data.tool,
      detail: {
        conv_id: data.conv_id,
        conv_kind: conv.kind,
        tier,
        triggered_by: data.triggered_by,
        ...(hostId === null ? {} : { host_id: hostId }),
        args_preview: data.args_preview,
        ...(data.message_id === undefined ? {} : { message_id: data.message_id }),
      },
    });

    // 6. 全权限命令立刻告警：这是"服务器可能被改了什么"的唯一实时信号
    if (tier === 'host-root' && data.tool === 'exec') {
      alert(ctx, {
        kind: 'exec',
        tool: data.tool,
        tier,
        convId: data.conv_id,
        convKind: conv.kind,
        agentId,
        triggeredBy: data.triggered_by,
        argsPreview: data.args_preview,
        auditId,
      });
    }

    return { ok: true as const, audit_id: auditId, tier };
  };

  handlers.set('agent.tool.request', toolRequest);
}

/** 写一条审计，返回 id。 */
function recordAudit(
  ctx: Parameters<Handler>[0],
  input: {
    actorId: string;
    action: string;
    tool: string;
    targetId: string;
    detail: Record<string, unknown>;
  },
): string {
  const id = newId('e');
  insertAudit(ctx.db, {
    id,
    tenantId: 'default',
    actorId: input.actorId,
    action: input.action,
    targetType: 'tool',
    targetId: input.targetId,
    detail: JSON.stringify(input.detail),
    createdAt: nowMs(),
  });
  return id;
}

/**
 * 把告警推给收件人（瞬时事件，定向推送）。
 *
 * 收件人：`TOOL_ALERT_USER_IDS` 显式指定；留空则全部人类管理员。
 * 用 hub 的 `forceUserIds` 绕过会话可见性 —— 告警关心的是"有人被拒了"，
 * 不在那个会话里的管理员也该知道。
 */
function alert(
  ctx: Parameters<Handler>[0],
  input: {
    kind: 'denied' | 'exec';
    tool: string;
    tier: 'host-root' | 'sandbox' | 'none';
    convId: string;
    convKind: 'group' | 'dm';
    agentId: string;
    triggeredBy: string;
    argsPreview: string;
    auditId: string;
  },
): void {
  const configured = ctx.config.toolAlertUserIds;
  const recipients =
    configured.length > 0 ? [...configured] : listHumanAdmins(ctx.db).map((u) => u.id);
  if (recipients.length === 0) return;

  ctx.hub.publish({
    type: 'tool.alert',
    seq: null,
    convId: input.convId,
    data: {
      kind: input.kind,
      tool: input.tool,
      tier: input.tier,
      conv_id: input.convId,
      conv_kind: input.convKind,
      agent_id: input.agentId,
      triggered_by: input.triggeredBy,
      args_preview: input.argsPreview,
      audit_id: input.auditId,
    },
    onlyUserIds: recipients,
  });
}
