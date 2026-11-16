import { validateData, type Handler, type HandlerMap } from './dispatch.js';
import {
  inviteMembers,
  kickMember,
  muteMember,
  poke,
  setMemberRole,
  typing,
} from '../services/members.js';
import type { RateLimiter } from '../services/ratelimit.js';

/**
 * M5 的 op：member.invite / member.kick / member.mute / member.role.set / poke.send。
 * 以及瞬时事件 typing（由 SDK 的 typing 调用触发，此处作为 op 暴露给 WS）。
 *
 * 注意：协议 §5 的 op 清单里没有 `typing.send`。typing 是 evt 而非 op，
 * 客户端通过 `poke.send` 之外的途径触发……规格没有定义触发入口，见 DECISIONS。
 * 这里**不新增 op**（施工守则 §6 要求先问），typing 只在 M6 客户端本地用于
 * 本地回显，服务端不广播。
 */
export function registerM5Handlers(handlers: HandlerMap, limiter: RateLimiter): void {
  const memberInvite: Handler = (ctx) => {
    const data = validateData('member.invite', ctx.rawData);
    const res = inviteMembers(ctx.db, {
      convId: data.conv_id,
      actorId: ctx.state.userId,
      userIds: data.user_ids,
    });
    for (const member of res.members ?? []) {
      ctx.hub.publish({
        type: 'member.join',
        data: { conv_id: data.conv_id, member },
        seq: res.seq,
        convId: data.conv_id,
      });
    }
    return { members: res.members ?? [] };
  };

  const memberKick: Handler = (ctx) => {
    const data = validateData('member.kick', ctx.rawData);
    const res = kickMember(ctx.db, {
      convId: data.conv_id,
      actorId: ctx.state.userId,
      userId: data.user_id,
    });
    ctx.hub.publish({
      type: 'member.leave',
      data: { conv_id: data.conv_id, user_id: data.user_id, reason: 'kicked' },
      seq: res.seq,
      convId: data.conv_id,
    });
    return { ok: true as const };
  };

  const memberMute: Handler = (ctx) => {
    const data = validateData('member.mute', ctx.rawData);
    const res = muteMember(ctx.db, {
      convId: data.conv_id,
      actorId: ctx.state.userId,
      userId: data.user_id,
      untilMs: data.until_ms,
    });
    ctx.hub.publish({
      type: 'member.update',
      data: { conv_id: data.conv_id, member: res.member },
      seq: res.seq,
      convId: data.conv_id,
    });
    return { ok: true as const };
  };

  const memberRoleSet: Handler = (ctx) => {
    const data = validateData('member.role.set', ctx.rawData);
    const res = setMemberRole(ctx.db, {
      convId: data.conv_id,
      actorId: ctx.state.userId,
      userId: data.user_id,
      role: data.role,
    });
    ctx.hub.publish({
      type: 'member.update',
      data: { conv_id: data.conv_id, member: res.member },
      seq: res.seq,
      convId: data.conv_id,
    });
    return { ok: true as const };
  };

  const pokeSend: Handler = (ctx) => {
    const data = validateData('poke.send', ctx.rawData);
    poke(ctx.db, {
      convId: data.conv_id,
      actorId: ctx.state.userId,
      userId: data.user_id,
    });
    // 瞬时事件：seq=null，不落库、不补发（协议 §4.1）
    ctx.hub.publish({
      type: 'poke',
      data: {
        conv_id: data.conv_id,
        from_user_id: ctx.state.userId,
        to_user_id: data.user_id,
      },
      seq: null,
      convId: data.conv_id,
    });
    return { ok: true as const };
  };

  handlers.set('member.invite', memberInvite);
  handlers.set('member.kick', memberKick);
  handlers.set('member.mute', memberMute);
  handlers.set('member.role.set', memberRoleSet);
  handlers.set('poke.send', pokeSend);
}

export { typing };
