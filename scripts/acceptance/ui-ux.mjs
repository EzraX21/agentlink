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

  section('A3. 群信息：改群名/公告要推事件、且能补发');
  expectOk(
    await a.request('group.update', { conv_id: conv.id, title: '改过的群名', announcement: '周五交周报' }),
    'owner 改群名与公告',
  );
  const groupEvt = await b.nextEvent('group.update');
  eq(groupEvt.data.conv.title, '改过的群名', '成员收到 group.update 事件（不用刷新）');
  eq(groupEvt.data.conv.announcement, '周五交周报', '公告也在事件里');
  gte(groupEvt.seq, 1, 'group.update 带 seq（可补发）');

  const bobView = expectOk(await b.request('conv.get', { conv_id: conv.id }), 'bob 重新拉群信息');
  eq(bobView.conv.title, '改过的群名', 'bob 侧群名已更新');

  // 补发：bob 断开 → 再改一次 → 重连 resume 应收到 group.update
  b.close();
  await new Promise((r) => setTimeout(r, 150));
  expectOk(
    await a.request('group.update', { conv_id: conv.id, title: '断线期间改的名' }),
    'bob 断线期间再改名',
  );
  const b2 = await connect(wsUrl, bob.access_token);
  const lastSeq = groupEvt.seq;
  const resumeRes = expectOk(await b2.request('resume', { last_seq: lastSeq }), 'bob 重连 resume');
  gte(resumeRes.replayed, 1, `补发了 ${resumeRes.replayed} 条事件`);
  const replayed = await b2.drain(500);
  const replayedGroup = replayed.find((e) => e.type === 'group.update');
  ok(replayedGroup !== undefined, 'group.update 在补发里（30 天内不丢）');
  eq(replayedGroup?.data?.conv?.title, '断线期间改的名', '补发的群名正确');

  // 权限：普通成员不能改
  const bobRename = await b2.request('group.update', { conv_id: conv.id, title: 'bob 想改名' });
  expectError(bobRename, 'PERM_DENIED', '普通成员改群名 → PERM_DENIED');

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
  includes(src.chat, 'onSendAttachment(file, replyTo?.id,', '附件也带 reply_to（并上报进度）');
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

  section('B1b. 第 2 批续：正文富文本 / 上传进度 / 会话内搜索');
  const src2 = {
    rich: await readFile(`${repoRoot}/packages/web/src/lib/richtext.ts`, 'utf8'),
    richView: await readFile(`${repoRoot}/packages/web/src/components/RichText.tsx`, 'utf8'),
    attach: await readFile(`${repoRoot}/packages/web/src/lib/attachments.ts`, 'utf8'),
  };
  includes(src2.rich, 'SAFE_URL', '只把 http(s)/mailto 当链接（挡 javascript:）');
  includes(src2.rich, 'codeblock', '支持代码块');
  includes(src2.richView, 'noopener', '外链带 rel=noopener');
  ok(
    !/dangerouslySetInnerHTML\s*=/.test(src2.richView),
    'RichText 不用 dangerouslySetInnerHTML（正文是任意用户输入）',
  );
  includes(src.bubble, 'RichText', '消息气泡走 RichText 渲染');
  includes(src2.attach, 'XMLHttpRequest', '上传用 XHR（fetch 拿不到上传进度）');
  includes(src2.attach, 'upload.onprogress', '监听上传进度事件');
  includes(src.chat, 'progress', '输入区显示上传进度');
  includes(src.chat, '在这个会话里搜索…', '聊天窗有会话内搜索');
  includes(src.chat, '下一条', '会话内搜索可跳下一条');
  includes(src.chat, 'setToast', '复制后有提示');

  section('B1c. 第 2 批再续：@提及 / 未读分隔线 / 多图灯箱 / 窄屏单栏');
  includes(src2.rich, 'mention', '正文支持 @提及识别');
  includes(src2.rich, "kind: 'mention'", '提及是独立片段类型');
  includes(src2.richView, "case 'mention'", '提及有专门渲染');
  includes(src.chat, '以下为新消息', '有未读分隔线');
  includes(src.chat, "kind: 'unread'", '分隔线是独立行类型');
  includes(src.chat, 'unreadOnOpen', '分隔线按打开时的未读数定位');

  const attachSrc = await readFile(
    `${repoRoot}/packages/web/src/components/AttachmentBlocks.tsx`,
    'utf8',
  );
  includes(attachSrc, 'onPrev', '灯箱支持上一张');
  includes(attachSrc, 'onNext', '灯箱支持下一张');
  includes(attachSrc, "e.key === 'ArrowLeft'", '灯箱支持方向键');
  includes(attachSrc, 'position', '多图时显示 n/m');
  includes(src.bubble, 'zoomIndex', '同一消息的多张图共享灯箱状态');

  const mediaHook = await readFile(`${repoRoot}/packages/web/src/lib/useMediaQuery.ts`, 'utf8');
  includes(mediaHook, 'matchMedia', '窄屏用 matchMedia 检测');
  includes(mediaHook, '(max-width: 767px)', '断点 767px');
  includes(src.app, 'narrowShowChat', '窄屏单栏：选中会话只看聊天');
  includes(src.chat, 'onBack', '窄屏有返回按钮');

  section('B1d. 群信息编辑 / 会话右键菜单 / 侧栏拖拽');
  const dialogSrc = await readFile(
    `${repoRoot}/packages/web/src/components/GroupInfoDialog.tsx`,
    'utf8',
  );
  includes(dialogSrc, 'group.update', '群信息走协议 §5.2 的 group.update');
  includes(dialogSrc, '只有群主和管理员能修改', '无权限时有说明');
  includes(src.chat, '群信息', '聊天窗有群信息入口');
  includes(src.app, 'GroupInfoDialog', 'App 挂载群信息对话框');
  includes(src.app, 'saveGroupInfo', '保存走 client.call(group.update)');
  includes(src.list, '标记为已读', '会话右键菜单可标记已读');
  includes(src.list, '复制会话 ID', '会话右键菜单可复制 ID');
  includes(src.app, 'draggingSidebar', '侧栏可拖拽调宽');
  includes(src.local, 'loadSidebarWidth', '侧栏宽度被持久化');
  includes(src.local, 'SIDEBAR_MIN', '宽度有下限');

  section('B1e. 离线发件箱（用协议已有的 client_msg_id 幂等键）');
  const outboxSrc = await readFile(`${repoRoot}/packages/web/src/lib/outbox.ts`, 'utf8');
  includes(outboxSrc, 'clientMsgId', '发件箱按 client_msg_id 记录');
  includes(outboxSrc, 'MAX_ENTRIES', '发件箱有容量上限');
  const sendSrc = await readFile(`${repoRoot}/packages/web/src/lib/sendText.ts`, 'utf8');
  includes(sendSrc, 'goOffline', '断线走离线分支');
  includes(sendSrc, 'onOffline', '断线时回调上层入队');
  includes(sendSrc, 'isOnline', '断线时不撞发送超时');
  includes(src.app, 'enqueueOutbox', 'App 断线时入队');
  includes(src.app, 'flushOutbox', 'App 恢复连接后冲队列');
  includes(src.chat, '待发送', '气泡上有「待发送」标记');
  includes(src.chat, 'scrollToBottom', '发送后回到底部（否则虚拟滚动下看不到自己发的）');
  // 幂等键必须复用：断线重发用同一个 client_msg_id
  ok(
    /clientMsgId/.test(sendSrc),
    '重发复用同一个 client_msg_id（服务端按幂等键去重）',
  );

  section('B1f. 附件下载进度 / 减少动效 / 气泡键盘可达');
  const attach2 = await readFile(`${repoRoot}/packages/web/src/lib/attachments.ts`, 'utf8');
  includes(attach2, 'downloadAttachment', '有"点击下载"的实现（不预载文件）');
  includes(attach2, "xhr.onprogress", '下载也监听进度（fetch 读不了下载流）');
  const blocksSrc = await readFile(
    `${repoRoot}/packages/web/src/components/AttachmentBlocks.tsx`,
    'utf8',
  );
  includes(blocksSrc, '下载中', '文件卡片显示下载进度');
  includes(blocksSrc, "role=\"progressbar\"", '下载进度条有 progressbar 语义');

  const cssSrc = await readFile(`${repoRoot}/packages/web/src/styles.css`, 'utf8');
  includes(cssSrc, 'prefers-reduced-motion: reduce', 'CSS 尊重系统的"减少动效"设置');
  includes(cssSrc, 'animation-duration: 0.001ms', '减少动效时关掉动画');
  const mediaSrc = await readFile(`${repoRoot}/packages/web/src/lib/useMediaQuery.ts`, 'utf8');
  includes(mediaSrc, 'REDUCED_MOTION_QUERY', '有 reduced-motion 的查询常量');
  includes(src.chat, 'reducedMotion', '聊天窗平滑滚动会遵循设置');

  includes(src.bubble, 'onOpenMenuByKeyboard', '气泡支持键盘打开菜单');
  includes(src.bubble, 'role="article"', '气泡有 article 语义（读屏可定位）');
  includes(src.bubble, 'aria-label', '气泡带发送者与内容摘要');

  section('B1g. 失败可重试 + 气泡 ↑↓ 导航 + 按需加载');
  includes(blocksSrc, '重试下载', '下载失败后按钮变「重试」');
  includes(blocksSrc, 'reloadKey', '图片加载失败可重试');
  includes(src.chat, 'failedFiles', '上传失败保留文件以便重试');
  includes(src.chat, '重试（', '上传失败显示「重试（N）」');
  includes(src.chat, 'onMessageListKeyDown', '气泡之间可用 ↑↓ 移动焦点');
  includes(src.app, 'Suspense', '搜索面板按需加载（Suspense 兜底）');
  const excerptExists = await readFile(
    `${repoRoot}/packages/web/src/components/Excerpt.tsx`,
    'utf8',
  ).then(() => true).catch(() => false);
  ok(excerptExists, 'Excerpt 独立成模块（否则 SearchPanel 会被提升回主包）');

  section('B1h. 「正在输入」客户端一半（协议未扩，按 §12 降级）');
  const typingSrc = await readFile(`${repoRoot}/packages/web/src/lib/typing.ts`, 'utf8');
  includes(typingSrc, 'UNSUPPORTED_OP', '收到 UNSUPPORTED_OP 就停用（协议 §12 的降级语义）');
  includes(typingSrc, 'THROTTLE_MS', '打字节流有节流');
  includes(typingSrc, 'whoIsTyping', '有"谁在打字"的计算');
  includes(typingSrc, '3000', '打字提示 3 秒过期');
  includes(src.chat, '正在输入', '聊天窗头部显示"正在输入"');
  includes(src.app, 'reportTyping', 'App 在输入时上报');
  // 协议扩展已获批准并落地：typing.send 现在应当存在于协议包
  const opsSrc = await readFile(`${repoRoot}/packages/protocol/src/ops.ts`, 'utf8');
  ok(opsSrc.includes("'typing.send'"), '协议包已包含 typing.send（用户批准后新增）');

  section('B2. 本地状态不落库（避免误当服务端能力）');
  const protoOps = await readFile(`${repoRoot}/packages/protocol/src/ops.ts`, 'utf8');
  // 已批准并落地的扩展不在这个清单里（typing.send 见 B1h 的正向断言）
  for (const notAnOp of ['message.edit', 'reaction.add', 'message.pin', 'read.set', 'message.forward']) {
    ok(!protoOps.includes(notAnOp), `${notAnOp} 尚未加入协议（等下一批扩展）`);
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
  gte(Number(passed?.[1] ?? 0), 100, `web 单测通过 ${passed?.[1] ?? '?'} 项（≥100）`);

  a.close();
  b.close();
  b2.close();

  return summary('ui-ux');
}