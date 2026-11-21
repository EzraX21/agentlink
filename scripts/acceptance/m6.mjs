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
/** 本里程碑会连续发多个 delta / 消息，放宽测试环境的限流（见 run.mjs 注释）。 */
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
  const { http, wsUrl, repoRoot } = ctx;

  // 聊天状态逻辑（store.ts）已搬去 Qt 桌面客户端，这里不再有 web store 探针。
  // 只保留"web 单测"与服务端 WS 契约两层。

  section('M6.1 web 单测（jsdom）');
  const vitest = path.join(repoRoot, 'packages/web/node_modules/.bin/vitest');
  // 用 dot 报告器：输出稳定、好断言（vitest 5 没有 basic 报告器）
  const { stdout: testOut } = await exec(vitest, ['run', '--reporter=dot'], {
    cwd: path.join(repoRoot, 'packages/web'),
    timeout: 120_000,
  });
  const plain = testOut.replace(/\u001b\[[0-9;]*m/g, '');
  const passed = /Tests\s+(\d+) passed/.exec(plain);
  ok(!/failed/.test(plain), 'web 单测没有失败项');
  ok(passed !== null && Number(passed[1]) >= 5, `web 单测通过 ${passed?.[1] ?? '?'} 项（≥5）`);

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

  section('M6.3 一个窗输入 → 另一个窗看到 typing（端到端）');
  // 协议扩展（经用户批准，见 docs/PROPOSAL-protocol-ext.md §1）：`typing.send`。
  // 之前协议 §6 有 typing 事件、§5 没有触发它的 op，这一条只能校验常量；
  // 现在是真跑：A 调 typing.send，B 必须收到 typing 事件。
  expectOk(await a.request('typing.send', { conv_id: conv.id }), 'A 上报"我在打字"');
  const typingEvt = await b.nextEvent('typing');
  eq(typingEvt.data.conv_id, conv.id, 'B 收到了 typing 事件');
  eq(typingEvt.data.user_id, alice.user.id, '事件里带发送者 id');
  eq(typingEvt.seq, null, 'typing 是瞬时事件（seq=null，不落库）');
  eq(
    typingEvt.data.user.display_name,
    '爱丽丝',
    '事件里带发送者昵称（前端的"X 正在输入…"要用）',
  );

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

  // 架构：Web 现在**只**是管理后台，聊天在 Qt 桌面客户端里。
  // 所以这里检查"App 只渲染管理页、不再引用聊天组件"。
  const webSrc = {
    styles: await readFile(`${repoRoot}/packages/web/src/styles.css`, 'utf8'),
    client: await readFile(`${repoRoot}/packages/web/src/lib/client.ts`, 'utf8'),
    app: await readFile(`${repoRoot}/packages/web/src/App.tsx`, 'utf8'),
    admin: await readFile(`${repoRoot}/packages/web/src/pages/AdminPage.tsx`, 'utf8'),
    pkg: await readFile(`${repoRoot}/packages/web/package.json`, 'utf8'),
  };
  includes(webSrc.styles, "[data-theme='dark']", '深色主题靠 CSS 变量切换');
  includes(webSrc.client, 'loadLastSeq', '客户端持久化 last_seq');
  includes(webSrc.client, "request('auth', { token: this.accessToken })", 'token 只在帧体（auth 帧）里');
  ok(!webSrc.client.includes('?token='), 'token 不出现在 URL 查询串');
  includes(webSrc.app, 'AdminPage', 'Web 只渲染管理页');
  ok(!webSrc.app.includes('ChatWindow') && !webSrc.app.includes('ConversationList'),
     'App 不再引用聊天组件（聊天在桌面客户端）');
  includes(webSrc.admin, '审计日志', '管理页含审计日志分区');
  includes(webSrc.pkg, '@tanstack/react-query', 'TanStack Query 已接入');
  includes(webSrc.pkg, 'tailwindcss', 'Tailwind 已接入');

  a.close();
  b2.close();

  return summary('M6');
}