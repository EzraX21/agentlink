#!/usr/bin/env node
/**
 * ui-ux 验收：对齐 TG 客户端的第 2 批（纯客户端，不动协议）
 *
 * 这一批的共同点：不需要新增 op/evt，只靠协议里**已有**的字段
 * （`reply_to`）和本地状态（草稿 / 未读 / 置顶 / 面板开关）。
 *
 * A. 服务端契约（真跑）：reply_to 往返、引用不存在的消息被拒
 * B. 前端静态实现检查：日期分隔、右键菜单、草稿、未读、置顶、成员搜索、快捷键
 * C. web 单测全绿且数量达标
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { section, summary, ok, eq, gte, includes, expectOk, expectError } from './_assert.mjs';
import { WsClient } from './_client.mjs';

const exec = promisify(execFile);

export const needsServer = true;
export const relaxedRateLimit = true;

async function mkUser(http, username, displayName) {
  const res = await http('POST', '/api/auth/register', {
    body: { username, display_name: displayName, password: 'ux-test-pass-123' },
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
  const { http, wsUrl, repoRoot } = ctx;

  const alice = await mkUser(http, 'alice', '爱丽丝');
  const bob = await mkUser(http, 'bob', '小明');
  const a = await connect(wsUrl, alice.access_token);
  const b = await connect(wsUrl, bob.access_token);

  const conv = expectOk(
    await a.request('conv.create', { kind: 'group', title: 'UX 测试群', member_ids: [bob.user.id] }),
    '建群',
  ).conv;

  section('A1. 引用回复：reply_to 往返');
  const original = expectOk(
    await a.request('message.send', {
      conv_id: conv.id,
      client_msg_id: 'orig-1',
      content: [{ type: 'text', text: '周报什么时候交' }],
    }),
    '发原消息',
  );
  await b.nextEvent('message.new');

  const reply = expectOk(
    await b.request('message.send', {
      conv_id: conv.id,
      client_msg_id: 'reply-1',
      content: [{ type: 'text', text: '这周五' }],
      reply_to: original.message_id,
    }),
    '带 reply_to 回复',
  );
  ok(typeof reply.message_id === 'string', '回复也拿到 message_id');

  // 注意：服务端会把 message.new 也回给发送者，所以 a 的队列里可能还压着自己刚发的那条。
  // 这里按内容精确取"回复"那条，避免取到旧事件。
  const replyEvt = await a.nextEvent(
    (e) => e.type === 'message.new' && e.data?.message?.content?.[0]?.text === '这周五',
  );
  eq(replyEvt.data.message.reply_to, original.message_id, '对端收到 reply_to 字段');

  const fetched = expectOk(
    await a.request('message.get', { conv_id: conv.id, message_id: reply.message_id }),
    'message.get 取回回复',
  );
  eq(fetched.message.reply_to, original.message_id, 'message.get 也保留 reply_to');

  // 引用不存在的消息 → NOT_FOUND
  const badReply = await a.request('message.send', {
    conv_id: conv.id,
    client_msg_id: 'bad-reply',
    content: [{ type: 'text', text: '引用一条不存在的' }],
    reply_to: 'm_01M7JD0000000000000000000Z',
  });
  expectError(badReply, 'NOT_FOUND', '引用不存在的消息 → NOT_FOUND');

  // 引用别的会话里的消息 → 也要被拒（防止跨会话引用泄漏）
  const conv2 = expectOk(
    await a.request('conv.create', { kind: 'group', title: '另一个群', member_ids: [bob.user.id] }),
    '建第二个群',
  ).conv;
  const crossReply = await a.request('message.send', {
    conv_id: conv2.id,
    client_msg_id: 'cross-reply',
    content: [{ type: 'text', text: '跨群引用' }],
    reply_to: original.message_id,
  });
  expectError(crossReply, 'NOT_FOUND', '跨会话引用 → NOT_FOUND（不泄漏）');

  section('A2. 撤回后引用块的处理');
  expectOk(
    await a.request('message.revoke', { conv_id: conv.id, message_id: original.message_id }),
    '撤回被引用的原消息',
  );
  const afterRevoke = expectOk(
    await a.request('message.get', { conv_id: conv.id, message_id: reply.message_id }),
    '撤回后取回复',
  );
  eq(
    afterRevoke.message.reply_to,
    original.message_id,
    'reply_to 仍指向原消息（服务端不做级联改写）',
  );
  // 客户端对"引用的消息未加载/已撤回"要显示占位而不是空白 —— 见下面的静态检查

  section('B1. 前端实现检查（第 2 批）');
  const src = {
    chat: await readFile(`${repoRoot}/packages/web/src/components/ChatWindow.tsx`, 'utf8'),
    bubble: await readFile(`${repoRoot}/packages/web/src/components/MessageBubble.tsx`, 'utf8'),
    menu: await readFile(`${repoRoot}/packages/web/src/components/MessageContextMenu.tsx`, 'utf8'),
    list: await readFile(`${repoRoot}/packages/web/src/components/ConversationList.tsx`, 'utf8'),
    members: await readFile(`${repoRoot}/packages/web/src/components/MemberPanel.tsx`, 'utf8'),
    local: await readFile(`${repoRoot}/packages/web/src/lib/localState.ts`, 'utf8'),
    app: await readFile(`${repoRoot}/packages/web/src/App.tsx`, 'utf8'),
  };

  // 日期分隔
  includes(src.chat, 'dayLabel', '聊天窗有日期分隔');
  includes(src.chat, "'今天'", '日期文案有「今天」');
  includes(src.chat, "'昨天'", '日期文案有「昨天」');

  // 引用回复
  includes(src.chat, 'replyTo', '输入区支持选择被引用消息');
  includes(src.chat, 'onSendAttachment(file, replyTo?.id)', '附件也带 reply_to');
  includes(src.chat, 'onSend(text, replyTo?.id)', '文本消息带 reply_to');
  includes(src.bubble, '跳到被引用的消息', '气泡里的引用块可点击跳转');
  includes(src.chat, '（消息未加载）', '引用的消息不在本地时有占位文案');

  // 右键菜单
  includes(src.menu, '复制文本', '右键菜单有复制');
  includes(src.menu, '引用回复', '右键菜单有引用回复');
  includes(src.menu, '撤回', '右键菜单有撤回');
  includes(src.menu, "e.key === 'Escape'", '菜单支持 Esc 关闭');
  includes(src.chat, 'onContextMenu', '气泡绑定了右键菜单');
  ok(!src.bubble.includes('`[${b.type}]`'), '不再有 [image]/[file] 文字占位');

  // 草稿 / 未读 / 置顶
  includes(src.local, 'loadDraft', '草稿可读写');
  includes(src.local, 'loadUnread', '未读可读写');
  includes(src.local, 'orderByPinned', '置顶排序');
  includes(src.chat, 'saveDraft', '聊天窗保存草稿');
  includes(src.chat, 'clearDraft', '发送后清草稿');
  includes(src.list, 'UnreadBadge', '会话列表有未读角标');
  includes(src.list, '99+', '未读超过 99 显示 99+');
  includes(src.list, 'onTogglePin', '会话可置顶');
  includes(src.app, 'saveUnread', '未读状态被持久化');
  includes(src.app, 'loadPinned', '置顶状态被持久化');

  // 成员搜索 + 面板
  includes(src.members, '搜索成员', '成员面板有搜索框');

  // 跳到底部
  includes(src.chat, '回到底部', '有"回到底部"按钮');
  includes(src.chat, 'newWhileScrolledUp', '滚上去时累计新消息数');

  // 群公告
  includes(src.chat, 'announcement', '聊天窗展示群公告');

  // 快捷键
  includes(src.app, "e.key.toLowerCase() === 'k'", 'Ctrl/Cmd+K 打开搜索');
  includes(src.app, "e.key === 'Escape'", 'Esc 关闭面板');

  section('B2. 本地状态不落库（避免误当服务端能力）');
  const protoOps = await readFile(`${repoRoot}/packages/protocol/src/ops.ts`, 'utf8');
  for (const notAnOp of ['typing.send', 'message.edit', 'reaction.add', 'message.pin']) {
    ok(!protoOps.includes(notAnOp), `${notAnOp} 仍未加入协议（第 2 批不扩协议）`);
  }

  section('C. web 单测');
  const vitest = path.join(repoRoot, 'packages/web/node_modules/.bin/vitest');
  const { stdout } = await exec(vitest, ['run', '--reporter=dot'], {
    cwd: path.join(repoRoot, 'packages/web'),
    timeout: 120_000,
  });
  const plain = stdout.replace(/\u001b\[[0-9;]*m/g, '');
  ok(!/failed/.test(plain), 'web 单测无失败');
  const passed = /Tests\s+(\d+) passed/.exec(plain);
  gte(Number(passed?.[1] ?? 0), 33, `web 单测通过 ${passed?.[1] ?? '?'} 项（≥33）`);

  a.close();
  b.close();

  return summary('ui-ux');
}