#!/usr/bin/env node
/**
 * M8 验收：检索（验收标准第 4 条）。
 *
 * 1. 关键词命中，excerpt 内含 `<mark>`
 * 2. 关键词 + 时间范围 + 发送者三者组合，结果正确
 * 3. 撤回的消息不出现在结果里
 * 4. 1 万条消息，查询 < 500ms（console.time 实测）
 * 5. 只能搜到自己可见的会话（跨群越权 → 不返回 / PERM_DENIED）
 * 6. 中文子串查询（unicode61 的已知短板，见 docs/DECISIONS.md）
 */
import { section, summary, ok, eq, gt, lt, gte, includes, expectOk, expectError } from './_assert.mjs';
import { WsClient } from './_client.mjs';
import { openDb } from './_db.mjs';

export const needsServer = true;
/** 本里程碑要造大量消息，放宽测试环境的限流（见 run.mjs 注释）。 */
export const relaxedRateLimit = true;

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
  const { http, wsUrl } = ctx;

  const alice = await mkUser(http, 'alice', '爱丽丝');
  const bob = await mkUser(http, 'bob', '小明');
  const carol = await mkUser(http, 'carol', '卡罗');

  const a = await connect(wsUrl, alice.access_token);
  const b = await connect(wsUrl, bob.access_token);

  const conv = expectOk(
    await a.request('conv.create', { kind: 'group', title: '检索测试群', member_ids: [bob.user.id] }),
    '建群',
  ).conv;

  section('M8.1 关键词命中，excerpt 含 <mark>');
  const t0 = Date.now();
  expectOk(
    await a.request('message.send', {
      conv_id: conv.id,
      client_msg_id: 's-1',
      content: [{ type: 'text', text: '周报什么时候交？记得带附件。' }],
    }),
    'alice 发含关键词的消息',
  );
  await new Promise((r) => setTimeout(r, 50));
  const tMid = Date.now();

  expectOk(
    await b.request('message.send', {
      conv_id: conv.id,
      client_msg_id: 's-2',
      content: [{ type: 'text', text: '这周五交周报，已经在写了。' }],
    }),
    'bob 也发一条含关键词的',
  );
  await new Promise((r) => setTimeout(r, 50));
  const tAfter = Date.now();

  const r1 = expectOk(await a.request('search.messages', { q: '周报' }), '搜「周报」');
  gte(r1.hits.length, 2, `命中 ${r1.hits.length} 条`);
  ok(
    r1.hits.every((h) => h.excerpt.includes('<mark>')),
    '每条 excerpt 都含 <mark>',
  );
  ok(
    r1.hits.some((h) => h.excerpt.includes('<mark>周报</mark>')),
    'excerpt 里高亮的是「周报」本身',
  );

  section('M8.2 关键词 + 时间范围 + 发送者组合');
  const onlyAlice = expectOk(
    await a.request('search.messages', { q: '周报', from_user_id: alice.user.id }),
    '限定发送者 alice',
  );
  eq(onlyAlice.hits.length, 1, '只命中 alice 那 1 条');
  eq(onlyAlice.hits[0].sender_id, alice.user.id, 'sender_id 正确');

  const onlyBob = expectOk(
    await a.request('search.messages', { q: '周报', from_user_id: bob.user.id }),
    '限定发送者 bob',
  );
  eq(onlyBob.hits.length, 1, '只命中 bob 那 1 条');
  eq(onlyBob.hits[0].sender_id, bob.user.id, 'sender_id 正确');

  // 时间范围：只要 bob 之后发出的（即 bob 那条）
  const afterMid = expectOk(
    await a.request('search.messages', { q: '周报', after: tMid }),
    '限定 after=第一条之后',
  );
  eq(afterMid.hits.length, 1, 'after 过滤后只剩 1 条');
  eq(afterMid.hits[0].sender_id, bob.user.id, '剩下的正是后面那条');

  const beforeMid = expectOk(
    await a.request('search.messages', { q: '周报', before: tMid }),
    '限定 before=第一条之后',
  );
  eq(beforeMid.hits.length, 1, 'before 过滤后只剩 1 条');
  eq(beforeMid.hits[0].sender_id, alice.user.id, '剩下的正是前面那条');

  // 三者组合
  const combo = expectOk(
    await a.request('search.messages', {
      q: '周报',
      conv_id: conv.id,
      from_user_id: bob.user.id,
      after: tMid,
      before: tAfter + 60_000,
    }),
    '关键词 + 群 + 发送者 + 时间范围',
  );
  eq(combo.hits.length, 1, '三者组合精确命中 1 条');
  eq(combo.hits[0].sender_id, bob.user.id, '发送者正确');
  eq(combo.hits[0].conv_id, conv.id, '会话正确');

  section('M8.3 撤回的消息不出现在结果里');
  const toRevoke = expectOk(
    await a.request('message.send', {
      conv_id: conv.id,
      client_msg_id: 's-rev',
      content: [{ type: 'text', text: '周报这条会被撤回' }],
    }),
    '发一条待撤回的（也含关键词）',
  );
  await new Promise((r) => setTimeout(r, 50));
  const beforeRevoke = expectOk(await a.request('search.messages', { q: '周报' }), '撤回前搜');
  gte(beforeRevoke.hits.length, 3, `撤回前命中 ${beforeRevoke.hits.length} 条`);

  expectOk(
    await a.request('message.revoke', { conv_id: conv.id, message_id: toRevoke.message_id }),
    '撤回它',
  );
  await new Promise((r) => setTimeout(r, 50));
  const afterRevoke = expectOk(await a.request('search.messages', { q: '周报' }), '撤回后搜');
  eq(
    afterRevoke.hits.length,
    beforeRevoke.hits.length - 1,
    '撤回后少 1 条',
  );
  ok(
    !afterRevoke.hits.some((h) => h.message_id === toRevoke.message_id),
    '被撤回的消息不在结果里',
  );
  ok(
    !afterRevoke.hits.some((h) => h.excerpt.includes('会被撤回')),
    '结果里也没有它的正文片段',
  );

  section('M8.4 可见性：搜不到别人的群');
  const carolConv = expectOk(
    await (await connect(wsUrl, carol.access_token)).request('conv.create', {
      kind: 'group',
      title: '卡罗的私密群',
    }),
    'carol 建自己的群',
  ).conv;
  const carolClient = await connect(wsUrl, carol.access_token);
  expectOk(
    await carolClient.request('message.send', {
      conv_id: carolConv.id,
      client_msg_id: 'c-1',
      content: [{ type: 'text', text: '周报是卡罗的秘密' }],
    }),
    'carol 在自己群里发同样关键词',
  );
  await new Promise((r) => setTimeout(r, 50));

  const aliceSearch = expectOk(await a.request('search.messages', { q: '周报' }), 'alice 再搜');
  ok(
    !aliceSearch.hits.some((h) => h.conv_id === carolConv.id),
    'alice 搜不到 carol 群里的消息',
  );

  const forbidden = await a.request('search.messages', { q: '周报', conv_id: carolConv.id });
  expectError(forbidden, 'PERM_DENIED', '显式搜别人的群 → PERM_DENIED');

  section('M8.5 中文子串与拉丁词');
  // unicode61 把整段中文当一个 token，子串查询靠 instr 路径兜住（见 DECISIONS）
  const sub = expectOk(await a.request('search.messages', { q: '记得带附件' }), '中文子串查询');
  gte(sub.hits.length, 1, '中文子串能查到');
  ok(sub.hits[0].excerpt.includes('<mark>'), '中文子串的 excerpt 也有高亮');

  expectOk(
    await a.request('message.send', {
      conv_id: conv.id,
      client_msg_id: 's-en',
      content: [{ type: 'text', text: 'the deploy script is ready' }],
    }),
    '发一条英文消息',
  );
  await new Promise((r) => setTimeout(r, 50));
  const en = expectOk(await a.request('search.messages', { q: 'deploy' }), '英文词查询');
  gte(en.hits.length, 1, '英文词能查到（走 FTS5）');
  ok(en.hits[0].excerpt.includes('<mark>deploy</mark>'), '英文词高亮正确');

  section('M8.6 1 万条消息，查询 < 500ms');
  // 规模测试要的是**查询**耗时，不是发送吞吐。走 WS 会先撞 30 条/60 秒的限流
  // （M5 已单独验证限流），所以这里直接往库里灌数据，走的是同一套表与 FTS 触发器。
  const bulkStart = Date.now();
  const db = openDb(ctx.dbPath);
  const insert = db.prepare(
    `INSERT INTO messages (id, tenant_id, conv_id, sender_id, seq, client_msg_id,
       content_json, text_plain, reply_to, state, interrupted, created_at, finalized_at)
     VALUES (?, 'default', ?, ?, ?, ?, ?, ?, NULL, 'final', 0, ?, ?)`,
  );
  const insertEvent = db.prepare(
    `INSERT INTO events (tenant_id, conv_id, type, payload, created_at) VALUES ('default', ?, ?, ?, ?)`,
  );
  const seedCount = 10_000;
  const baseSeq = 10_000;
  const seedAll = db.transaction(() => {
    for (let i = 0; i < seedCount; i += 1) {
      const id = `m_SEED${String(i).padStart(20, '0')}`;
      const text = `批量消息 ${i} 内容 filler 文本`;
      const ts = Date.now() + i;
      insert.run(
        id,
        conv.id,
        alice.user.id,
        baseSeq + i,
        `seed-${i}`,
        JSON.stringify([{ type: 'text', text }]),
        text,
        ts,
        ts,
      );
      insertEvent.run(
        conv.id,
        'message.new',
        JSON.stringify({ conv_id: conv.id, mentions: [], message: { id, content: [{ type: 'text', text }] } }),
        ts,
      );
    }
  });
  seedAll();
  const bulkMs = Date.now() - bulkStart;
  const seeded = db.prepare('SELECT count(*) AS n FROM messages WHERE conv_id = ?').get(conv.id).n;
  gte(seeded, 10_000, `库里现有 ${seeded} 条消息（≥ 10000）`);
  ok(bulkMs > 0, `灌 1 万条用了 ${bulkMs}ms`);
  const ftsRows = db.prepare('SELECT count(*) AS n FROM messages_fts').get().n;
  gte(ftsRows, 10_000, `FTS 索引里有 ${ftsRows} 行（触发器生效）`);
  db.close();

  // 实测查询耗时（console.time 等价：performance.now 前后）
  const queries = ['批量消息', 'filler', '周报'];
  const timings = [];
  for (const q of queries) {
    const s = performance.now();
    const res = expectOk(await a.request('search.messages', { q, limit: 50 }), `搜「${q}」`);
    const cost = performance.now() - s;
    timings.push({ q, ms: cost, hits: res.hits.length });
    lt(cost, 500, `搜「${q}」耗时 ${cost.toFixed(1)}ms（< 500ms，命中 ${res.hits.length}）`);
  }
  ok(
    timings.every((t) => Number.isFinite(t.ms)),
    `三次查询耗时: ${timings.map((t) => `${t.q}=${t.ms.toFixed(1)}ms`).join(', ')}`,
  );

  section('M8.7 空查询与限流');
  const empty = await a.request('search.messages', { q: '' });
  expectError(empty, 'VALIDATION_FAILED', '空查询 → VALIDATION_FAILED');

  a.close();
  b.close();
  carolClient.close();

  return summary('M8');
}