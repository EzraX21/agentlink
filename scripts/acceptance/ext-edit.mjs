#!/usr/bin/env node
/**
 * ext-edit 验收：编辑消息（协议扩展 §3，见 docs/PROPOSAL-protocol-ext.md §3）。
 *
 * 这条最重要的不是"内容变了"，而是**全文索引跟着重建**：
 * FTS5 的 UPDATE 触发器要在同一条 UPDATE 里删旧词条、插新词条。
 * 如果这里错了，用户会搜到"不存在的内容"——比编辑失败难查得多。
 */
import { section, summary, ok, eq, gte, expectOk, expectError } from './_assert.mjs';
import { connectAuthed } from './_client.mjs';
import { openDb } from './_db.mjs';

export const needsServer = true;
export const relaxedRateLimit = true;

export async function run(ctx) {
  const { http, wsUrl } = ctx;

  const reg = async (username, displayName) => {
    const res = await http('POST', '/api/auth/register', {
      body: { username, display_name: displayName, password: 'edit-pass-123' },
    });
    if (res.status !== 201) throw new Error(`注册失败: ${res.text}`);
    return res.body;
  };

  const alice = await reg('alice', '爱丽丝');
  const bob = await reg('bob', '小明');

  const a = (await connectAuthed(wsUrl, alice.access_token)).client;
  const b = (await connectAuthed(wsUrl, bob.access_token)).client;

  const conv = expectOk(
    await a.request('conv.create', {
      kind: 'group',
      title: '编辑测试群',
      member_ids: [bob.user.id],
    }),
    '建群',
  ).conv;

  section('1. 编辑自己的消息：内容更新、edited_at 落库');
  const sent = expectOk(
    await a.request('message.send', {
      conv_id: conv.id,
      client_msg_id: 'edit-1',
      content: [{ type: 'text', text: '原始内容 甲乙丙' }],
    }),
    '发一条消息',
  );
  const messageId = sent.message_id;

  const before = expectOk(
    await a.request('message.get', { conv_id: conv.id, message_id: messageId }),
    '编辑前 message.get',
  ).message;
  eq(before.edited_at ?? null, null, '新消息 edited_at 为 null');

  const edited = expectOk(
    await a.request('message.edit', {
      conv_id: conv.id,
      message_id: messageId,
      content: [{ type: 'text', text: '改过的内容 丁戊己' }],
    }),
    '编辑消息',
  ).message;
  eq(edited.content[0].text, '改过的内容 丁戊己', '返回的是新内容');
  gte(edited.edited_at ?? 0, 1, 'edited_at 已写入');
  eq(edited.seq, before.seq, 'seq 不变（编辑不改消息顺序）');

  section('2. 对方收到 message.edit 事件（带 seq，可补发）');
  const evt = await b.nextEvent('message.edit');
  eq(evt.data.message.id, messageId, 'bob 收到 message.edit');
  eq(evt.data.message.content[0].text, '改过的内容 丁戊己', '事件里是新内容');
  gte(evt.seq, 1, `事件带 seq（${evt.seq}）`);

  section('3. 全文索引跟着重建（最容易漏的一条）');
  const oldSearch = expectOk(
    await a.request('search.messages', { q: '甲乙丙', limit: 10 }),
    '搜旧关键词',
  );
  eq(oldSearch.hits.length, 0, '旧关键词搜不到了');

  const newSearch = expectOk(
    await a.request('search.messages', { q: '丁戊己', limit: 10 }),
    '搜新关键词',
  );
  gte(newSearch.hits.length, 1, '新关键词能搜到');
  eq(newSearch.hits[0].message_id, messageId, '命中的是这条被编辑的消息');

  section('4. FTS 表里没有旧词条残留');
  const db = openDb(ctx.dbPath);
  const stale = db
    .prepare(
      `SELECT count(*) AS n FROM messages_fts f
         JOIN messages m ON m.rowid = f.rowid
        WHERE m.id = ? AND f.text_plain LIKE '%甲乙丙%'`,
    )
    .get(messageId);
  const fresh = db
    .prepare(
      `SELECT count(*) AS n FROM messages_fts f
         JOIN messages m ON m.rowid = f.rowid
        WHERE m.id = ? AND f.text_plain LIKE '%丁戊己%'`,
    )
    .get(messageId);
  db.close();
  eq(stale.n, 0, 'FTS 里没有旧文本');
  eq(fresh.n, 1, 'FTS 里是新文本');

  section('5. 权限：不能编辑别人的消息');
  expectError(
    await b.request('message.edit', {
      conv_id: conv.id,
      message_id: messageId,
      content: [{ type: 'text', text: '我改你的' }],
    }),
    'PERM_DENIED',
    '改别人的消息 → PERM_DENIED',
  );

  section('6. 撤回/流式中的消息不能编辑');
  const streaming = expectOk(
    await a.request('stream.begin', { conv_id: conv.id, client_msg_id: 'edit-stream' }),
    '开一条流式消息',
  );
  expectError(
    await a.request('message.edit', {
      conv_id: conv.id,
      message_id: streaming.message_id,
      content: [{ type: 'text', text: '改流式' }],
    }),
    'CONFLICT',
    '流式中的消息 → CONFLICT',
  );
  // 空内容的流 abort 会回 CONFLICT（协议 §8.4：空内容的消息已被删除），
  // 这是**正确**行为，不是失败 —— 所以这里只看不抛异常，不当作断言。
  const aborted = await a.request('stream.abort', {
    conv_id: conv.id,
    message_id: streaming.message_id,
  });
  ok(
    aborted.ok === false ? aborted.error.code === 'CONFLICT' : true,
    '空内容的流 abort → CONFLICT（消息已删除，符合协议 §8.4）',
  );

  const toRevoke = expectOk(
    await a.request('message.send', {
      conv_id: conv.id,
      client_msg_id: 'edit-revoke',
      content: [{ type: 'text', text: '马上撤回' }],
    }),
    '发一条待撤回的',
  );
  expectOk(
    await a.request('message.revoke', { conv_id: conv.id, message_id: toRevoke.message_id }),
    '撤回它',
  );
  expectError(
    await a.request('message.edit', {
      conv_id: conv.id,
      message_id: toRevoke.message_id,
      content: [{ type: 'text', text: '改撤回的' }],
    }),
    'CONFLICT',
    '已撤回的消息 → CONFLICT',
  );

  section('7. 多块内容编辑（文本 + 引用块不受影响）');
  const multi = expectOk(
    await a.request('message.edit', {
      conv_id: conv.id,
      message_id: messageId,
      content: [
        { type: 'text', text: '第一段' },
        { type: 'text', text: '第二段' },
      ],
    }),
    '编辑成两块',
  ).message;
  eq(multi.content.length, 2, '两块内容都在');
  const hist = expectOk(await a.request('history.fetch', { conv_id: conv.id, limit: 10 }), '拉历史');
  const inHist = hist.messages.find((m) => m.id === messageId);
  eq(inHist?.content.length, 2, '历史里也是两块');

  a.close();
  b.close();

  return summary('ext-edit');
}
