#!/usr/bin/env node
/**
 * ext-forward 验收：转发消息（协议扩展 §6）。
 *
 * 转发**不新增事件**——它就是一次 `message.new`，客户端没有额外分支。
 * 重点验：
 *   1. 目标群成员收到 message.new（内容被复制）
 *   2. 源消息仍在原会话（转发是复制，不是移动）
 *   3. 附件随 attachment_id 走，目标群成员能下载（权限由"引用它的群"决定）
 *   4. 两个会话都必须是成员（否则等于绕过群隔离）
 *   5. 已撤回/流式中的消息不能转发
 */
import { section, summary, ok, eq, gte, expectOk, expectError } from './_assert.mjs';
import { connectAuthed } from './_client.mjs';

export const needsServer = true;

export async function run(ctx) {
  const { http, wsUrl } = ctx;

  const reg = async (username, displayName) => {
    const res = await http('POST', '/api/auth/register', {
      body: { username, display_name: displayName, password: 'fwd-pass-123' },
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

  // alice 在两个群里；bob 只在 groupA；carol 只在 groupB
  const groupA = expectOk(
    await a.request('conv.create', { kind: 'group', title: 'A 群', member_ids: [bob.user.id] }),
    '建 A 群',
  ).conv;
  const groupB = expectOk(
    await a.request('conv.create', { kind: 'group', title: 'B 群', member_ids: [carol.user.id] }),
    '建 B 群',
  ).conv;

  section('1. 转发文本消息：目标群收到 message.new');
  const source = expectOk(
    await a.request('message.send', {
      conv_id: groupA.id,
      client_msg_id: 'fwd-src',
      content: [{ type: 'text', text: '要被转发的原文' }],
    }),
    'A 群发一条',
  );

  const forwarded = expectOk(
    await a.request('message.forward', {
      conv_id: groupB.id,
      from_conv_id: groupA.id,
      message_id: source.message_id,
    }),
    '转发到 B 群',
  );
  ok(forwarded.message_id !== source.message_id, '转发产生了新的消息 id');
  gte(forwarded.seq, 1, `新消息有 seq（${forwarded.seq}）`);

  const evt = await c.nextEvent('message.new');
  eq(evt.data.message.id, forwarded.message_id, 'B 群成员收到 message.new（没有新事件类型）');
  eq(evt.data.message.content[0].text, '要被转发的原文', '内容被复制过去');
  eq(evt.data.message.sender.id, alice.user.id, '发送者是转发的人');

  section('2. 源消息仍在原会话（转发是复制不是移动）');
  const histA = expectOk(await a.request('history.fetch', { conv_id: groupA.id, limit: 10 }), 'A 群历史');
  eq(histA.messages.length, 1, 'A 群还是那一条');
  eq(histA.messages[0].id, source.message_id, '源消息没被移走');

  section('3. 附件随 attachment_id 走，目标群成员能下载');
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64',
  );
  const form = new FormData();
  form.append('file', new Blob([png], { type: 'image/png' }), 'fwd.png');
  const up = await fetch(`${ctx.baseUrl}/api/attachments`, {
    method: 'POST',
    headers: { authorization: `Bearer ${alice.access_token}` },
    body: form,
  });
  const att = await up.json();

  const withImage = expectOk(
    await a.request('message.send', {
      conv_id: groupA.id,
      client_msg_id: 'fwd-img',
      content: [{ type: 'image', attachment_id: att.attachment_id }],
    }),
    'A 群发一张图',
  );

  const fwdImg = expectOk(
    await a.request('message.forward', {
      conv_id: groupB.id,
      from_conv_id: groupA.id,
      message_id: withImage.message_id,
    }),
    '转发图片到 B 群',
  );
  const evtImg = await c.nextEvent('message.new');
  eq(evtImg.data.message.content[0].type, 'image', '转发后仍是图片块');
  eq(evtImg.data.message.content[0].attachment_id, att.attachment_id, 'attachment_id 保持一致');
  eq(evtImg.data.message.id, fwdImg.message_id, '推送的是转发出来的那条');

  // carol 现在能下载这张图（她在 B 群，B 群有引用它的消息）
  const dl = await fetch(`${ctx.baseUrl}/api/attachments/${att.attachment_id}/fwd.png`, {
    headers: { authorization: `Bearer ${carol.access_token}` },
  });
  eq(dl.status, 200, '目标群的成员可以下载被转发的附件');
  eq(Buffer.from(await dl.arrayBuffer()).byteLength, png.byteLength, '字节数一致');

  section('4. 权限：两个会话都必须是成员');
  // bob 在 A 群但不在 B 群 → 不能把 A 的消息转发到 B
  expectError(
    await b.request('message.forward', {
      conv_id: groupB.id,
      from_conv_id: groupA.id,
      message_id: source.message_id,
    }),
    'PERM_DENIED',
    '不在目标群 → PERM_DENIED',
  );

  // carol 在 B 群但不在 A 群 → 不能把 A 的消息转出来（等于读别人的群）
  expectError(
    await c.request('message.forward', {
      conv_id: groupB.id,
      from_conv_id: groupA.id,
      message_id: source.message_id,
    }),
    'PERM_DENIED',
    '不在源群 → PERM_DENIED（不能借转发读别人的群）',
  );

  section('5. 已撤回/流式中的消息不能转发');
  const toRevoke = expectOk(
    await a.request('message.send', {
      conv_id: groupA.id,
      client_msg_id: 'fwd-revoke',
      content: [{ type: 'text', text: '马上撤回' }],
    }),
    '发一条待撤回的',
  );
  expectOk(
    await a.request('message.revoke', { conv_id: groupA.id, message_id: toRevoke.message_id }),
    '撤回它',
  );
  expectError(
    await a.request('message.forward', {
      conv_id: groupB.id,
      from_conv_id: groupA.id,
      message_id: toRevoke.message_id,
    }),
    'CONFLICT',
    '已撤回的消息 → CONFLICT',
  );

  const streaming = expectOk(
    await a.request('stream.begin', { conv_id: groupA.id, client_msg_id: 'fwd-stream' }),
    '开一条流式消息',
  );
  expectError(
    await a.request('message.forward', {
      conv_id: groupB.id,
      from_conv_id: groupA.id,
      message_id: streaming.message_id,
    }),
    'CONFLICT',
    '流式中的消息 → CONFLICT',
  );
  await a.request('stream.abort', { conv_id: groupA.id, message_id: streaming.message_id });

  section('6. 源消息必须属于 from_conv_id');
  expectError(
    await a.request('message.forward', {
      conv_id: groupB.id,
      from_conv_id: groupA.id,
      message_id: 'm_01JZZZZZZZZZZZZZZZZZZZZZZZ',
    }),
    'NOT_FOUND',
    '不存在的消息 → NOT_FOUND',
  );

  a.close();
  b.close();
  c.close();

  return summary('ext-forward');
}
