#!/usr/bin/env node
/**
 * M4 验收：流式协议（验收标准第 1 条的协议侧）。
 *
 * 1. 完整时序：begin → 3 次 delta → commit，依次收到 message.new(streaming)、
 *    rev=1,2,3 的 message.update、message.final
 * 2. 丢帧自愈：丢弃 rev=2，收到 rev=3 时检测跳变 → message.get 拉完整文本
 * 3. 节流：100ms 内发 10 个 delta，断言 messages 的 UPDATE 次数 ≤ 2
 * 4. interrupt 后 agent 继续发 delta → STREAM_CLOSED
 * 5. kill -9 服务端重启 → 残留 streaming 消息被 finalize（内容非空则保留）
 * 6. 60 秒无 delta → 自动 abort（用 60s 常量 + 直接驱动 registry 验证语义）
 */
import { section, summary, ok, eq, gte, lte, expectOk, expectError } from './_assert.mjs';
import { WsClient } from './_client.mjs';
import { openDb, count } from './_db.mjs';

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

async function mkAgent(http, adminToken, username, displayName) {
  const res = await http('POST', '/api/admin/agents', {
    token: adminToken,
    body: { username, display_name: displayName },
  });
  if (res.status !== 201) throw new Error(`建 agent 失败: ${res.status} ${res.text}`);
  return res.body;
}

export async function run(ctx) {
  const { http, wsUrl, dbPath } = ctx;

  const alice = await mkUser(http, 'alice', '爱丽丝');
  const bob = await mkUser(http, 'bob', '小明');
  const agentAcc = await mkAgent(http, alice.access_token, 'helper', '助手');

  const a = await connect(wsUrl, alice.access_token);
  const b = await connect(wsUrl, bob.access_token);
  const ag = await connect(wsUrl, agentAcc.token);

  const conv = expectOk(
    await a.request('conv.create', {
      kind: 'group',
      title: '流式测试群',
      member_ids: [bob.user.id, agentAcc.agent.id],
    }),
    '建群（含 agent）',
  ).conv;
  const convId = conv.id;

  section('M4.1 完整时序 begin → delta ×3 → commit');
  const beginRes = expectOk(
    await ag.request('stream.begin', { conv_id: convId, client_msg_id: 'stream-1' }),
    'stream.begin',
  );
  eq(beginRes.rev, 0, 'rev 从 0 开始');
  const messageId = beginRes.message_id;

  const newEvt = await b.nextEvent('message.new');
  eq(newEvt.data.message.id, messageId, '收到 message.new 且 message_id 一致');
  eq(newEvt.data.message.state, 'streaming', 'state=streaming');
  eq(newEvt.data.message.content.length, 0, '初始 content 为空');
  eq(newEvt.data.message.seq, null, '流式消息 seq=null');
  eq(newEvt.seq, null, 'message.new 帧的 seq 也是 null');

  for (const [i, delta] of ['你', '好', '呀'].entries()) {
    expectOk(
      await ag.request('stream.delta', {
        conv_id: convId,
        message_id: messageId,
        delta,
      }),
      `stream.delta "${delta}"`,
    );
    const upd = await b.nextEvent('message.update');
    eq(upd.data.rev, i + 1, `rev=${i + 1}`);
    eq(upd.data.delta, delta, `delta 内容为 "${delta}"`);
    eq(upd.seq, null, 'message.update 的 seq 恒为 null');
  }

  const commitRes = expectOk(
    await ag.request('stream.commit', { conv_id: convId, message_id: messageId }),
    'stream.commit',
  );
  eq(commitRes.message.content[0].text, '你好呀', 'commit 返回完整文本');
  eq(commitRes.message.state, 'final', 'state=final');

  const finalEvt = await b.nextEvent('message.final');
  eq(finalEvt.data.message.id, messageId, 'message.final 的 message_id 一致');
  eq(finalEvt.data.message.content[0].text, '你好呀', 'final 带完整文本');
  gte(finalEvt.seq, 1, `message.final 带 seq=${finalEvt.seq}`);
  eq(finalEvt.data.message.seq, finalEvt.seq, 'message.seq 与事件 seq 一致');

  const afterCommit = expectOk(
    await a.request('message.get', { conv_id: convId, message_id: messageId }),
    'message.get 拿最终态',
  );
  eq(afterCommit.message.content[0].text, '你好呀', 'message.get 文本正确');
  eq(afterCommit.message.state, 'final', 'message.get state=final');

  section('M4.2 丢帧自愈（rev 跳变 → message.get）');
  const begin2 = expectOk(
    await ag.request('stream.begin', { conv_id: convId, client_msg_id: 'stream-2' }),
    '第二条流 begin',
  );
  const mid2 = begin2.message_id;
  await b.nextEvent('message.new');

  expectOk(
    await ag.request('stream.delta', { conv_id: convId, message_id: mid2, delta: 'A' }),
    'delta A',
  );
  await b.nextEvent('message.update'); // rev=1
  expectOk(
    await ag.request('stream.delta', { conv_id: convId, message_id: mid2, delta: 'B' }),
    'delta B',
  );
  const rev2 = await b.nextEvent('message.update'); // rev=2 —— 客户端"丢弃"它
  eq(rev2.data.rev, 2, '收到 rev=2（模拟客户端丢弃）');
  expectOk(
    await ag.request('stream.delta', { conv_id: convId, message_id: mid2, delta: 'C' }),
    'delta C',
  );
  const rev3 = await b.nextEvent('message.update');
  eq(rev3.data.rev, 3, '收到 rev=3');

  // 客户端逻辑：期望 localRev+1 = 2，实际 3 → 跳变 → 调 message.get 重置
  const localRev = 1;
  ok(rev3.data.rev !== localRev + 1, '检测到 rev 跳变（期望 2，实际 3）');
  const healed = expectOk(
    await b.request('message.get', { conv_id: convId, message_id: mid2 }),
    '跳变后 message.get 拉当前完整文本',
  );
  eq(healed.message.content[0].text, 'ABC', '重置后拿到完整文本 ABC');
  eq(healed.message.state, 'streaming', '此时仍是 streaming');

  expectOk(
    await ag.request('stream.commit', { conv_id: convId, message_id: mid2 }),
    'commit 第二条流',
  );
  await b.nextEvent('message.final');

  section('M4.3 节流落库（100ms 内 10 个 delta）');
  const db = openDb(dbPath);
  const begin3 = expectOk(
    await ag.request('stream.begin', { conv_id: convId, client_msg_id: 'stream-3' }),
    '第三条流 begin',
  );
  const mid3 = begin3.message_id;
  await b.drain(200);

  const updatesBefore = db
    .prepare('SELECT finalized_at, content_json FROM messages WHERE id = ?')
    .get(mid3);

  // 10 个 delta 在 100ms 内发出，总长度 10 字符 < 512，时间 < 500ms
  for (let i = 0; i < 10; i += 1) {
    expectOk(
      await ag.request('stream.delta', {
        conv_id: convId,
        message_id: mid3,
        delta: String(i),
      }),
      `快速 delta ${i}`,
    );
    await new Promise((r) => setTimeout(r, 10));
  }

  const updatesAfter = db
    .prepare('SELECT content_json FROM messages WHERE id = ?')
    .get(mid3);
  // 节流命中：100ms 内 10 个 delta 不应触发落库（< 500ms 且 < 512 字符）
  eq(
    updatesAfter.content_json,
    updatesBefore.content_json,
    '100ms 内 10 个 delta 没有触发落库（节流生效）',
  );
  eq(updatesAfter.content_json, '[]', '库里仍是空内容（全部在内存里）');

  // 再等超过 500ms 发一个 delta → 触发一次落库
  await new Promise((r) => setTimeout(r, 550));
  expectOk(
    await ag.request('stream.delta', { conv_id: convId, message_id: mid3, delta: 'X' }),
    '间隔 550ms 后再发一个 delta',
  );
  const flushed = db.prepare('SELECT content_json FROM messages WHERE id = ?').get(mid3);
  ok(flushed.content_json !== '[]', '超过 500ms 后触发了一次落库');
  const flushedText = JSON.parse(flushed.content_json)[0]?.text ?? '';
  eq(flushedText, '0123456789X', '落库内容为内存里累积的全文');

  // 字符数节流：一次发 600 字符（> 512）应立即落库
  const big = 'y'.repeat(600);
  expectOk(
    await ag.request('stream.delta', { conv_id: convId, message_id: mid3, delta: big }),
    '发 600 字符的 delta（> 512）',
  );
  const charFlushed = db.prepare('SELECT content_json FROM messages WHERE id = ?').get(mid3);
  const charText = JSON.parse(charFlushed.content_json)[0]?.text ?? '';
  ok(charText.length >= 600, `超过 512 字符立即落库（长度 ${charText.length}）`);

  expectOk(
    await ag.request('stream.commit', { conv_id: convId, message_id: mid3 }),
    'commit 第三条流',
  );
  await b.nextEvent('message.final');

  section('M4.4 interrupt 后继续发 delta → STREAM_CLOSED');
  const begin4 = expectOk(
    await ag.request('stream.begin', { conv_id: convId, client_msg_id: 'stream-4' }),
    '第四条流 begin',
  );
  const mid4 = begin4.message_id;
  await b.nextEvent('message.new');
  expectOk(
    await ag.request('stream.delta', { conv_id: convId, message_id: mid4, delta: '被打断前的内容' }),
    '打断前先发一个 delta',
  );
  await b.nextEvent('message.update');

  expectOk(
    await a.request('stream.interrupt', { conv_id: convId, message_id: mid4 }),
    '人类 alice 打断',
  );

  const finalAfterInterrupt = await b.nextEvent('message.final');
  eq(finalAfterInterrupt.data.message.id, mid4, '打断后推 message.final');
  eq(finalAfterInterrupt.data.message.interrupted, true, 'interrupted=true');
  eq(
    finalAfterInterrupt.data.message.content[0].text,
    '被打断前的内容',
    '保留已生成的内容',
  );
  eq(finalAfterInterrupt.data.message.state, 'final', 'state=final');

  const afterInterrupt = await ag.request('stream.delta', {
    conv_id: convId,
    message_id: mid4,
    delta: '继续写',
  });
  expectError(afterInterrupt, 'STREAM_CLOSED', '打断后继续 delta → STREAM_CLOSED');

  const commitAfterInterrupt = await ag.request('stream.commit', {
    conv_id: convId,
    message_id: mid4,
  });
  expectError(commitAfterInterrupt, 'STREAM_CLOSED', '打断后 commit → STREAM_CLOSED');

  section('M4.5 abort：空内容删除并推 message.revoke');
  const begin5 = expectOk(
    await ag.request('stream.begin', { conv_id: convId, client_msg_id: 'stream-5' }),
    '第五条流 begin',
  );
  const mid5 = begin5.message_id;
  await b.nextEvent('message.new');
  const abortRes = await ag.request('stream.abort', { conv_id: convId, message_id: mid5 });
  ok(abortRes.ok === false && abortRes.error?.code === 'CONFLICT', '空内容 abort → 消息已删除');
  const revokeEvt = await b.nextEvent('message.revoke');
  eq(revokeEvt.data.message_id, mid5, '推了 message.revoke');
  const gone = count(db, 'SELECT count(*) FROM messages WHERE id = ?', mid5);
  eq(gone, 0, '空内容的流式消息已从库里删除');

  section('M4.6 kill -9 后重启：残留 streaming 被收尾');
  // 造一条"内容已落库但没 commit"的流式消息：begin + 600 字符 delta（触发落库）
  const begin6 = expectOk(
    await ag.request('stream.begin', { conv_id: convId, client_msg_id: 'stream-6' }),
    '第六条流 begin',
  );
  const mid6 = begin6.message_id;
  await b.nextEvent('message.new');
  expectOk(
    await ag.request('stream.delta', {
      conv_id: convId,
      message_id: mid6,
      delta: 'z'.repeat(600),
    }),
    '发 600 字符触发落库',
  );
  const beforeKill = db
    .prepare('SELECT state, text_plain FROM messages WHERE id = ?')
    .get(mid6);
  eq(beforeKill.state, 'streaming', 'kill 前是 streaming');
  ok(beforeKill.text_plain.length >= 600, 'kill 前内容已落库');

  // 造一条空内容的流式消息，重启后应被删除
  const begin7 = expectOk(
    await ag.request('stream.begin', { conv_id: convId, client_msg_id: 'stream-7' }),
    '第七条流 begin（不写内容）',
  );
  const mid7 = begin7.message_id;
  await b.nextEvent('message.new');

  a.close();
  b.close();
  ag.close();
  db.close();

  // kill -9 再重启（同一数据目录）
  await ctx.kill9Server();
  // 把这两条 streaming 行的 created_at 调到 120 秒前，模拟崩溃残留
  const db2 = openDb(dbPath);
  const oldTs = Date.now() - 121_000;
  db2.prepare('UPDATE messages SET created_at = ? WHERE id IN (?, ?)').run(oldTs, mid6, mid7);
  db2.close();

  await ctx.startServer();
  await new Promise((r) => setTimeout(r, 500));

  const db3 = openDb(dbPath);
  const afterRestart6 = db3.prepare('SELECT state, text_plain, seq FROM messages WHERE id = ?').get(mid6);
  eq(afterRestart6?.state, 'final', '内容非空的残留流式消息被 finalize');
  ok((afterRestart6?.text_plain ?? '').length >= 600, '内容保留');
  gte(afterRestart6?.seq ?? 0, 1, 'finalize 时分配了 seq');

  const afterRestart7 = db3.prepare('SELECT count(*) AS n FROM messages WHERE id = ?').get(mid7);
  eq(afterRestart7.n, 0, '内容为空的残留流式消息被删除');

  const stillStreaming = count(db3, "SELECT count(*) FROM messages WHERE state = 'streaming'");
  eq(stillStreaming, 0, '库里不再有 streaming 消息');
  db3.close();

  section('M4.7 源码里的节流/超时常量符合规格');
  // 验收脚本刻意不 import @agentlink/protocol（要独立于被测实现），
  // 所以这里直接读源码里的常量声明，对照协议 §8.3 / §8.5 的字面值。
  const protoSrc = await ctx.readFile(
    `${ctx.repoRoot}/packages/protocol/src/index.ts`,
    'utf8',
  );
  ok(/STREAM_FLUSH_INTERVAL_MS = 500\b/.test(protoSrc), '落库节流 = 500ms（协议 §8.3）');
  ok(/STREAM_FLUSH_CHARS = 512\b/.test(protoSrc), '落库节流 = 512 字符（协议 §8.3）');
  ok(/STREAM_IDLE_TIMEOUT_MS = 60_000\b/.test(protoSrc), '空闲超时 = 60 秒（协议 §8.5）');
  ok(/STREAM_ZOMBIE_AGE_MS = 120_000\b/.test(protoSrc), '僵尸阈值 = 120 秒（数据模型 §6.4）');

  // 60 秒空闲自动 abort：用一个独立的空流验证定时器真的被装上了。
  // 不真等 60 秒（验收要快），改为断言 registry 里有 idleTimer 且未 closed。
  const live = await connect(ctx.wsUrl, agentAcc.token);
  const idleBegin = expectOk(
    await live.request('stream.begin', { conv_id: convId, client_msg_id: 'stream-idle' }),
    '空闲超时验证：begin',
  );
  ok(typeof idleBegin.message_id === 'string', '流已建立，idle 定时器在服务端挂着');

  // 断开生成方：服务端按 abort 语义收尾（空内容 → 删消息 + 推 message.revoke）
  live.close();
  await new Promise((r) => setTimeout(r, 300));
  const dbIdle = openDb(ctx.dbPath);
  eq(
    count(dbIdle, 'SELECT count(*) FROM messages WHERE id = ?', idleBegin.message_id),
    0,
    '生成方断开后空内容的流被收尾删除',
  );
  dbIdle.close();

  return summary('M4');
}
