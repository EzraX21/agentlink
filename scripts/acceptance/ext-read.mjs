#!/usr/bin/env node
/**
 * ext-read 验收：已读回执（协议扩展 §5，见 docs/PROPOSAL-protocol-ext.md §5）。
 *
 * 设计要点（都在这条套件里验）：
 *   1. `read.set` 只更新水位，**只增不减**（翻历史不能让已读倒退）
 *   2. 事件 `read.update` 是**瞬时**的（seq=null）—— 已读不写 events 表，
 *      否则一个人翻历史就能刷爆补发日志
 *   3. 重连后靠 `conv.get` 里成员的 `last_read_seq` 对齐，不依赖补发
 *   4. 非成员不能上报
 */
import { section, summary, ok, eq, gte, expectOk, expectError } from './_assert.mjs';
import { connectAuthed, WsClient } from './_client.mjs';
import { openDb } from './_db.mjs';

export const needsServer = true;

export async function run(ctx) {
  const { http, wsUrl } = ctx;

  const reg = async (username, displayName) => {
    const res = await http('POST', '/api/auth/register', {
      body: { username, display_name: displayName, password: 'read-pass-123' },
    });
    if (res.status !== 201) throw new Error(`注册失败: ${res.text}`);
    return res.body;
  };

  const alice = await reg('alice', '爱丽丝');
  const bob = await reg('bob', '小明');
  const carol = await reg('carol', '卡罗');

  const a = (await connectAuthed(wsUrl, alice.access_token)).client;
  const b = (await connectAuthed(wsUrl, bob.access_token)).client;
  const c = (await connectAuthed(wsUrl, carol.access_token)).client;

  const conv = expectOk(
    await a.request('conv.create', {
      kind: 'group',
      title: '已读测试群',
      member_ids: [bob.user.id],
    }),
    '建群（alice + bob）',
  ).conv;

  section('1. 初始水位为 0');
  const before = expectOk(await a.request('conv.get', { conv_id: conv.id }), 'conv.get');
  const bobMember0 = before.members.find((m) => m.user_id === bob.user.id);
  eq(bobMember0?.last_read_seq ?? 0, 0, 'bob 初始 last_read_seq = 0（没读过）');

  section('2. 发三条消息，bob 上报读到 seq=3');
  const seqs = [];
  for (let i = 1; i <= 3; i += 1) {
    const r = expectOk(
      await a.request('message.send', {
        conv_id: conv.id,
        client_msg_id: `read-${i}`,
        content: [{ type: 'text', text: `第 ${i} 条` }],
      }),
      `发第 ${i} 条`,
    );
    seqs.push(r.seq);
  }
  const lastSeq = seqs[seqs.length - 1];
  gte(lastSeq, 3, `三条消息的 seq 递增到 ${lastSeq}`);

  expectOk(await b.request('read.set', { conv_id: conv.id, last_seq: lastSeq }), 'bob 上报已读');

  // alice 收到瞬时的 read.update
  const upd = await a.nextEvent('read.update');
  eq(upd.data.user_id, bob.user.id, 'alice 收到 read.update');
  eq(upd.data.last_seq, lastSeq, '水位值正确');
  eq(upd.seq, null, '已读事件是瞬时的（seq=null，不落库）');

  section('3. conv.get 能读到水位（重连后靠它对齐）');
  const after = expectOk(await a.request('conv.get', { conv_id: conv.id }), 'conv.get');
  const bobMember1 = after.members.find((m) => m.user_id === bob.user.id);
  eq(bobMember1?.last_read_seq, lastSeq, 'bob 的水位已持久化');

  section('4. 只增不减：上报更小的值被忽略');
  expectOk(await b.request('read.set', { conv_id: conv.id, last_seq: 1 }), 'bob 上报更小的 seq');
  const afterBack = expectOk(await a.request('conv.get', { conv_id: conv.id }), 'conv.get');
  eq(
    afterBack.members.find((m) => m.user_id === bob.user.id)?.last_read_seq,
    lastSeq,
    '水位没有倒退（翻历史不会取消已读）',
  );

  section('5. 已读不写 events 表');
  const db = openDb(ctx.dbPath);
  const rows = db.prepare("SELECT count(*) AS n FROM events WHERE type = 'read.update'").get();
  db.close();
  eq(rows.n, 0, 'events 表里没有 read.update');

  section('6. 补发里没有已读事件（靠 conv.get 对齐）');
  const resumeRes = expectOk(await c.request('resume', { last_seq: 0 }), 'carol resume');
  const replayed = await c.drain(300);
  eq(
    replayed.filter((e) => e.type === 'read.update').length,
    0,
    `补发 ${resumeRes.replayed} 条里没有 read.update`,
  );

  section('7. 群聊语义：所有成员都读了才算已读');
  // carol 也上报 → 现在 bob + carol 都读了
  const invited = expectOk(
    await a.request('member.invite', { conv_id: conv.id, user_ids: [carol.user.id] }),
    '把 carol 拉进群',
  );
  // member.invite 只返回**新加入的**成员，不是全体
  eq(invited.members.length, 1, '邀请返回 1 个新成员');
  const three = expectOk(await a.request('conv.get', { conv_id: conv.id }), 'conv.get');
  eq(three.members.length, 3, '群里现在三个人');
  expectOk(await c.request('read.set', { conv_id: conv.id, last_seq: lastSeq }), 'carol 上报已读');
  const full = expectOk(await a.request('conv.get', { conv_id: conv.id }), 'conv.get');
  const watermarks = full.members
    .filter((m) => m.user_id !== alice.user.id)
    .map((m) => m.last_read_seq ?? 0);
  eq(Math.min(...watermarks), lastSeq, '除自己外全员的水位都到了 last_seq（✓✓）');

  section('8. 权限与校验');
  const outsider = await http('POST', '/api/auth/register', {
    body: { username: 'mallory', display_name: '马洛里', password: 'read-pass-123' },
  });
  const outsiderWs = (await connectAuthed(wsUrl, outsider.body.access_token)).client;
  expectError(
    await outsiderWs.request('read.set', { conv_id: conv.id, last_seq: 10 }),
    'PERM_DENIED',
    '非成员上报 → PERM_DENIED',
  );
  outsiderWs.close();
  expectError(
    await a.request('read.set', { conv_id: conv.id, last_seq: -1 }),
    'VALIDATION_FAILED',
    '负数 seq → VALIDATION_FAILED',
  );

  a.close();
  b.close();
  c.close();

  return summary('ext-read');
}
