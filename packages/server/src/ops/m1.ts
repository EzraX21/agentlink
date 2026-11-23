import { AgentLinkError } from '@agentlink/protocol';
import { validateData, type Handler, type HandlerMap } from './dispatch.js';
import {
  createConversation,
  getConversation,
  listConversations,
  updateGroup,
} from '../services/conversations.js';
import { requireRole } from '../permissions.js';
import { appendEvent, findUserById, insertAudit, transaction } from '../db/queries.js';
import { newId, nowMs } from '../ids.js';

/**
 * M1 的 op：auth / ping / subscribe.set / conv.* / group.update。
 * 消息与流式在 M2、M4 追加。
 */
export function registerM1Handlers(handlers: HandlerMap): void {
  const auth: Handler = async (ctx) => {
    const data = validateData('auth', ctx.rawData);
    const identity = await ctx.auth.authenticate(data.token);

    const user = findUserById(ctx.db, identity.userId);
    if (!user) throw new AgentLinkError('AUTH_INVALID', '账号不存在');

    // 一个连接对应一个身份；切换身份必须重连（协议 §2.4）
    ctx.state.userId = user.id;
    ctx.state.kind = user.kind;
    ctx.conn.userId = user.id;
    ctx.conn.authed = true;
    ctx.conn.authKind = user.kind;

    return {
      protocol: 1 as const,
      self: {
        id: user.id,
        kind: user.kind,
        display_name: user.displayName,
        tenant_id: user.tenantId,
        // 工具权限分级的关键输入：agent 要能判断"给我发消息的是不是我的主人/服主"。
        ...(user.kind === 'agent' && user.ownerUserId !== null
          ? { owner_user_id: user.ownerUserId }
          : {}),
        ...(user.kind === 'human' ? { is_admin: user.isAdmin === 1 } : {}),
        ...(ctx.config.hostOwnerId !== null ? { host_owner_id: ctx.config.hostOwnerId } : {}),
      },
      server_time: nowMs(),
    };
  };

  const ping: Handler = () => ({ server_time: nowMs() });

  const subscribeSet: Handler = (ctx) => {
    const data = validateData('subscribe.set', ctx.rawData);
    ctx.hub.setFilters(ctx.conn.id, data.filters);
    return { applied: true as const };
  };

  const convList: Handler = (ctx) => {
    const data = validateData('conv.list', ctx.rawData);
    return listConversations(ctx.db, ctx.state.userId, data.limit ?? 50, data.cursor);
  };

  const convCreate: Handler = (ctx) => {
    const data = validateData('conv.create', ctx.rawData);
    const conv = createConversation(ctx.db, {
      kind: data.kind,
      title: data.title,
      memberIds: data.member_ids,
      creatorId: ctx.state.userId,
    });
    return { conv };
  };

  const convGet: Handler = (ctx) => {
    const data = validateData('conv.get', ctx.rawData);
    return getConversation(ctx.db, data.conv_id, ctx.state.userId);
  };

  const groupUpdate: Handler = (ctx) => {
    const data = validateData('group.update', ctx.rawData);
    requireRole(ctx.db, data.conv_id, ctx.state.userId, 'group.update');

    // 改群名/公告要和事件同一事务：否则可能出现"库里改了但没人收到"或
    // "事件先于数据"的窗口（数据模型 §4 的同一条纪律）。
    const { conv, seq } = transaction(ctx.db, () => {
      const c = updateGroup(ctx.db, data.conv_id, {
        title: data.title,
        announcement: data.announcement,
      });
      // 协议 §6：group.update 带 seq、可补发 —— 别人的客户端靠它看到改名
      const s = appendEvent(ctx.db, {
        tenantId: 'default',
        convId: data.conv_id,
        type: 'group.update',
        payload: JSON.stringify({ conv_id: data.conv_id, conv: c }),
        createdAt: nowMs(),
      });
      return { conv: c, seq: s };
    });

    // 审计只写成功动作（施工守则 §8）
    insertAudit(ctx.db, {
      id: newId('e'),
      tenantId: 'default',
      actorId: ctx.state.userId,
      action: 'group.update',
      targetType: 'group',
      targetId: data.conv_id,
      detail: JSON.stringify({
        ...(data.title === undefined ? {} : { title: data.title }),
        ...(data.announcement === undefined ? {} : { announcement: data.announcement }),
      }),
      createdAt: nowMs(),
    });

    // 推给群里所有人（包括发起者的其它标签页）。必须在事务提交之后推。
    ctx.hub.publish({
      type: 'group.update',
      data: { conv_id: data.conv_id, conv },
      seq,
      convId: data.conv_id,
    });

    return { conv };
  };

  handlers.set('auth', auth);
  handlers.set('ping', ping);
  handlers.set('subscribe.set', subscribeSet);
  handlers.set('conv.list', convList);
  handlers.set('conv.create', convCreate);
  handlers.set('conv.get', convGet);
  handlers.set('group.update', groupUpdate);
}
