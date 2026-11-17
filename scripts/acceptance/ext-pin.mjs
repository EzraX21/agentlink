#!/usr/bin/env node
/**
 * ext-pin 验收：置顶消息（协议扩展 §4，见 docs/PROPOSAL-protocol-ext.md §4）。
 *
 * v1 只做**单条置顶**：再置顶一条会替换掉上一条。
 * 权限与群名/公告同档（owner/admin）—— 置顶是全群可见内容，普通成员不该决定。
 * 事件 `message.pin` 带 seq，所以断线重连后横幅还在。
 */
import { section, summary, ok, eq, gte, expectOk, expectError } from './_assert.mjs';
import { connectAuthed } from './_client.mjs';

export const needsServer = true;

export async function run(ctx) {
  const { http, wsUrl } = ctx;

  const reg = async (username, displayName) => {
    const res = await http('POST', '/api/auth/register', {
      body: { username, display_name: displayName, password: 'pin-pass-123' },
    });
    if (res.status !== 201) throw new Error(`注册失败: ${res.text}`);
    return res.body;
  };

  const alice = await reg('alice', '爱丽丝'); // owner
  const bob = await reg('bob', '小明'); // member
  const carol = await reg('carol', '卡罗'); // 断线重连用

  const a = (await connectAuthed(wsUrl, alice.access_token)).client;
  const b = (await connectAuthed(wsUrl, bob.access_token)).client;
  const c = (await connectAuthed(wsUrl, carol.access_token)).client;

  const conv = expectOk(
    await a.request('conv.create', {
      kind: 'group',
      title: '置顶测试群',
      member_ids: [bob.user.id, carol.user.id],
    }),
    '建群（alice + bob + carol）',
  ).conv;

  const first = expectOk(
    await a.request('message.send', {
      conv_id: conv.id,
      client_msg_id: 'pin-1',
      content: [{ type: 'text', text: '这条要被置顶' }],
    }),
    '发第一条',
  );
  const second = expectOk(
    await a.request('message.send', {
      conv_id: conv.id,
      client_msg_id: 'pin-2',
      content: [{ type: 'text', text: '这条后来也被置顶' }],
    }),
    '发第二条',
  );

  section('1. owner 置顶 → 会话带 pinned_message_id');
  const pinned = expectOk(
    await a.request('message.pin', { conv_id: conv.id, message_id: first.message_id }),
    '置顶第一条',
  );
  eq(pinned.conv.pinned_message_id, first.message_id, 'res 里带 pinned_message_id');

  const convAfter = expectOk(await a.request('conv.get', { conv_id: conv.id }), 'conv.get');
  eq(convAfter.conv.pinned_message_id, first.message_id, 'conv.get 也能读到');

  section('2. 成员收到 message.pin 事件（带 seq，可补发）');
  const evt = await b.nextEvent('message.pin');
  eq(evt.data.message_id, first.message_id, 'bob 收到 message.pin');
  eq(evt.data.by, alice.user.id, '事件里带操作者');
  gte(evt.seq, 1, `带 seq（${evt.seq}）`);

  section('3. 单条置顶：再置顶一条会替换');
  const repinned = expectOk(
    await a.request('message.pin', { conv_id: conv.id, message_id: second.message_id }),
    '置顶第二条',
  );
  eq(repinned.conv.pinned_message_id, second.message_id, '指向第二条（v1 只支持单条）');
  const evt2 = await b.nextEvent('message.pin');
  eq(evt2.data.message_id, second.message_id, '成员收到替换事件');

  section('4. 取消置顶');
  const unpinned = expectOk(
    await a.request('message.unpin', { conv_id: conv.id }),
    '取消置顶',
  );
  eq(unpinned.conv.pinned_message_id ?? null, null, '取消后为空');
  const evt3 = await b.nextEvent('message.pin');
  eq(evt3.data.message_id, null, '取消事件里 message_id 为 null');

  section('5. 补发：断线重连后能拿到置顶事件');
  expectOk(
    await a.request('message.pin', { conv_id: conv.id, message_id: first.message_id }),
    '再置顶一次（给补发用）',
  );
  c.close();
  const c2 = (await connectAuthed(wsUrl, carol.access_token)).client;
  const resume = expectOk(await c2.request('resume', { last_seq: 0 }), 'carol resume');
  const replayed = await c2.drain(400);
  ok(
    replayed.some((e) => e.type === 'message.pin'),
    `补发 ${resume.replayed} 条里有 message.pin（置顶是状态，重连后横幅要还在）`,
  );
  const cConv = expectOk(await c2.request('conv.get', { conv_id: conv.id }), 'carol conv.get');
  eq(cConv.conv.pinned_message_id, first.message_id, 'carol 重连后读到置顶状态');

  section('6. 权限：普通成员不能置顶');
  expectError(
    await b.request('message.pin', { conv_id: conv.id, message_id: second.message_id }),
    'PERM_DENIED',
    'member 置顶 → PERM_DENIED',
  );
  expectError(
    await b.request('message.unpin', { conv_id: conv.id }),
    'PERM_DENIED',
    'member 取消置顶 → PERM_DENIED',
  );

  section('7. 校验：不存在 / 已撤回的消息不能置顶');
  expectError(
    await a.request('message.pin', {
      conv_id: conv.id,
      message_id: 'm_01JZZZZZZZZZZZZZZZZZZZZZZZ',
    }),
    'NOT_FOUND',
    '不存在的消息 → NOT_FOUND',
  );

  const toRevoke = expectOk(
    await a.request('message.send', {
      conv_id: conv.id,
      client_msg_id: 'pin-revoked',
      content: [{ type: 'text', text: '马上撤回' }],
    }),
    '发一条待撤回的',
  );
  expectOk(
    await a.request('message.revoke', { conv_id: conv.id, message_id: toRevoke.message_id }),
    '撤回它',
  );
  expectError(
    await a.request('message.pin', { conv_id: conv.id, message_id: toRevoke.message_id }),
    'CONFLICT',
    '已撤回的消息 → CONFLICT',
  );

  a.close();
  b.close();
  c2.close();

  return summary('ext-pin');
}
