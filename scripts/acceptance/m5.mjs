#!/usr/bin/env node
/**
 * M5 验收：群管理与审计、限流（验收标准第 2 条）。
 *
 * 1. admin 踢人 → 成功，且 audit_logs 新增一行 action='member.kick'
 * 2. member 踢人 → PERM_DENIED，且**没有**审计记录（失败动作不写审计）
 * 3. 禁言中的成员发消息 → PERM_DENIED，details.reason='muted'
 * 4. 60 秒内发 31 条 → 第 31 条 RATE_LIMITED，details.retry_after_ms > 0
 * 5. owner 把 admin 降级 → 该 admin 再踢人 → PERM_DENIED
 * 6. agent 与人类走同一套权限代码（agent 作为 admin 踢人成功并写审计）
 */
import { section, summary, ok, eq, gt, gte, expectOk, expectError } from './_assert.mjs';
import { WsClient } from './_client.mjs';
import { openDb, count } from './_db.mjs';

export const needsServer = true;

async function mkUser(http, username, displayName) {
  const res = await http('POST', '/api/auth/register', {
    body: { username, display_name: displayName, password: 'test-password-123' },
  });
  if (res.status !== 201) throw new Error(`注册 ${username} 失败: ${res.status} ${res.text}`);
  return res.body;
}

async function mkAgent(http, adminToken, username, displayName) {
  const res = await http('POST', '/api/admin/agents', {
    token: adminToken,
    body: { username, display_name: displayName },
  });
  if (res.status !== 201) throw new Error(`建 agent 失败: ${res.status} ${res.text}`);
  return res.body;
}

async function connect(wsUrl, token) {
  const c = new WsClient(wsUrl);
  await c.connect();
  const res = await c.request('auth', { token });
  if (!res.ok) throw new Error(`auth 失败: ${JSON.stringify(res.error)}`);
  return c;
}

export async function run(ctx) {
  const { http, wsUrl, dbPath } = ctx;

  const owner = await mkUser(http, 'owner', '群主');
  const admin = await mkUser(http, 'admin1', '管理员');
  const member = await mkUser(http, 'member1', '普通成员');
  const victim = await mkUser(http, 'victim', '被踢的人');
  // 建 agent 需要**全局管理员**（is_admin，见迁移 0003）。本脚本里第一个注册的
  // owner 才是管理员；admin1 只是群内角色，不是全局管理员。
  const agentAcc = await mkAgent(http, owner.access_token, 'modbot', '管理助手');

  const o = await connect(wsUrl, owner.access_token);
  const ad = await connect(wsUrl, admin.access_token);
  const m = await connect(wsUrl, member.access_token);
  const ag = await connect(wsUrl, agentAcc.token);

  const conv = expectOk(
    await o.request('conv.create', {
      kind: 'group',
      title: '管理测试群',
      member_ids: [admin.user.id, member.user.id, victim.user.id, agentAcc.agent.id],
    }),
    '建群（5 人）',
  ).conv;
  const convId = conv.id;

  // owner 把 admin1 设成 admin，把 agent 也设成 admin（验证同权）
  expectOk(
    await o.request('member.role.set', {
      conv_id: convId,
      user_id: admin.user.id,
      role: 'admin',
    }),
    'owner 提升 admin1 为 admin',
  );
  expectOk(
    await o.request('member.role.set', {
      conv_id: convId,
      user_id: agentAcc.agent.id,
      role: 'admin',
    }),
    'owner 提升 agent 为 admin（同权）',
  );

  const db = openDb(dbPath);
  const auditCount = () => count(db, 'SELECT count(*) FROM audit_logs');
  const auditFor = (action, targetId) =>
    count(
      db,
      'SELECT count(*) FROM audit_logs WHERE action = ? AND target_id = ?',
      action,
      targetId,
    );

  section('M5.1 admin 踢人成功并写审计');
  const beforeKick = auditCount();
  expectOk(
    await ad.request('member.kick', { conv_id: convId, user_id: victim.user.id }),
    'admin 踢人成功',
  );
  eq(auditCount(), beforeKick + 1, '审计日志新增 1 行');
  eq(auditFor('member.kick', victim.user.id), 1, "审计行 action='member.kick' 且 target 正确");

  const leaveEvt = await m.nextEvent('member.leave');
  eq(leaveEvt.data.user_id, victim.user.id, '其他成员收到 member.leave');
  eq(leaveEvt.data.reason, 'kicked', 'reason=kicked');
  gt(leaveEvt.seq, 0, 'member.leave 带 seq');

  const afterKick = expectOk(
    await o.request('conv.get', { conv_id: convId }),
    '踢人后 conv.get',
  );
  eq(afterKick.members.length, 4, '成员数从 5 降到 4');
  ok(
    !afterKick.members.some((x) => x.user_id === victim.user.id),
    '被踢的人不在成员列表里',
  );

  section('M5.2 member 踢人失败且不写审计');
  const beforeFail = auditCount();
  const memberKick = await m.request('member.kick', {
    conv_id: convId,
    user_id: member.user.id,
  });
  expectError(memberKick, 'PERM_DENIED', 'member 踢人 → PERM_DENIED');
  eq(auditCount(), beforeFail, '失败动作没有写审计');

  section('M5.3 禁言中的成员发消息 → PERM_DENIED reason=muted');
  const until = Date.now() + 60_000;
  expectOk(
    await ad.request('member.mute', {
      conv_id: convId,
      user_id: member.user.id,
      until_ms: until,
    }),
    'admin 禁言 member',
  );
  eq(auditFor('member.mute', member.user.id), 1, "审计行 action='member.mute'");

  const mutedSend = await m.request('message.send', {
    conv_id: convId,
    client_msg_id: 'muted-1',
    content: [{ type: 'text', text: '我被禁言了吗' }],
  });
  const mutedErr = expectError(mutedSend, 'PERM_DENIED', '禁言中发消息 → PERM_DENIED');
  eq(mutedErr.details?.reason, 'muted', "details.reason='muted'");

  // 解除禁言后能发
  expectOk(
    await ad.request('member.mute', { conv_id: convId, user_id: member.user.id, until_ms: 0 }),
    '解除禁言',
  );
  expectOk(
    await m.request('message.send', {
      conv_id: convId,
      client_msg_id: 'unmuted-1',
      content: [{ type: 'text', text: '解除后能发了' }],
    }),
    '解除禁言后可以发消息',
  );

  section('M5.4 限流：60 秒内 31 条 → 第 31 条 RATE_LIMITED');
  // owner 的配额是独立的（按 user_id 计），这里用 owner 发
  const sendResults = [];
  for (let i = 0; i < 31; i += 1) {
    const r = await o.request('message.send', {
      conv_id: convId,
      client_msg_id: `rate-${i}`,
      content: [{ type: 'text', text: `限流测试 ${i}` }],
    });
    sendResults.push(r);
  }
  const okCount = sendResults.filter((r) => r.ok).length;
  const limited = sendResults.filter((r) => !r.ok && r.error?.code === 'RATE_LIMITED');
  eq(okCount, 30, `前 30 条成功（实际 ${okCount}）`);
  eq(limited.length, 1, '第 31 条被限流');
  const lastErr = sendResults[sendResults.length - 1];
  eq(lastErr.error?.code, 'RATE_LIMITED', '第 31 条 → RATE_LIMITED');
  gt(lastErr.error?.details?.retry_after_ms ?? 0, 0, 'details.retry_after_ms > 0');

  // 限流不应静默丢弃：被拒的那条确实没入库
  eq(
    count(db, "SELECT count(*) FROM messages WHERE client_msg_id LIKE 'rate-%'"),
    30,
    '被限流的消息没有入库（不是静默丢弃，是明确拒绝）',
  );

  section('M5.5 owner 把 admin 降级 → 该 admin 再踢人 → PERM_DENIED');
  // 清掉队列里更早的 member.update（前面的提升动作），否则会取到旧的那条
  await m.drain(300);
  expectOk(
    await o.request('member.role.set', {
      conv_id: convId,
      user_id: admin.user.id,
      role: 'member',
    }),
    'owner 把 admin1 降级为 member',
  );
  // admin1 之前被提升过一次，所以这里应是 2 行（提升 + 降级）
  eq(auditFor('member.role.set', admin.user.id), 2, "审计行 action='member.role.set' 累计 2 行");
  const updateEvt = await m.nextEvent(
    (e) => e.type === 'member.update' && e.data?.member?.user_id === admin.user.id,
  );
  eq(updateEvt.data.member.user_id, admin.user.id, '收到 admin1 的 member.update');
  eq(updateEvt.data.member.role, 'member', '角色已变为 member');

  const demotedKick = await ad.request('member.kick', {
    conv_id: convId,
    user_id: member.user.id,
  });
  expectError(demotedKick, 'PERM_DENIED', '被降级后踢人 → PERM_DENIED');

  section('M5.6 agent 与人类同权（agent 作为 admin 踢人）');
  // 上一步 admin1 已被降级；agent 仍是 admin（owner 提升的）
  const beforeAgentKick = auditCount();
  expectOk(
    await ag.request('member.kick', { conv_id: convId, user_id: member.user.id }),
    'agent（admin 角色）踢人成功',
  );
  eq(auditCount(), beforeAgentKick + 1, 'agent 的管理动作同样写审计');
  eq(
    auditFor('member.kick', member.user.id),
    1,
    "审计行 action='member.kick'（agent 作为 actor）",
  );
  const actorIsAgent = db
    .prepare(
      "SELECT actor_id FROM audit_logs WHERE action = 'member.kick' AND target_id = ?",
    )
    .get(member.user.id);
  eq(actorIsAgent.actor_id, agentAcc.agent.id, '审计记录的 actor 是 agent');

  section('M5.7 poke 与瞬时事件');
  const pokeRes = expectOk(
    await o.request('poke.send', { conv_id: convId, user_id: admin.user.id }),
    'poke.send 成功',
  );
  eq(pokeRes.ok, true, 'poke 返回 ok');
  const pokeEvt = await ad.nextEvent('poke');
  eq(pokeEvt.data.from_user_id, owner.user.id, 'poke 事件带 from_user_id');
  eq(pokeEvt.seq, null, 'poke 是瞬时事件（seq=null）');
  eq(
    count(db, "SELECT count(*) FROM events WHERE type = 'poke'"),
    0,
    'poke 不写 events 表（瞬时事件不持久化）',
  );

  section('M5.8 群主保护与邀请');
  const kickOwner = await ad.request('member.kick', { conv_id: convId, user_id: owner.user.id });
  expectError(kickOwner, 'PERM_DENIED', 'member 踢群主 → PERM_DENIED');

  const invite = expectOk(
    await o.request('member.invite', { conv_id: convId, user_ids: [victim.user.id] }),
    'owner 重新邀请被踢的人',
  );
  eq(invite.members.length, 1, '返回 1 个新成员');
  eq(invite.members[0].user_id, victim.user.id, '新成员正确');
  const joinEvt = await ad.nextEvent('member.join');
  eq(joinEvt.data.member.user_id, victim.user.id, '收到 member.join');
  eq(auditFor('member.invite', convId), 1, "审计行 action='member.invite'");

  section('M5.9 审计只写成功动作（总校验）');
  const total = auditCount();
  const actions = db.prepare('SELECT action, count(*) AS n FROM audit_logs GROUP BY action').all();
  const byAction = Object.fromEntries(actions.map((r) => [r.action, r.n]));
  eq(byAction['member.kick'], 2, 'member.kick 审计 2 行（admin 一次 + agent 一次）');
  eq(byAction['member.mute'], 2, 'member.mute 审计 2 行（禁言 + 解除）');
  eq(byAction['member.role.set'], 3, 'member.role.set 审计 3 行');
  eq(byAction['member.invite'], 1, 'member.invite 审计 1 行');
  eq(
    total,
    Object.values(byAction).reduce((a, b) => a + b, 0),
    '审计总数与分组一致',
  );
  ok(
    !Object.keys(byAction).some((a) => a.includes('fail')),
    '没有失败动作的审计行',
  );

  db.close();
  o.close();
  ad.close();
  m.close();
  ag.close();

  return summary('M5');
}
