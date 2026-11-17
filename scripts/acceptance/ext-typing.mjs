#!/usr/bin/env node
/**
 * ext-typing 验收：`typing.send`（协议扩展 §1，经用户批准后新增）。
 *
 * 这条 op 填的是协议原有的空白：§6 定义了 `typing` 事件，§5 却没有触发它的 op，
 * 导致 M6 验收第 2 条（"一个窗输入时另一个窗看到 typing"）此前无法实现。
 *
 * 重点验证四件事：
 *   1. 成员上报 → 同会话其他人立刻收到（含发送者昵称）
 *   2. 非成员 → PERM_DENIED（连会话存在性都不该泄露给外人之外的判断）
 *   3. 同一人 2 秒内重复上报 → **静默去重**（不广播，也不报 RATE_LIMITED）
 *   4. 瞬时事件：不写 events 表、不进 resume 补发
 */
import { section, summary, ok, eq, gte, expectOk, expectError } from './_assert.mjs';
import { connectAuthed } from './_client.mjs';
import { openDb } from './_db.mjs';

export const needsServer = true;

export async function run(ctx) {
  const { http, wsUrl } = ctx;

  const reg = async (username, displayName) => {
    const res = await http('POST', '/api/auth/register', {
      body: { username, display_name: displayName, password: 'typing-pass-123' },
    });
    if (res.status !== 201) throw new Error(`注册失败 ${username}: ${res.text}`);
    return res.body;
  };

  const alice = await reg('alice', '爱丽丝');
  const bob = await reg('bob', '小明');
  const carol = await reg('carol', '卡罗');

  // connectAuthed 返回 { client, res }：把 client 取出来当句柄用
  const a = (await connectAuthed(wsUrl, alice.access_token)).client;
  const b = (await connectAuthed(wsUrl, bob.access_token)).client;
  // carol 不是成员：也认证（否则 PERM 会先被 AUTH_REQUIRED 拦掉），但不在群里
  const c = (await connectAuthed(wsUrl, carol.access_token)).client;

  const conv = expectOk(
    await a.request('conv.create', {
      kind: 'group',
      title: '打字测试群',
      member_ids: [bob.user.id],
    }),
    '建群（alice + bob）',
  ).conv;

  section('1. 成员上报 → 同会话其他人收到');
  const t0 = Date.now();
  expectOk(await a.request('typing.send', { conv_id: conv.id }), 'alice 上报打字');
  const evt = await b.nextEvent('typing');
  const latency = Date.now() - t0;
  eq(evt.type, 'typing', 'bob 收到 typing 事件');
  eq(evt.data.conv_id, conv.id, 'conv_id 正确');
  eq(evt.data.user_id, alice.user.id, 'user_id 是 alice');
  eq(evt.data.user.display_name, '爱丽丝', '带昵称，前端可直接显示');
  eq(evt.seq, null, '瞬时事件：seq 为 null（不落库）');
  gte(200 - latency, 0, `推送延迟 ${latency}ms（< 200ms）`);

  section('2. 非成员被拒');
  const denied = await c.request('typing.send', { conv_id: conv.id });
  expectError(denied, 'PERM_DENIED', '非成员上报 → PERM_DENIED');

  section('3. 2 秒内重复上报被静默去重');
  // 先把上一条事件消费掉
  await new Promise((r) => setTimeout(r, 100));
  expectOk(await a.request('typing.send', { conv_id: conv.id }), '第二次上报（去重窗口内）');
  // 去重后不应收到事件：等一下确认没有
  const maybe = await b.drain(800);
  const typingInDrain = maybe.filter((e) => e.type === 'typing');
  eq(typingInDrain.length, 0, '去重窗口内不重复广播');

  // 去重是按 (user, conv) 计的：bob 上报不该被 alice 的去重记录挡掉。
  // 注意先清掉 alice 队列里她自己的那条 typing（广播也会发给发送者本人）。
  await a.drain(200);
  expectOk(await b.request('typing.send', { conv_id: conv.id }), 'bob 上报打字');
  const evt2 = await a.nextEvent('typing');
  eq(evt2.data.user_id, bob.user.id, '去重不会串人：bob 的 typing 正常广播');

  section('4. 瞬时事件不落库、不进补发');
  const raw = openDb(ctx.dbPath);
  const row = raw.prepare("SELECT count(*) AS n FROM events WHERE type = 'typing'").get();
  raw.close();
  eq(row.n, 0, 'events 表里没有 typing（瞬时事件不落库）');

  // 先清空 bob 的实时队列：否则会把"之前收到的实时 typing"误当成补发
  await b.drain(200);
  const resumeRes = expectOk(await b.request('resume', { last_seq: 0 }), 'bob resume');
  const replayed = await b.drain(400);
  eq(
    replayed.filter((e) => e.type === 'typing').length,
    0,
    '补发里没有 typing（历史打字状态没有意义）',
  );
  ok(true, `补发了 ${resumeRes.replayed} 条消息事件（不含 typing）`);

  section('5. 参数校验');
  const bad = await a.request('typing.send', {});
  expectError(bad, 'VALIDATION_FAILED', '缺 conv_id → VALIDATION_FAILED');

  a.close();
  b.close();
  c.close();

  return summary('ext-typing');
}
