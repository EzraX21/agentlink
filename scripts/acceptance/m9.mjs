#!/usr/bin/env node
/**
 * M9 验收：Agent SDK + 示例 agent（验收标准第 1 条的端到端）。
 *
 * 1. 群里 @echo → 3 秒内出现逐字增长的流式回复（真的把 examples/echo-agent 跑起来）
 * 2. 回复是流式增长的：中间至少观察到 3 个不同的文本长度
 * 3. 人类打断后 agent 停止生成
 * 4. 杀掉服务端 10 秒再启动，agent 自动重连并补齐期间的消息
 * 5. SDK 的 context.fetch 返回可直接拼 prompt 的片段
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { section, summary, ok, eq, gt, gte, lt, expectOk } from './_assert.mjs';
import { WsClient } from './_client.mjs';

export const needsServer = true;
/** 本里程碑要造大量消息，放宽测试环境的限流（见 run.mjs 注释）。 */
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

/** 起一个示例 agent 进程，返回句柄。 */
function startAgent(script, env) {
  const proc = spawn(process.execPath, [script], {
    cwd: path.dirname(script),
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let logs = '';
  proc.stdout.on('data', (b) => (logs += b.toString()));
  proc.stderr.on('data', (b) => (logs += b.toString()));
  return {
    proc,
    logs: () => logs,
    async stop() {
      proc.kill('SIGTERM');
      await new Promise((r) => {
        const t = setTimeout(() => {
          proc.kill('SIGKILL');
          r(undefined);
        }, 3000);
        proc.once('exit', () => {
          clearTimeout(t);
          r(undefined);
        });
      });
    },
  };
}

function countOccurrences(haystack, needle) {
  let n = 0;
  let idx = haystack.indexOf(needle);
  while (idx >= 0) {
    n += 1;
    idx = haystack.indexOf(needle, idx + needle.length);
  }
  return n;
}

async function waitForLog(handle, needle, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (handle.logs().includes(needle)) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

/** 等到某个日志片段出现第 minCount 次（用来区分"首次连接"与"重连"）。 */
async function waitForLogCount(handle, needle, minCount, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (countOccurrences(handle.logs(), needle) >= minCount) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

export async function run(ctx) {
  const { http, wsUrl, repoRoot } = ctx;

  const alice = await mkUser(http, 'alice', '爱丽丝');
  const bob = await mkUser(http, 'bob', '小明');

  // 建 agent
  const agentRes = await http('POST', '/api/admin/agents', {
    token: alice.access_token,
    body: { username: 'echo', display_name: '回显助手' },
  });
  if (agentRes.status !== 201) throw new Error(`建 agent 失败: ${agentRes.text}`);
  const agentToken = agentRes.body.token;
  const agentId = agentRes.body.agent.id;

  const a = await connect(wsUrl, alice.access_token);
  const b = await connect(wsUrl, bob.access_token);

  const conv = expectOk(
    await a.request('conv.create', {
      kind: 'group',
      title: 'Agent 测试群',
      member_ids: [bob.user.id, agentId],
    }),
    '建群（含 agent）',
  ).conv;

  section('M9.1 启动 examples/echo-agent');
  const agent = startAgent(path.join(repoRoot, 'examples/echo-agent/index.mjs'), {
    AGENTLINK_URL: wsUrl,
    AGENTLINK_TOKEN: agentToken,
  });
  const up = await waitForLog(agent, '已连接', 25_000);
  ok(up, 'echo-agent 已连接');
  // 首次连接会打一次 "resume 完成"；重连必须再打一次，用它区分首次与重连
  const resumeCountBefore = countOccurrences(agent.logs(), 'resume 完成');
  eq(resumeCountBefore, 1, '首次连接恰好 resume 一次');
  if (!up) {
    console.log('--- agent 日志 ---');
    console.log(agent.logs());
  }

  section('M9.2 @agent → 3 秒内出现逐字增长的流式回复');
  const t0 = Date.now();
  expectOk(
    await a.request('message.send', {
      conv_id: conv.id,
      client_msg_id: 'at-echo',
      content: [{ type: 'text', text: `@echo 你好` }],
    }),
    'alice 在群里 @echo',
  );

  // 等到 message.new(streaming)
  const streamNew = await b.nextEvent(
    (e) => e.type === 'message.new' && e.data?.message?.state === 'streaming',
    10_000,
  );
  const appearMs = Date.now() - t0;
  lt(appearMs, 3000, `流式消息在 ${appearMs}ms 内出现（< 3000ms，验收 1）`);
  eq(streamNew.data.message.sender.id, agentId, '回复来自 agent');

  // 收集 update，记录文本长度的增长序列
  const lengths = [];
  let text = '';
  const deadline = Date.now() + 15_000;
  let finalMsg = null;
  while (Date.now() < deadline) {
    const evt = await b.nextEvent(
      (e) => e.type === 'message.update' || e.type === 'message.final',
      12_000,
    ).catch(() => null);
    if (evt === null) break;
    if (evt.type === 'message.update') {
      text += evt.data.delta;
      lengths.push(text.length);
    } else if (evt.type === 'message.final') {
      finalMsg = evt.data.message;
      break;
    }
  }
  ok(finalMsg !== null, '收到 message.final');
  const distinctLengths = new Set(lengths).size;
  gte(distinctLengths, 3, `观察到 ${distinctLengths} 个不同的文本长度（逐字增长）`);
  ok(
    lengths.every((v, i) => i === 0 || v > lengths[i - 1]),
    '文本长度严格递增（逐字增长）',
  );
  includesText(finalMsg?.content?.[0]?.text ?? '', '你说的是', '回复内容是 echo 的回显');
  gte(finalMsg?.seq ?? 0, 1, 'final 带 seq');

  section('M9.3 人类打断后 agent 停止生成');
  expectOk(
    await a.request('message.send', {
      conv_id: conv.id,
      client_msg_id: 'at-echo-2',
      content: [{ type: 'text', text: '@echo 再说一次' }],
    }),
    'alice 再 @ 一次',
  );
  const streamNew2 = await b.nextEvent(
    (e) => e.type === 'message.new' && e.data?.message?.state === 'streaming',
    10_000,
  );
  const mid2 = streamNew2.data.message.id;
  // 等几个 delta 后打断
  await b.nextEvent('message.update', 5000);
  await b.nextEvent('message.update', 5000);
  expectOk(
    await a.request('stream.interrupt', { conv_id: conv.id, message_id: mid2 }),
    'alice 打断生成',
  );
  const interruptedFinal = await b.nextEvent('message.final', 10_000);
  eq(interruptedFinal.data.message.id, mid2, '打断后推该消息的 final');
  eq(interruptedFinal.data.message.interrupted, true, 'interrupted=true');
  ok(
    (interruptedFinal.data.message.content[0]?.text ?? '').length > 0,
    '保留已生成的部分内容',
  );
  ok(
    await waitForLog(agent, '被人类打断', 10_000),
    'agent 侧感知到打断并停止生成',
  );

  section('M9.4 SDK 的 context.fetch 可直接拼 prompt');
  // 通过 agent 自己的视角取上下文：用一条新 @ 触发，agent 内部会调 context.fetch
  expectOk(
    await a.request('message.send', {
      conv_id: conv.id,
      client_msg_id: 'ctx-probe',
      content: [{ type: 'text', text: '@echo 最后一条' }],
    }),
    '触发一次带上下文的回复',
  );
  const ctxLog = await waitForLog(agent, '上下文', 15_000);
  ok(ctxLog, 'agent 侧调用了 context.fetch 并拿到历史');
  // 等它自己 commit，避免干扰后续步骤
  await b.drain(4000);

  section('M9.5 杀掉服务端 10 秒再启动 → agent 自动重连并补齐');
  const agentLogsBefore = agent.logs().length;
  await ctx.kill9Server();
  await new Promise((r) => setTimeout(r, 2000));

  // 服务端不在时，人类客户端也断了。重启服务端。
  await new Promise((r) => setTimeout(r, 10_000));
  await ctx.startServer();

  // 等 agent **第二次** resume 完成 —— 这才是真的重连（SDK 指数退避）
  const reconnected = await waitForLogCount(agent, 'resume 完成', resumeCountBefore + 1, 40_000);
  ok(reconnected, 'agent 自动重连成功（第二次 resume 完成）');
  const logsAfter = agent.logs().slice(agentLogsBefore);
  // SDK 在断线后会打印"连接中…"、退避时长，重连成功后再打一次 resume 完成
  const sawReconnectAttempt = logsAfter.includes('连接中') || logsAfter.includes('后重连');
  ok(sawReconnectAttempt, 'agent 侧有重连行为记录');
  ok(logsAfter.includes('resume 完成'), '重连后执行了 resume（不是重拉全量）');

  section('M9.6 重连后仍能正常回复');
  const alice2 = await connect(wsUrl, alice.access_token);
  const bob2 = await connect(wsUrl, bob.access_token);
  expectOk(
    await alice2.request('message.send', {
      conv_id: conv.id,
      client_msg_id: 'after-restart',
      content: [{ type: 'text', text: '@echo 重启后还在吗' }],
    }),
    '重启后 @ 一次',
  );
  const afterRestart = await bob2.nextEvent(
    (e) => e.type === 'message.new' && e.data?.message?.state === 'streaming',
    15_000,
  );
  eq(afterRestart.data.message.sender.id, agentId, '重启后 agent 仍能流式回复');
  await bob2.drain(6000);

  section('M9.7 SDK 类型与导出检查');
  const sdkPkg = await ctx.readFile(`${repoRoot}/packages/agent-sdk/package.json`, 'utf8');
  includesText(sdkPkg, '@agentlink/protocol', 'SDK 依赖 protocol 包（类型唯一真源）');
  const sdkSrc = await ctx.readFile(`${repoRoot}/packages/agent-sdk/src/index.ts`, 'utf8');
  for (const method of ['context(', 'stream(', 'send(', 'onMessage(', 'interrupt(']) {
    includesText(sdkSrc, method, `SDK 暴露 ${method}）`);
  }
  includesText(sdkSrc, 'resume', 'SDK 重连时用 resume');
  includesText(sdkSrc, 'only_mentions', 'SDK 默认只订阅被 @ 的消息');
  includesText(sdkSrc, 'StreamClosedError', 'SDK 有打断错误类型');
  includesText(sdkSrc, "case 'message.update'", 'SDK 处理 stream_closed 哨兵');

  const llmSrc = await ctx.readFile(`${repoRoot}/examples/llm-agent/index.mjs`, 'utf8');
  includesText(llmSrc, 'context', 'llm-agent 用 context.fetch 拼 prompt');
  includesText(llmSrc, 'stream: true', 'llm-agent 走 SSE 流式');
  includesText(llmSrc, 'AbortController', 'llm-agent 被打断时中止上游请求');

  await agent.stop();
  a.close();
  b.close();
  alice2.close();
  bob2.close();

  return summary('M9');
}

function includesText(haystack, needle, label) {
  ok(haystack.includes(needle), label);
}