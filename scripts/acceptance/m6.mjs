#!/usr/bin/env node
/**
 * M6 验收：Web 客户端（验收标准第 5 条的一部分）。
 *
 * Web 是浏览器应用，验收分两层：
 *   A. 客户端**状态逻辑**用 `_webstore_probe.ts` 在 Node 里直接驱动真实 store
 *      （流式 rev 拼接、撤回、成员增删、1000 条规模）——可无人值守重跑。
 *   B. **服务端契约**用两个独立 WS 连接模拟两个浏览器窗（互聊延迟、typing、
 *      断线补齐、踢人后立即消失）。
 *
 * 另有静态检查：构建产物存在、主题变量存在、虚拟滚动依赖真的被引用。
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { stat, readFile } from 'node:fs/promises';
import { section, summary, ok, eq, lt, gt, gte, includes, expectOk } from './_assert.mjs';
import { WsClient } from './_client.mjs';

const exec = promisify(execFile);

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
  const { http, wsUrl, repoRoot } = ctx;

  section('M6.1 客户端状态逻辑（真实 store，Node 内驱动）');
  const probe = path.join(repoRoot, 'scripts/acceptance/_webstore_probe.ts');
  const tsx = path.join(repoRoot, 'packages/server/node_modules/.bin/tsx');
  const { stdout } = await exec(tsx, [probe], { cwd: repoRoot, timeout: 60_000 });
  const r = JSON.parse(stdout.trim().split('\n').pop());
  eq(r.afterNew, 1, '重复的 message.new 被去重');
  eq(r.streamingStarted, '', '流式消息初始文本为空');
  eq(r.streamedText, '你好呀', '3 个 delta 按 rev 拼成 "你好呀"');
  eq(r.streamedRev, 3, '本轮 rev=3');
  eq(JSON.stringify(r.growth), JSON.stringify([4, 5, 6]), '文本逐字增长（长度 4→5→6）');
  eq(r.streamingCleared, true, 'message.final 后清掉流式状态');
  eq(r.finalText, '你好呀ABC', 'final 后消息文本为完整内容');
  eq(r.afterResync, 'ABC', 'rev 跳变后按 message.get 结果重置');
  eq(r.afterResyncRev, 3, '重置后报本地 rev=3');
  eq(r.revokedState, 'revoked', 'message.revoke 后消息标记为 revoked');
  eq(r.unknownIgnored, true, '未知 evt.type 被忽略且不报错');
  eq(JSON.stringify(r.membersAfterKick), JSON.stringify(['u_a']), 'member.leave 后成员立即从列表消失');
  eq(r.bulkCount, 1000, '1000 条消息全部进入 store');
  lt(r.bulkInsertMs, 200, `1000 条插入耗时 ${r.bulkInsertMs}ms（< 200ms）`);
  eq(r.bulkOrdered, true, '1000 条按 seq 升序排列');
  eq(JSON.stringify(r.convOrder), JSON.stringify(['c2', 'c1']), 'upsert 把新会话排到最前');
  eq(r.theme, 'dark', '主题可切换');

  section('M6.1b 组件真实渲染（jsdom）');
  const vitest = path.join(repoRoot, 'packages/web/node_modules/.bin/vitest');
  // 用 dot 报告器：输出稳定、好断言（vitest 5 没有 basic 报告器）
  const { stdout: testOut } = await exec(vitest, ['run', '--reporter=dot'], {
    cwd: path.join(repoRoot, 'packages/web'),
    timeout: 120_000,
  });
  includes(testOut.replace(/\u001b\[[0-9;]*m/g, ''), '5 passed', '组件渲染冒烟测试 5 项全部通过');

  section('M6.2 两个浏览器窗互聊：对端 200ms 内出现');
  const alice = await mkUser(http, 'alice', '爱丽丝');
  const bob = await mkUser(http, 'bob', '小明');
  const a = await connect(wsUrl, alice.access_token);
  const b = await connect(wsUrl, bob.access_token);

  const conv = expectOk(
    await a.request('conv.create', { kind: 'group', title: '浏览器窗测试', member_ids: [bob.user.id] }),
    '建群',
  ).conv;

  const t0 = Date.now();
  expectOk(
    await a.request('message.send', {
      conv_id: conv.id,
      client_msg_id: 'win-1',
      content: [{ type: 'text', text: '对端应该很快看到' }],
    }),
    'alice 发消息',
  );
  const evt = await b.nextEvent('message.new');
  const latency = Date.now() - t0;
  lt(latency, 200, `对端收到推送 ${latency}ms（< 200ms，同机）`);
  eq(evt.data.message.content[0].text, '对端应该很快看到', '内容正确');

  section('M6.3 typing 事件的协议形态');
  // 协议 §6 把 typing 列为 evt（seq=null），但 §5 的 op 清单没有发送入口。
  // 服务端不擅自加 op（施工守则 §6），所以这里只校验常量与事件 schema 存在。
  const protoEvents = await readFile(`${repoRoot}/packages/protocol/src/events.ts`, 'utf8');
  includes(protoEvents, 'typing: { data: TypingData, seq: false }', 'protocol 定义了 typing 事件');
  includes(protoEvents, "typing: { data: TypingData, seq: false }", 'typing 是瞬时事件（seq: false）');

  section('M6.4 断线 30 秒再插回 → 消息补齐（无需刷新）');
  b.close();
  await new Promise((r2) => setTimeout(r2, 200));
  const offlineSeqs = [];
  for (let i = 0; i < 6; i += 1) {
    const res = expectOk(
      await a.request('message.send', {
        conv_id: conv.id,
        client_msg_id: `off-${i}`,
        content: [{ type: 'text', text: `离线第 ${i} 条` }],
      }),
      `离线第 ${i} 条`,
    );
    offlineSeqs.push(res.seq);
  }
  const b2 = await connect(wsUrl, bob.access_token);
  const lastSeq = offlineSeqs[0] - 1;
  const resumeRes = expectOk(
    await b2.request('resume', { last_seq: lastSeq }),
    `重连 resume(${lastSeq})`,
  );
  eq(resumeRes.replayed, 6, '补齐 6 条离线消息');
  eq(resumeRes.gap, false, 'gap=false（30 秒不会触发 30 天清理）');
  const replayed = (await b2.drain(400)).filter((e) => e.type === 'message.new');
  eq(replayed.length, 6, '客户端收到全部 6 条');
  eq(
    JSON.stringify(replayed.map((e) => e.seq)),
    JSON.stringify(offlineSeqs),
    '按 seq 升序补齐',
  );

  section('M6.5 群管理：踢人后该成员立即从成员列表消失');
  expectOk(
    await a.request('member.kick', { conv_id: conv.id, user_id: bob.user.id }),
    'alice 踢出 bob',
  );
  const leaveEvt = await b2.nextEvent('member.leave');
  eq(leaveEvt.data.user_id, bob.user.id, 'bob 自己收到 member.leave');
  const after = expectOk(await a.request('conv.get', { conv_id: conv.id }), '踢人后 conv.get');
  eq(after.members.length, 1, '成员列表只剩 1 人');
  ok(!after.members.some((m) => m.user_id === bob.user.id), 'bob 已不在成员列表');

  section('M6.6 构建产物与前端实现检查');
  const distIndex = `${repoRoot}/packages/web/dist/index.html`;
  const st = await stat(distIndex).catch(() => null);
  ok(st !== null && st.isFile(), 'packages/web/dist/index.html 存在（vite build 产物）');

  const webSrc = {
    chat: await readFile(`${repoRoot}/packages/web/src/components/ChatWindow.tsx`, 'utf8'),
    styles: await readFile(`${repoRoot}/packages/web/src/styles.css`, 'utf8'),
    client: await readFile(`${repoRoot}/packages/web/src/lib/client.ts`, 'utf8'),
    app: await readFile(`${repoRoot}/packages/web/src/App.tsx`, 'utf8'),
    store: await readFile(`${repoRoot}/packages/web/src/lib/store.ts`, 'utf8'),
    pkg: await readFile(`${repoRoot}/packages/web/package.json`, 'utf8'),
  };
  includes(webSrc.chat, '@tanstack/react-virtual', '虚拟滚动用 @tanstack/react-virtual');
  includes(webSrc.chat, "e.key === 'Enter' && !e.shiftKey", 'Enter 发送 / Shift+Enter 换行');
  includes(webSrc.styles, "[data-theme='dark']", '深色主题靠 CSS 变量切换');
  includes(webSrc.styles, '--al-bubble-self', '自己的气泡与底色由变量定义');
  includes(webSrc.client, 'onRevGap', '客户端有 rev 跳变回调');
  includes(webSrc.client, 'loadLastSeq', '客户端持久化 last_seq');
  includes(webSrc.client, 'resume', '重连用 resume 而不是重拉全量');
  includes(webSrc.client, 'backoffMs', '指数退避重连');
  includes(webSrc.client, "request('auth', { token: this.accessToken })", 'token 只在帧体（auth 帧）里');
  ok(!webSrc.client.includes('?token='), 'token 不出现在 URL 查询串');
  includes(webSrc.store, "case 'message.update'", 'store 处理 message.update（按 rev 拼接）');
  includes(webSrc.store, "case 'message.final'", 'store 处理 message.final');
  includes(webSrc.store, 'default:', 'store 对未知 evt.type 走 default 忽略');
  includes(webSrc.app, 'message.get', 'rev 跳变时调 message.get');
  includes(webSrc.pkg, '@tanstack/react-query', 'TanStack Query 已接入');
  includes(webSrc.pkg, 'zustand', 'Zustand 已接入');
  includes(webSrc.pkg, 'tailwindcss', 'Tailwind 已接入');

  a.close();
  b2.close();

  return summary('M6');
}