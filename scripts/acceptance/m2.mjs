#!/usr/bin/env node
/**
 * M2 验收：消息与 seq。
 *
 * 1. A 发消息，B 收到 message.new，seq 比上一条大
 * 2. 同一 client_msg_id 连发两次 → 同一个 message_id 与 seq；表里只有一行
 * 3. history.fetch 分页：造 120 条，limit=50 连翻三页，无重复无遗漏，has_more 最后为 false
 * 4. 非成员发消息 → PERM_DENIED
 * 5. 撤回 → message.revoke 事件到达，history.fetch 不再返回它
 * 6. 一条消息 8001 字符 → VALIDATION_FAILED，details.issues 非空
 * 7. seq 严格单调（并发 200 条无重复无回退）
 */
import { section, summary, ok, eq, gt, gte, includes, expectOk, expectError } from './_assert.mjs';
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

async function connect(wsUrl, token) {
  const c = new WsClient(wsUrl);
  await c.connect();
  const res = await c.request('auth', { token });
  if (!res.ok) throw new Error(`auth 失败: ${JSON.stringify(res.error)}`);
  return c;
}

export async function run(ctx) {
  const { http, wsUrl, dbPath } = ctx;

  const alice = await mkUser(http, 'alice', '爱丽丝');
  const bob = await mkUser(http, 'bob', '小明');
  const carol = await mkUser(http, 'carol', '卡罗');

  const a = await connect(wsUrl, alice.access_token);
  const b = await connect(wsUrl, bob.access_token);

  const conv = expectOk(
    await a.request('conv.create', {
      kind: 'group',
      title: '消息测试群',
      member_ids: [bob.user.id],
    }),
    '建群',
  ).conv;
  const convId = conv.id;

  section('M2.1 消息收发与 seq');
  const m1 = expectOk(
    await a.request('message.send', {
      conv_id: convId,
      client_msg_id: 'cmid-1',
      content: [{ type: 'text', text: '第一条' }],
    }),
    'alice 发第一条',
  );
  ok(typeof m1.seq === 'number' && m1.seq > 0, `返回 seq=${m1.seq}`);
  eq(m1.client_msg_id, 'cmid-1', '回显 client_msg_id');

  const evt1 = await b.nextEvent('message.new');
  eq(evt1.data.message.content[0].text, '第一条', 'bob 收到正确内容');
  eq(evt1.data.message.seq, m1.seq, 'bob 收到的 seq 与发送方一致');
  eq(evt1.data.message.sender.id, alice.user.id, 'sender 正确');
  eq(evt1.data.message.state, 'final', 'state=final');

  const m2 = expectOk(
    await a.request('message.send', {
      conv_id: convId,
      client_msg_id: 'cmid-2',
      content: [{ type: 'text', text: '第二条' }],
    }),
    'alice 发第二条',
  );
  gt(m2.seq, m1.seq, '第二条 seq 比第一条大');

  section('M2.2 client_msg_id 幂等');
  const dupPayload = {
    conv_id: convId,
    client_msg_id: 'cmid-idem',
    content: [{ type: 'text', text: '只应该存一条' }],
  };
  const first = expectOk(await a.request('message.send', dupPayload), '首次发送');
  const second = expectOk(await a.request('message.send', dupPayload), '同 client_msg_id 再发');
  eq(second.message_id, first.message_id, '两次返回同一个 message_id');
  eq(second.seq, first.seq, '两次返回同一个 seq');

  const db = openDb(dbPath);
  const msgCount = count(
    db,
    'SELECT count(*) FROM messages WHERE client_msg_id = ?',
    'cmid-idem',
  );
  eq(msgCount, 1, 'messages 表只有一行');
  const evtCount = count(
    db,
    "SELECT count(*) FROM events WHERE type = 'message.new' AND payload LIKE ?",
    `%${first.message_id}%`,
  );
  eq(evtCount, 1, 'events 表只有一行对应事件');

  const eventsAfterDup = await b.drain(400);
  const dupEvents = eventsAfterDup.filter(
    (e) => e.type === 'message.new' && e.data?.message?.content?.[0]?.text === '只应该存一条',
  );
  eq(dupEvents.length, 1, '幂等重发没有产生第二条 message.new 推送');

  section('M2.3 history.fetch 分页');
  // 造 120 条（并发发送以顺带验证 seq 单调）
  const batch = [];
  for (let i = 0; i < 120; i += 1) {
    batch.push(
      a.request('message.send', {
        conv_id: convId,
        client_msg_id: `bulk-${i}`,
        content: [{ type: 'text', text: `批量消息 ${i}` }],
      }),
    );
  }
  const bulk = await Promise.all(batch);
  const bulkSeqs = bulk.map((r) => r.data?.seq);
  ok(bulk.every((r) => r.ok), '120 条并发发送全部成功');
  eq(new Set(bulkSeqs).size, 120, '120 条 seq 无重复');
  const sorted = [...bulkSeqs].sort((x, y) => x - y);
  eq(JSON.stringify(bulkSeqs), JSON.stringify(sorted), '并发发送的 seq 无回退');

  const seen = new Set();
  let cursor;
  let pages = 0;
  let lastHasMore = true;
  for (;;) {
    const page = expectOk(
      await a.request('history.fetch', {
        conv_id: convId,
        limit: 50,
        ...(cursor === undefined ? {} : { before_seq: cursor }),
      }),
      `history.fetch 第 ${pages + 1} 页`,
    );
    pages += 1;
    for (const m of page.messages) {
      ok(!seen.has(m.id), `第 ${pages} 页无重复消息 ${m.id}`);
      seen.add(m.id);
    }
    lastHasMore = page.has_more;
    if (!page.has_more) break;
    const last = page.messages[page.messages.length - 1];
    cursor = last.seq;
    if (pages > 10) break;
  }
  gte(seen.size, 123, `翻页共取到 ${seen.size} 条（≥123）`);
  eq(lastHasMore, false, '最后一页 has_more=false');
  eq(pages, 3, `limit=50 翻三页（实际 ${pages} 页）`);

  // 无遗漏：与库里终态消息数一致
  const finalCount = count(db, "SELECT count(*) FROM messages WHERE conv_id = ? AND state = 'final'", convId);
  eq(seen.size, finalCount, '翻页结果与库里终态消息数一致（无遗漏）');

  section('M2.4 非成员被拒');
  const c = await connect(wsUrl, carol.access_token);
  const carolSend = await c.request('message.send', {
    conv_id: convId,
    client_msg_id: 'carol-1',
    content: [{ type: 'text', text: '我不是成员' }],
  });
  expectError(carolSend, 'PERM_DENIED', '非成员发消息 → PERM_DENIED');

  section('M2.5 撤回');
  const toRevoke = expectOk(
    await a.request('message.send', {
      conv_id: convId,
      client_msg_id: 'cmid-revoke',
      content: [{ type: 'text', text: '这条会被撤回' }],
    }),
    '发一条待撤回的消息',
  );
  await b.nextEvent('message.new'); // 消费掉推送
  expectOk(
    await a.request('message.revoke', { conv_id: convId, message_id: toRevoke.message_id }),
    '撤回成功',
  );
  const revokeEvt = await b.nextEvent('message.revoke');
  eq(revokeEvt.data.message_id, toRevoke.message_id, 'bob 收到 message.revoke');
  eq(revokeEvt.data.by, alice.user.id, '撤回者正确');
  gt(revokeEvt.seq, 0, '撤回事件带 seq');

  const afterRevoke = expectOk(
    await a.request('history.fetch', { conv_id: convId, limit: 100 }),
    '撤回后 history.fetch',
  );
  ok(
    !afterRevoke.messages.some((m) => m.id === toRevoke.message_id),
    'history.fetch 不再返回已撤回消息',
  );

  const revokeAgain = await a.request('message.revoke', {
    conv_id: convId,
    message_id: toRevoke.message_id,
  });
  expectError(revokeAgain, 'CONFLICT', '重复撤回 → CONFLICT');

  section('M2.6 参数校验');
  const tooLong = 'x'.repeat(8001);
  const longRes = await a.request('message.send', {
    conv_id: convId,
    client_msg_id: 'cmid-long',
    content: [{ type: 'text', text: tooLong }],
  });
  const err = expectError(longRes, 'VALIDATION_FAILED', '8001 字符 → VALIDATION_FAILED');
  ok(Array.isArray(err?.details?.issues) && err.details.issues.length > 0, 'details.issues 非空');

  const tooManyBlocks = await a.request('message.send', {
    conv_id: convId,
    client_msg_id: 'cmid-blocks',
    content: Array.from({ length: 21 }, () => ({ type: 'text', text: 'x' })),
  });
  expectError(tooManyBlocks, 'VALIDATION_FAILED', '21 个块 → VALIDATION_FAILED');

  section('M2.7 seq 严格单调（顺序 200 条）');
  const seqs = [];
  for (let i = 0; i < 200; i += 1) {
    const r = await a.request('message.send', {
      conv_id: convId,
      client_msg_id: `mono-${i}`,
      content: [{ type: 'text', text: `单调 ${i}` }],
    });
    if (!r.ok) throw new Error(`第 ${i} 条失败: ${JSON.stringify(r.error)}`);
    seqs.push(r.data.seq);
  }
  eq(new Set(seqs).size, 200, '200 条 seq 无重复');
  let monotonic = true;
  for (let i = 1; i < seqs.length; i += 1) {
    if (seqs[i] <= seqs[i - 1]) monotonic = false;
  }
  ok(monotonic, '200 条 seq 严格递增');

  const dbSeqGaps = db
    .prepare('SELECT seq FROM events ORDER BY seq')
    .all()
    .map((r) => r.seq);
  ok(dbSeqGaps.length > 200, `events 表有 ${dbSeqGaps.length} 行`);
  ok(
    dbSeqGaps.every((s, i) => i === 0 || s > dbSeqGaps[i - 1]),
    'events.seq 全局严格递增',
  );

  db.close();
  a.close();
  b.close();
  c.close();

  return summary('M2');
}
