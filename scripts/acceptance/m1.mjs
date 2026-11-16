#!/usr/bin/env node
/**
 * M1 验收：认证与会话。
 *
 * 1. 正确口令登录成功，错误口令 → 401
 * 2. WS 发正确 token → 收到 ready，self.kind 正确
 * 3. WS 发错误 token → AUTH_INVALID 且 close(1008)
 * 4. WS 连接后 5 秒不发 auth → 被关闭
 * 5. 用户 A 建群，用户 B 调 conv.list 能看到
 * 6. 非成员调 conv.get → PERM_DENIED
 * 7. 断言 access_token 不出现在服务端访问日志里（扫日志文件内容）
 * 8. refresh 轮换：旧 token 立即失效
 */
import { section, summary, ok, eq, includes, expectOk, expectError } from './_assert.mjs';
import { WsClient } from './_client.mjs';

export const needsServer = true;

export async function run(ctx) {
  const { http, wsUrl, serverLogs } = ctx;

  section('M1.1 口令登录');
  const reg = await http('POST', '/api/auth/register', {
    body: { username: 'alice', display_name: '爱丽丝', password: 'correct-horse-battery' },
  });
  eq(reg.status, 201, '注册 alice 返回 201');
  const aliceTokens = reg.body;

  const badLogin = await http('POST', '/api/auth/login', {
    body: { username: 'alice', password: 'wrong-password' },
  });
  eq(badLogin.status, 401, '错误口令 → 401');
  eq(badLogin.body?.error?.code, 'AUTH_INVALID', '错误口令 → AUTH_INVALID');

  const login = await http('POST', '/api/auth/login', {
    body: { username: 'alice', password: 'correct-horse-battery' },
  });
  eq(login.status, 200, '正确口令登录成功');
  ok(typeof login.body?.access_token === 'string', '返回 access_token');
  ok(typeof login.body?.refresh_token === 'string', '返回 refresh_token');

  const me = await http('GET', '/api/auth/me', { token: login.body.access_token });
  eq(me.status, 200, 'Bearer token 可访问 /api/auth/me');
  eq(me.body?.user?.display_name, '爱丽丝', 'me 返回正确昵称');

  section('M1.2 refresh 轮换');
  const r1 = await http('POST', '/api/auth/refresh', {
    body: { refresh_token: login.body.refresh_token },
  });
  eq(r1.status, 200, '首次 refresh 成功');
  ok(r1.body?.refresh_token !== login.body.refresh_token, 'refresh token 已轮换');

  const r2 = await http('POST', '/api/auth/refresh', {
    body: { refresh_token: login.body.refresh_token },
  });
  eq(r2.status, 401, '旧 refresh token 立即失效 → 401');

  section('M1.3 WS 认证成功');
  const bobReg = await http('POST', '/api/auth/register', {
    body: { username: 'bob', display_name: '小明', password: 'another-strong-pass' },
  });
  eq(bobReg.status, 201, '注册 bob');
  const bobToken = bobReg.body.access_token;

  const alice = new WsClient(wsUrl);
  await alice.connect();
  const authRes = await alice.request('auth', { token: r1.body.access_token });
  const self = expectOk(authRes, 'auth 成功');
  eq(self?.protocol, 1, 'protocol = 1');
  eq(self?.self?.kind, 'human', 'self.kind = human');
  eq(self?.self?.display_name, '爱丽丝', 'self.display_name 正确');
  ok(typeof self?.server_time === 'number', 'server_time 是数字');

  section('M1.4 WS 认证失败 → AUTH_INVALID + close(1008)');
  const bad = new WsClient(wsUrl);
  await bad.connect();
  const badRes = await bad.request('auth', { token: 'not-a-real-token' });
  expectError(badRes, 'AUTH_INVALID', '错误 token → AUTH_INVALID');
  const closed = await bad.waitClose(5000);
  eq(closed.code, 1008, '错误 token 后 close code 1008');

  section('M1.5 5 秒不认证被关闭');
  const silent = new WsClient(wsUrl);
  await silent.connect();
  const t0 = Date.now();
  const silentClosed = await silent.waitClose(8000);
  const elapsed = Date.now() - t0;
  eq(silentClosed.code, 1008, '不发 auth → close 1008');
  ok(elapsed >= 4000 && elapsed <= 7000, `关闭发生在 5 秒附近（实测 ${elapsed}ms）`);

  section('M1.6 建群与可见性');
  const createRes = await alice.request('conv.create', {
    kind: 'group',
    title: '测试群',
    member_ids: [bobReg.body.user.id],
  });
  const created = expectOk(createRes, 'alice 建群成功');
  const convId = created?.conv?.id;
  ok(typeof convId === 'string' && convId.startsWith('c_'), 'conv.id 形如 c_<ULID>');
  eq(created?.conv?.title, '测试群', '群名正确');
  eq(created?.conv?.member_count, 2, '成员数 2');

  const bob = new WsClient(wsUrl);
  await bob.connect();
  expectOk(await bob.request('auth', { token: bobToken }), 'bob 认证成功');

  const bobList = expectOk(await bob.request('conv.list', {}), 'bob 调 conv.list');
  const bobConvIds = (bobList?.items ?? []).map((c) => c.id);
  ok(bobConvIds.includes(convId), 'bob 能看到 alice 建的群');

  const bobGet = expectOk(await bob.request('conv.get', { conv_id: convId }), 'bob 调 conv.get');
  eq(bobGet?.members?.length, 2, 'conv.get 返回 2 个成员');
  const roles = Object.fromEntries((bobGet?.members ?? []).map((m) => [m.user_id, m.role]));
  eq(roles[bobReg.body.user.id], 'member', 'bob 是 member');
  eq(roles[reg.body.user.id], 'owner', 'alice 是 owner');

  section('M1.7 非成员被拒');
  const carolReg = await http('POST', '/api/auth/register', {
    body: { username: 'carol', display_name: '卡罗', password: 'yet-another-pass' },
  });
  const carol = new WsClient(wsUrl);
  await carol.connect();
  expectOk(await carol.request('auth', { token: carolReg.body.access_token }), 'carol 认证');
  const carolGet = await carol.request('conv.get', { conv_id: convId });
  expectError(carolGet, 'PERM_DENIED', '非成员 conv.get → PERM_DENIED');

  const carolList = expectOk(await carol.request('conv.list', {}), 'carol 调 conv.list');
  eq((carolList?.items ?? []).length, 0, 'carol 的会话列表为空');

  section('M1.8 subscribe.set 与 ping');
  const sub = expectOk(
    await bob.request('subscribe.set', {
      filters: { conv_ids: [convId], event_types: ['message.new'], only_mentions: false },
    }),
    'subscribe.set 成功',
  );
  eq(sub?.applied, true, 'applied = true');
  const pong = expectOk(await bob.request('ping', {}), 'ping 成功');
  ok(typeof pong?.server_time === 'number', 'ping 返回 server_time');

  section('M1.9 group.update 与审计');
  const upd = expectOk(
    await alice.request('group.update', { conv_id: convId, title: '改名后的群' }),
    'owner 改群名成功',
  );
  eq(upd?.conv?.title, '改名后的群', '群名已更新');
  const bobUpd = await bob.request('group.update', { conv_id: convId, title: 'bob 想改名' });
  expectError(bobUpd, 'PERM_DENIED', 'member 改群名 → PERM_DENIED');

  section('M1.10 agent 建号与 token');
  const agentRes = await http('POST', '/api/admin/agents', {
    token: r1.body.access_token,
    body: { username: 'helper', display_name: '助手', model: 'test-model' },
  });
  eq(agentRes.status, 201, '管理员建 agent → 201');
  ok(typeof agentRes.body?.token === 'string', 'agent token 只此一次返回');
  ok(agentRes.body.token.startsWith('ag_'), 'agent token 形如 ag_...');

  const agentWs = new WsClient(wsUrl);
  await agentWs.connect();
  const agentAuth = expectOk(
    await agentWs.request('auth', { token: agentRes.body.token }),
    'agent 用 token 认证成功',
  );
  eq(agentAuth?.self?.kind, 'agent', 'self.kind = agent');

  const rotate = await http('POST', `/api/admin/agents/${agentRes.body.agent.id}/rotate-token`, {
    token: r1.body.access_token,
  });
  eq(rotate.status, 200, '轮换 agent token → 200');
  ok(rotate.body?.token !== agentRes.body.token, '新 token 与旧不同');
  const rotatedClosed = await agentWs.waitClose(5000);
  eq(rotatedClosed.code, 1008, '轮换后旧 agent 连接被断开');

  section('M1.11 token 不进访问日志');
  alice.close();
  bob.close();
  carol.close();
  await new Promise((r) => setTimeout(r, 300));
  const logs = serverLogs();
  ok(!logs.includes(r1.body.access_token), 'access_token 不出现在服务端日志里');
  ok(!logs.includes(bobToken), 'bob 的 access_token 不出现在日志里');
  ok(!logs.includes('Bearer '), '日志里没有 Bearer 头内容');
  ok(logs.includes('/api/auth/login'), '访问日志确实记录了请求（证明扫描有效）');

  return summary('M1');
}
