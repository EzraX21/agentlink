#!/usr/bin/env node
/**
 * ext-reaction 验收：表情回应（协议扩展 §2，见 docs/PROPOSAL-protocol-ext.md §2）。
 *
 * 关键点：
 *   1. 事件带 **seq**（回应是状态，断线重连必须能补齐）
 *   2. 返回**全量汇总**而不是增量：客户端整体替换，丢帧也不一致
 *   3. 同一人重复点同一个表情 = 取消（主键去重）
 *   4. 撤回消息时回应被清空，且推一条空汇总的事件
 *   5. 只能回应终态消息（流式中的不能），非成员不能回应
 */
import { section, summary, ok, eq, gte, expectOk, expectError } from './_assert.mjs';
import { connectAuthed } from './_client.mjs';

export const needsServer = true;

export async function run(ctx) {
  const { http, wsUrl } = ctx;

  const reg = async (username, displayName) => {
    const res = await http('POST', '/api/auth/register', {
      body: { username, display_name: displayName, password: 'reaction-pass-123' },
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
      title: '表情测试群',
      member_ids: [bob.user.id, carol.user.id],
    }),
    '建群（alice + bob + carol）',
  ).conv;

  const sent = expectOk(
    await a.request('message.send', {
      conv_id: conv.id,
      client_msg_id: 'reaction-1',
      content: [{ type: 'text', text: '给这条点赞' }],
    }),
    '发一条消息',
  );
  const messageId = sent.message_id;

  section('1. alice 加 👍 → 事件带 seq，汇总正确');
  const added = expectOk(
    await a.request('reaction.add', { conv_id: conv.id, message_id: messageId, emoji: '👍' }),
    'alice 加 👍',
  );
  eq(added.reactions.length, 1, '一个表情');
  eq(added.reactions[0].emoji, '👍', 'emoji 正确');
  eq(added.reactions[0].user_ids.length, 1, '一人回应');

  const evt = await b.nextEvent('message.reaction');
  eq(evt.data.message_id, messageId, 'bob 收到 message.reaction');
  gte(evt.seq, 1, `事件带 seq（${evt.seq}，可补发）`);
  eq(evt.data.reactions[0].emoji, '👍', '事件里是全量汇总');

  section('2. bob 也加 👍 → 汇总变成两人');
  const added2 = expectOk(
    await b.request('reaction.add', { conv_id: conv.id, message_id: messageId, emoji: '👍' }),
    'bob 加 👍',
  );
  eq(added2.reactions[0].user_ids.length, 2, '两个人都在这条汇总里');
  ok(
    added2.reactions[0].user_ids.includes(alice.user.id) &&
      added2.reactions[0].user_ids.includes(bob.user.id),
    'user_ids 里两个 id 都在',
  );

  section('3. 重复点同一个表情 = 取消');
  const removed = expectOk(
    await b.request('reaction.remove', { conv_id: conv.id, message_id: messageId, emoji: '👍' }),
    'bob 取消 👍',
  );
  eq(removed.reactions[0].user_ids.length, 1, '只剩 alice');
  eq(removed.reactions[0].user_ids[0], alice.user.id, '留下的是 alice');

  section('4. 多个表情各自汇总');
  expectOk(
    await b.request('reaction.add', { conv_id: conv.id, message_id: messageId, emoji: '🎉' }),
    'bob 加 🎉',
  );
  const hist = expectOk(
    await a.request('history.fetch', { conv_id: conv.id, limit: 10 }),
    '拉历史',
  );
  const msg = hist.messages.find((m) => m.id === messageId);
  gte(msg.reactions?.length ?? 0, 2, '历史里这条消息带两个表情汇总');
  const emojis = (msg.reactions ?? []).map((r) => r.emoji);
  ok(emojis.includes('👍') && emojis.includes('🎉'), `两种表情都在（${emojis.join(',')}）`);

  section('5. 补发：断线重连能拿到回应事件');
  c.close();
  const c2 = (await connectAuthed(wsUrl, carol.access_token)).client;
  const resume = expectOk(await c2.request('resume', { last_seq: 0 }), 'carol resume');
  const replayed = await c2.drain(400);
  ok(
    replayed.some((e) => e.type === 'message.reaction'),
    `补发 ${resume.replayed} 条里有 message.reaction（回应是状态，不能丢）`,
  );

  section('6. 撤回后回应清空');
  expectOk(
    await a.request('message.revoke', { conv_id: conv.id, message_id: messageId }),
    'alice 撤回消息',
  );
  const revokeEvt = await b.nextEvent('message.revoke');
  eq(revokeEvt.data.message_id, messageId, 'bob 收到撤回');
  // 用 message.get 而不是 history：历史列表不返回已撤回的行，
  // 那样断言会在 undefined 上"假通过"。
  const revoked = expectOk(
    await a.request('message.get', { conv_id: conv.id, message_id: messageId }),
    'message.get',
  ).message;
  eq(revoked.state, 'revoked', '消息已撤回');
  eq(revoked.reactions?.length ?? 0, 0, '撤回后没有回应残留');

  section('7. 校验与权限');
  const badEmoji = await a.request('reaction.add', {
    conv_id: conv.id,
    message_id: messageId,
    emoji: 'not-an-emoji',
  });
  expectError(badEmoji, 'VALIDATION_FAILED', '非 emoji 字符串 → VALIDATION_FAILED');

  const missing = await a.request('reaction.add', {
    conv_id: conv.id,
    message_id: 'm_01JZZZZZZZZZZZZZZZZZZZZZZZ',
    emoji: '👍',
  });
  expectError(missing, 'NOT_FOUND', '不存在的消息 → NOT_FOUND');

  // carol 已被踢出？没有 —— 但用一个 outsider 验权限
  const outsider = await http('POST', '/api/auth/register', {
    body: { username: 'mallory', display_name: '马洛里', password: 'reaction-pass-123' },
  });
  const outsiderWs = (await connectAuthed(wsUrl, outsider.body.access_token)).client;
  expectError(
    await outsiderWs.request('reaction.add', {
      conv_id: conv.id,
      message_id: messageId,
      emoji: '👍',
    }),
    'PERM_DENIED',
    '非成员回应 → PERM_DENIED',
  );
  outsiderWs.close();

  a.close();
  b.close();
  c2.close();

  return summary('ext-reaction');
}
