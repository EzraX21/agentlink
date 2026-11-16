#!/usr/bin/env node
/**
 * M11 验收：插件钩子与多实例。
 *
 * 1. 钩子把消息里的 foo 改写成 bar，客户端收到的是 bar
 * 2. 钩子返回 null，消息不入库、不推送
 * 3. 同时跑两个 agent 实例，各自只收到自己订阅的事件
 * 4. 钩子未配置时行为不变（不启用 = 不改变任何东西）
 */
import path from 'node:path';
import { section, summary, ok, eq, gte, includes, expectOk } from './_assert.mjs';
import { WsClient } from './_client.mjs';
import { openDb, count } from './_db.mjs';

export const needsServer = true;
export const relaxedRateLimit = true;
/** 这个里程碑要带 HOOKS_MODULE 起服务。 */
export const serverEnv = {
  HOOKS_MODULE: 'hooks/example.mjs',
};

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

  const agent1 = await http('POST', '/api/admin/agents', {
    token: alice.access_token,
    body: { username: 'agent1', display_name: '助手一' },
  });
  const agent2 = await http('POST', '/api/admin/agents', {
    token: alice.access_token,
    body: { username: 'agent2', display_name: '助手二' },
  });

  const a = await connect(wsUrl, alice.access_token);
  const b = await connect(wsUrl, bob.access_token);
  const g1 = await connect(wsUrl, agent1.body.token);
  const g2 = await connect(wsUrl, agent2.body.token);

  const conv = expectOk(
    await a.request('conv.create', {
      kind: 'group',
      title: '钩子与多实例',
      member_ids: [bob.user.id, agent1.body.agent.id, agent2.body.agent.id],
    }),
    '建群（含两个 agent）',
  ).conv;

  section('M11.1 钩子把 foo 改写成 bar');
  expectOk(
    await a.request('message.send', {
      conv_id: conv.id,
      client_msg_id: 'hook-1',
      content: [{ type: 'text', text: '这是 foo 测试，foo 应该变 bar' }],
    }),
    '发一条含 foo 的消息',
  );
  const evt = await b.nextEvent('message.new');
  const received = evt.data.message.content[0].text;
  includes(received, 'bar', '客户端收到的是 bar');
  ok(!received.includes('foo'), '客户端收到的内容里没有 foo');
  eq(received, '这是 bar 测试，bar 应该变 bar', '改写结果与预期完全一致');

  const db = openDb(dbPath);
  const stored = db
    .prepare('SELECT text_plain FROM messages WHERE client_msg_id = ?')
    .get('hook-1');
  eq(stored.text_plain, '这是 bar 测试，bar 应该变 bar', '入库的也是改写后的内容');

  section('M11.2 钩子返回 null → 消息不入库、不推送');
  const before = count(db, 'SELECT count(*) FROM messages WHERE conv_id = ?', conv.id);
  const dropRes = expectOk(
    await a.request('message.send', {
      conv_id: conv.id,
      client_msg_id: 'hook-drop',
      content: [{ type: 'text', text: '这条会被钩子丢掉 [[DROP]]' }],
    }),
    '发一条会被丢弃的消息',
  );
  eq(dropRes.dropped, true, '响应标记 dropped=true');

  const drained = await b.drain(600);
  eq(
    drained.filter((e) => e.type === 'message.new').length,
    0,
    '没有推送 message.new',
  );
  const after = count(db, 'SELECT count(*) FROM messages WHERE conv_id = ?', conv.id);
  eq(after, before, '消息没有入库');
  eq(
    count(db, "SELECT count(*) FROM messages WHERE text_plain LIKE '%[[DROP]]%'"),
    0,
    '库里搜不到被丢弃的正文',
  );

  section('M11.3 多实例：两个 agent 各收各的');
  // 两个 agent 都订阅了（默认 only_mentions，这里都设为 true 由 SDK 风格控制）
  expectOk(
    await g1.request('subscribe.set', {
      filters: { conv_ids: [conv.id], only_mentions: true },
    }),
    'agent1 订阅本群 + 仅提及',
  );
  expectOk(
    await g2.request('subscribe.set', {
      filters: { conv_ids: [conv.id], only_mentions: true },
    }),
    'agent2 订阅本群 + 仅提及',
  );
  await g1.drain(200);
  await g2.drain(200);

  // 只 @agent1
  expectOk(
    await a.request('message.send', {
      conv_id: conv.id,
      client_msg_id: 'mention-1',
      content: [{ type: 'text', text: '@agent1 只叫你' }],
    }),
    '@agent1',
  );
  const e1 = await g1.nextEvent('message.new', 5000);
  ok(e1 !== undefined, 'agent1 收到事件');
  const g2Events = await g2.drain(600);
  eq(g2Events.filter((e) => e.type === 'message.new').length, 0, 'agent2 收不到（订阅过滤生效）');

  // 只 @agent2
  expectOk(
    await a.request('message.send', {
      conv_id: conv.id,
      client_msg_id: 'mention-2',
      content: [{ type: 'text', text: '@agent2 只叫你' }],
    }),
    '@agent2',
  );
  const e2 = await g2.nextEvent('message.new', 5000);
  ok(e2 !== undefined, 'agent2 收到事件');
  const g1Events = await g1.drain(600);
  eq(g1Events.filter((e) => e.type === 'message.new').length, 0, 'agent1 收不到');

  // 两个都 @
  expectOk(
    await a.request('message.send', {
      conv_id: conv.id,
      client_msg_id: 'mention-both',
      content: [{ type: 'text', text: '@agent1 @agent2 都叫你们' }],
    }),
    '@两个 agent',
  );
  const both1 = await g1.nextEvent('message.new', 5000);
  const both2 = await g2.nextEvent('message.new', 5000);
  ok(both1 !== undefined && both2 !== undefined, '两个 agent 都收到');

  section('M11.4 两个 agent 各自独立回复（互不影响）');
  const s1 = expectOk(
    await g1.request('stream.begin', { conv_id: conv.id, client_msg_id: 'a1-stream' }),
    'agent1 开流',
  );
  expectOk(
    await g1.request('stream.delta', {
      conv_id: conv.id,
      message_id: s1.message_id,
      delta: '我是 agent1',
    }),
    'agent1 写 delta',
  );
  const s2 = expectOk(
    await g2.request('stream.begin', { conv_id: conv.id, client_msg_id: 'a2-stream' }),
    'agent2 开流',
  );
  expectOk(
    await g2.request('stream.delta', {
      conv_id: conv.id,
      message_id: s2.message_id,
      delta: '我是 agent2',
    }),
    'agent2 写 delta',
  );

  // 交叉写应该被拒
  const crossWrite = await g1.request('stream.delta', {
    conv_id: conv.id,
    message_id: s2.message_id,
    delta: 'agent1 想写 agent2 的流',
  });
  ok(crossWrite.ok === false, 'agent1 不能写 agent2 的流');

  expectOk(
    await g1.request('stream.commit', { conv_id: conv.id, message_id: s1.message_id }),
    'agent1 commit',
  );
  expectOk(
    await g2.request('stream.commit', { conv_id: conv.id, message_id: s2.message_id }),
    'agent2 commit',
  );

  const finals = db
    .prepare(
      "SELECT sender_id, text_plain FROM messages WHERE client_msg_id IN ('a1-stream','a2-stream') ORDER BY text_plain",
    )
    .all();
  eq(finals.length, 2, '两条流式消息都入库');
  eq(finals[0].text_plain, '我是 agent1', 'agent1 的内容正确');
  eq(finals[1].text_plain, '我是 agent2', 'agent2 的内容正确');
  ok(finals[0].sender_id !== finals[1].sender_id, '两条消息的发送者不同');

  section('M11.5 钩子模块配置检查');
  const hooksSrc = await ctx.readFile(`${ctx.repoRoot}/hooks/example.mjs`, 'utf8');
  includes(hooksSrc, 'onMessageIn', '示例钩子导出 onMessageIn');
  includes(hooksSrc, 'onMessageOut', '示例钩子导出 onMessageOut');
  includes(hooksSrc, 'return null', '示例钩子演示"返回 null 丢弃"');

  const cfgSrc = await ctx.readFile(`${ctx.repoRoot}/packages/server/src/config.ts`, 'utf8');
  includes(cfgSrc, 'HOOKS_MODULE', '配置支持 HOOKS_MODULE 环境变量');

  db.close();
  a.close();
  b.close();
  g1.close();
  g2.close();

  return summary('M11');
}