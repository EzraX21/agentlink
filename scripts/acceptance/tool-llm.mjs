#!/usr/bin/env node
/**
 * tool-llm 验收：四象限工具权限接到真 LLM 的 function-calling 上。
 *
 * 用一个**假的 OpenAI 兼容服务**驱动模型行为，所以不需要真 API key、
 * 结果完全确定：测试指定"这次模型要调哪个工具"，然后断言 agent 的反应。
 *
 * 验的是**执行层的护栏**，不是提示词：
 *   1. 给模型的 tools 范围随层级变化（普通群友：空；群聊服主：沙箱；私聊服主：含 exec）
 *   2. 模型提议的普通工具 → 执行 + 服务端审计
 *   3. 模型提议的危险命令 → **不执行**，先问人
 *   4. 人回「确认」→ 才执行
 *   5. 模型想替普通群友调 exec → 服务端拒绝，agent 不执行
 */
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { createServer as createNetServer } from 'node:net';
import path from 'node:path';
import { section, summary, ok, eq, includes as includesText, expectOk } from './_assert.mjs';
import { WsClient } from './_client.mjs';

export const needsServer = true;
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
  return { client: c, self: res.data.self };
}

async function freePort() {
  return new Promise((resolve, reject) => {
    const srv = createNetServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
  });
}

/**
 * 假 LLM：OpenAI 兼容的 /chat/completions。
 *
 * `script` 是一个队列，测试往里塞"这一次模型返回什么"：
 *   { toolCalls: [{ name, args }] }  → 返回 tool_calls
 *   { content: '文本' }               → 返回普通文本
 * 每次请求都会记进 `requests`，测试据此断言"给模型看了哪些 tools"。
 */
function startFakeLlm() {
  const requests = [];
  const script = [];

  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (b) => (body += b.toString()));
    req.on('end', () => {
      let parsed = {};
      try {
        parsed = JSON.parse(body);
      } catch {
        parsed = {};
      }
      requests.push(parsed);

      const next = script.shift() ?? { content: '（脚本用完了）' };
      const messageId = `chatcmpl-${Math.random().toString(36).slice(2, 10)}`;

      let message;
      let finish = 'stop';
      if (next.toolCalls !== undefined) {
        message = {
          role: 'assistant',
          content: null,
          tool_calls: next.toolCalls.map((tc, i) => ({
            id: `call_${i}_${Math.random().toString(36).slice(2, 8)}`,
            type: 'function',
            function: { name: tc.name, arguments: JSON.stringify(tc.args ?? {}) },
          })),
        };
        finish = 'tool_calls';
      } else {
        message = { role: 'assistant', content: next.content ?? '' };
      }

      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          id: messageId,
          object: 'chat.completion',
          model: parsed.model ?? 'fake',
          choices: [{ index: 0, message, finish_reason: finish }],
        }),
      );
    });
  });

  return {
    requests,
    push: (item) => script.push(item),
    reset: () => {
      requests.length = 0;
      script.length = 0;
    },
    async listen() {
      const port = await freePort();
      await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
      return `http://127.0.0.1:${port}`;
    },
    async close() {
      await new Promise((resolve) => server.close(() => resolve(undefined)));
    },
    /** 最近一次请求里模型看到的工具名列表。 */
    lastToolNames() {
      const last = requests[requests.length - 1];
      return (last?.tools ?? []).map((t) => t.function?.name).filter(Boolean);
    },
  };
}

function startAgent(script, env) {
  const proc = spawn(process.execPath, [script], {
    cwd: path.dirname(script),
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let logs = '';
  proc.stdout.on('data', (b) => (logs += b.toString()));
  proc.stderr.on('data', (b) => (logs += b.toString()));
  let stopped = false;
  return {
    proc,
    logs: () => logs,
    async stop() {
      if (stopped) return;
      stopped = true;
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

async function waitForLog(handle, needle, timeoutMs = 25_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (handle.logs().includes(needle)) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

/** 发消息并等 agent 针对**这条**消息的回复全文（按 reply_to 精确匹配）。 */
async function askAndCollect(watcher, convId, text, timeoutMs = 30_000) {
  const isConvReply = (e) =>
    (e.type === 'message.update' || e.type === 'message.final') &&
    (e.data?.conv_id === convId || e.data?.message?.conv_id === convId);
  watcher.events = watcher.events.filter((e) => !isConvReply(e));

  const sent = expectOk(
    await watcher.request('message.send', {
      conv_id: convId,
      client_msg_id: `q-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      content: [{ type: 'text', text }],
    }),
    `发送「${text}」`,
  );
  const myId = sent.message_id;

  const deadline = Date.now() + timeoutMs;
  let acc = '';
  while (Date.now() < deadline) {
    const evt = await watcher
      .nextEvent(
        (e) =>
          (e.type === 'message.update' || e.type === 'message.final') &&
          (e.data?.conv_id === convId || e.data?.message?.conv_id === convId),
        12_000,
      )
      .catch(() => null);
    if (evt === null) break;
    if (evt.type === 'message.update') acc += evt.data.delta ?? '';
    if (evt.type === 'message.final') {
      const msg = evt.data.message;
      if (msg.conv_id !== convId) continue;
      if (msg.reply_to !== null && msg.reply_to !== undefined && msg.reply_to !== myId) continue;
      const full = (msg.content ?? [])
        .filter((b) => b.type === 'text')
        .map((b) => b.text)
        .join('');
      return full === '' ? acc : full;
    }
  }
  return acc;
}

export async function run(ctx) {
  const { http, wsUrl, repoRoot } = ctx;

  const llm = startFakeLlm();
  const llmBase = await llm.listen();

  const alice = await mkUser(http, 'alice', '爱丽丝');
  const bob = await mkUser(http, 'bob', '小明');

  section('1. 建 agent（alice 是 owner）');
  const agentRes = await http('POST', '/api/admin/agents', {
    token: alice.access_token,
    body: { username: 'llmhost', display_name: 'LLM 宿主助手' },
  });
  if (agentRes.status !== 201) throw new Error(`建 agent 失败: ${agentRes.text}`);
  const agentToken = agentRes.body.token;
  const agentId = agentRes.body.agent.id;

  const aliceConn = await connect(wsUrl, alice.access_token);
  const bobConn = await connect(wsUrl, bob.access_token);

  const group = expectOk(
    await aliceConn.client.request('conv.create', {
      kind: 'group',
      title: 'LLM 四象限群',
      member_ids: [bob.user.id, agentId],
    }),
    '建群',
  ).conv;
  const dmHost = expectOk(
    await aliceConn.client.request('conv.create', { kind: 'dm', member_ids: [agentId] }),
    'alice 私聊',
  ).conv;
  const dmBob = expectOk(
    await bobConn.client.request('conv.create', { kind: 'dm', member_ids: [agentId] }),
    'bob 私聊',
  ).conv;

  section('2. 起 examples/llm-host-agent（指向假 LLM）');
  const agent = startAgent(path.join(repoRoot, 'examples/llm-host-agent/index.mjs'), {
    AGENTLINK_URL: wsUrl,
    AGENTLINK_TOKEN: agentToken,
    LLM_BASE_URL: llmBase,
    LLM_API_KEY: 'fake-key-for-test',
    LLM_MODEL: 'fake-model',
  });
  ok(await waitForLog(agent, '已连接'), 'llm-host-agent 已连接');
  ok(agent.logs().includes('fake-model'), '日志里报出了模型名');

  try {
    // ---- 层级 → 给模型的 tools 范围 ----
    section('3. 给模型的 tools 随层级变化');
    llm.reset();
    llm.push({ content: '我是助手，没有工具。' });
    await askAndCollect(bobConn.client, group.id, '@llmhost 你能做什么');
    eq(llm.lastToolNames().length, 0, '群聊 + 普通群友：tools 是空（纯问答）');

    llm.reset();
    llm.push({ content: '我可以查系统状态。' });
    await askAndCollect(aliceConn.client, group.id, '@llmhost 你能做什么');
    const groupTools = llm.lastToolNames();
    ok(groupTools.includes('ls'), '群聊 + 服主：拿到沙箱工具 ls');
    ok(groupTools.includes('cat'), '群聊 + 服主：拿到 cat');
    ok(!groupTools.includes('exec'), '群聊 + 服主：**没有** exec（群里只给沙箱）');

    llm.reset();
    llm.push({ content: '我可以执行命令。' });
    await askAndCollect(aliceConn.client, dmHost.id, '你能做什么');
    const dmTools = llm.lastToolNames();
    ok(dmTools.includes('exec'), '私聊 + 服主：拿到 exec（全权限）');
    ok(dmTools.includes('ls'), '私聊 + 服主：也拿到沙箱工具');

    llm.reset();
    llm.push({ content: '我是助理。' });
    await askAndCollect(bobConn.client, dmBob.id, '你能做什么');
    eq(llm.lastToolNames().length, 0, '私聊 + 普通群友：tools 是空');

    // ---- 模型提议普通工具 → 执行 + 审计 ----
    section('4. 模型调沙箱工具 → 执行并审计');
    llm.reset();
    llm.push({ toolCalls: [{ name: 'pwd', args: {} }] });
    llm.push({ content: '你的工作目录我已经查到了。' });
    const pwdReply = await askAndCollect(aliceConn.client, group.id, '@llmhost 查一下工作目录');
    includesText(pwdReply, '工作目录', '模型根据工具结果给出了回答');
    ok(llm.requests.length >= 2, `一轮工具调用产生了 ${llm.requests.length} 次 LLM 请求`);
    // 第二次请求里应该带上了 role: tool 的结果
    const secondReq = llm.requests[1];
    ok(
      (secondReq.messages ?? []).some((m) => m.role === 'tool'),
      '工具结果以 role:tool 回灌给了模型',
    );

    const audit1 = await http('GET', '/api/admin/audit?limit=50&action=tool.pwd', {
      token: alice.access_token,
    });
    eq(audit1.status, 200, '能查 tool.pwd 审计');
    ok(audit1.body.items.length > 0, `tool.pwd 有 ${audit1.body.items.length} 条审计`);
    eq(audit1.body.items[0].detail.tier, 'sandbox', '群聊里层级记为 sandbox');

    // ---- 模型提议危险命令 → 不执行，先问人 ----
    section('5. 模型提议危险命令 → 执行层拦截，先问人');
    llm.reset();
    llm.push({ toolCalls: [{ name: 'exec', args: { command: 'rm -rf /tmp/llm-should-not-run' } }] });
    const dangerReply = await askAndCollect(aliceConn.client, dmHost.id, '把 /tmp 清理一下');
    includesText(dangerReply, '危险命令', '回复里明确说这是危险命令');
    includesText(dangerReply, '确认', '提示了如何确认');

    // 此刻绝不能已经执行：审计里不该有这条命令
    const auditBefore = await http('GET', '/api/admin/audit?limit=50&action=tool.exec', {
      token: alice.access_token,
    });
    const alreadyRan = (auditBefore.body.items ?? []).some((r) =>
      JSON.stringify(r.detail).includes('llm-should-not-run'),
    );
    eq(alreadyRan, false, '未确认前**没有**执行（审计里查不到）');

    // 回「取消」→ 也不该执行
    llm.reset();
    llm.push({ content: '好的，已取消。' });
    const cancelReply = await askAndCollect(aliceConn.client, dmHost.id, '取消');
    includesText(cancelReply, '已取消', '取消后被清除');

    const auditCancel = await http('GET', '/api/admin/audit?limit=50&action=tool.exec', {
      token: alice.access_token,
    });
    const ranAfterCancel = (auditCancel.body.items ?? []).some((r) =>
      JSON.stringify(r.detail).includes('llm-should-not-run'),
    );
    eq(ranAfterCancel, false, '取消之后仍然没有执行');

    // ---- 确认后执行 ----
    section('6. 人回「确认」→ 才执行，并留审计');
    llm.reset();
    llm.push({ toolCalls: [{ name: 'exec', args: { command: 'rm -rf /tmp/llm-confirm-test' } }] });
    const ask2 = await askAndCollect(aliceConn.client, dmHost.id, '删掉那个测试目录');
    includesText(ask2, '危险命令', '又拦了一次');

    const confirmed = await askAndCollect(aliceConn.client, dmHost.id, '确认');
    includesText(confirmed, '执行', '确认后真的执行');

    const auditAfter = await http('GET', '/api/admin/audit?limit=50&action=tool.exec', {
      token: alice.access_token,
    });
    const ranNow = (auditAfter.body.items ?? []).some((r) =>
      JSON.stringify(r.detail).includes('llm-confirm-test'),
    );
    eq(ranNow, true, '确认后执行，且审计里有记录');

    // ---- 模型替普通群友调 exec → 服务端拒 ----
    section('7. 模型想替普通群友调 exec → 服务端拒绝');
    llm.reset();
    // 故意给 bob 的私聊塞一个 exec 工具调用（模型"越权"）
    llm.push({ toolCalls: [{ name: 'exec', args: { command: 'id' } }] });
    llm.push({ content: '抱歉，我没有权限执行。' });
    const deniedReply = await askAndCollect(bobConn.client, dmBob.id, '帮我执行 id');
    // 服务端拒绝后 agent 把拒绝原因回灌给模型，模型据此回答
    ok(
      deniedReply.includes('权限') || deniedReply.includes('拒绝') || deniedReply.includes('抱歉'),
      `普通群友拿不到 exec（回复：${deniedReply.slice(0, 40)}）`,
    );

    // 精确证据：回灌给模型的 tool 消息里应当是**服务端的拒绝**，
    // 而不是 agent 自己编的"抱歉"。否则说明门根本没生效。
    const toolMsgs = (llm.requests[llm.requests.length - 1]?.messages ?? []).filter(
      (m) => m.role === 'tool',
    );
    ok(toolMsgs.length > 0, '有一次工具调用的结果被回灌');
    includesText(
      String(toolMsgs[toolMsgs.length - 1]?.content ?? ''),
      '服务端拒绝',
      '回灌的是服务端的拒绝理由（说明 agent 真的问了服务端）',
    );

    const auditDenied = await http('GET', '/api/admin/audit?limit=100&action=tool.exec', {
      token: alice.access_token,
    });
    const bobRan = (auditDenied.body.items ?? []).some(
      (r) => r.detail.triggered_by === bob.user.id && JSON.stringify(r.detail).includes('"id"'),
    );
    eq(bobRan, false, '普通群友触发的 exec 没有进审计（说明没执行）');
  } finally {
    await agent.stop();
    await llm.close();
  }

  return summary('tool-llm');
}
