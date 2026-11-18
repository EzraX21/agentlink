#!/usr/bin/env node
/**
 * mcp 验收：AgentLink 的 MCP server（stdio）。
 *
 * 验的是"外部 AI 客户端能不能真的把它当工具用"：
 *   1. JSON-RPC 握手（initialize → 回 protocolVersion + tools 能力）
 *   2. tools/list 列出工具与 JSON Schema
 *   3. tools/call 真的发消息、读消息、读上下文
 *   4. 工具级失败用 isError 表达（MCP 约定），而不是把进程搞崩
 *   5. stdout 只有 JSON-RPC —— 日志混进去会直接破坏协议
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { section, summary, ok, eq, gte, expectOk } from './_assert.mjs';
import { connectAuthed } from './_client.mjs';

export const needsServer = true;

/** 一个最小的 stdio JSON-RPC 客户端。 */
class McpClient {
  constructor(bin, env) {
    this.proc = spawn(process.execPath, [bin], {
      env: { ...process.env, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.buffer = '';
    this.pending = new Map();
    this.nextId = 1;
    this.stderr = '';
    this.badLines = [];
    this.proc.stderr.on('data', (b) => {
      this.stderr += b.toString();
    });
    this.proc.stdout.on('data', (b) => {
      this.buffer += b.toString();
      let nl = this.buffer.indexOf('\n');
      while (nl >= 0) {
        const line = this.buffer.slice(0, nl).trim();
        this.buffer = this.buffer.slice(nl + 1);
        if (line !== '') {
          try {
            const frame = JSON.parse(line);
            const resolve = this.pending.get(frame.id);
            if (resolve !== undefined) {
              this.pending.delete(frame.id);
              resolve(frame);
            }
          } catch {
            // stdout 里出现非 JSON 就是协议污染 —— 记下来让断言去报
            this.badLines.push(line.slice(0, 80));
          }
        }
        nl = this.buffer.indexOf('\n');
      }
    });
  }

  request(method, params) {
    const id = this.nextId++;
    const frame = { jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${method} 超时`)), 20_000);
      this.pending.set(id, (res) => {
        clearTimeout(timer);
        resolve(res);
      });
      this.proc.stdin.write(`${JSON.stringify(frame)}\n`);
    });
  }

  notify(method, params) {
    this.proc.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, ...(params ? { params } : {}) })}\n`);
  }

  close() {
    this.proc.stdin.end();
    setTimeout(() => this.proc.kill('SIGKILL'), 500);
  }
}

export async function run(ctx) {
  const { http, wsUrl } = ctx;

  section('0. 准备：人类 + agent 身份 + 一个群');
  const reg = await http('POST', '/api/auth/register', {
    body: { username: 'alice', display_name: '爱丽丝', password: 'mcp-pass-123' },
  });
  if (reg.status !== 201) throw new Error(`注册失败: ${reg.text}`);
  const alice = reg.body;

  const agentRes = await http('POST', '/api/admin/agents', {
    token: alice.access_token,
    body: { username: 'claude', display_name: 'Claude' },
  });
  eq(agentRes.status, 201, '创建 agent 身份');
  const agentToken = agentRes.body.token;
  const agentId = agentRes.body.agent.id;

  const human = (await connectAuthed(wsUrl, alice.access_token)).client;
  const conv = expectOk(
    await human.request('conv.create', {
      kind: 'group',
      title: 'MCP 测试群',
      member_ids: [agentId],
    }),
    '建群（含 agent）',
  ).conv;

  const bin = path.join(ctx.repoRoot, 'packages/mcp/dist/index.js');
  const mcp = new McpClient(bin, { AGENTLINK_URL: wsUrl, AGENTLINK_TOKEN: agentToken });

  try {
    section('1. JSON-RPC 握手');
    const init = await mcp.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'acceptance', version: '0' },
    });
    eq(init.jsonrpc, '2.0', 'jsonrpc 版本正确');
    eq(init.result.serverInfo.name, 'agentlink', 'serverInfo.name = agentlink');
    ok(
      typeof init.result.protocolVersion === 'string' && init.result.protocolVersion.length > 0,
      `protocolVersion = ${init.result.protocolVersion}`,
    );
    ok(init.result.capabilities.tools !== undefined, '声明了 tools 能力');
    mcp.notify('notifications/initialized');

    const pong = await mcp.request('ping');
    ok(pong.result !== undefined, 'ping 有响应');

    section('2. tools/list 暴露工具与 schema');
    const list = await mcp.request('tools/list');
    const names = list.result.tools.map((t) => t.name);
    gte(names.length, 8, `列出了 ${names.length} 个工具`);
    for (const expected of [
      'agentlink_send_message',
      'agentlink_read_messages',
      'agentlink_wait_for_message',
      'agentlink_list_convs',
      'agentlink_read_context',
    ]) {
      ok(names.includes(expected), `有 ${expected}`);
    }
    const send = list.result.tools.find((t) => t.name === 'agentlink_send_message');
    ok(send.inputSchema.type === 'object', '工具带 JSON Schema');
    ok(
      Array.isArray(send.inputSchema.required) && send.inputSchema.required.includes('conv_id'),
      'schema 里标了必填字段',
    );

    section('3. tools/call：真的发消息');
    const sent = await mcp.request('tools/call', {
      name: 'agentlink_send_message',
      arguments: { conv_id: conv.id, text: '来自 MCP 的消息', client_msg_id: 'mcp-1' },
    });
    ok(sent.result.isError !== true, '调用成功（没有 isError）');
    const sentBody = JSON.parse(sent.result.content[0].text);
    gte(sentBody.seq, 1, `服务端分配了 seq=${sentBody.seq}`);

    // 人类侧应当收到
    const evt = await human.nextEvent('message.new');
    eq(evt.data.message.content[0].text, '来自 MCP 的消息', '人类真的收到了这条消息');

    section('4. 幂等：同一个 client_msg_id 重发不会产生第二条');
    const again = await mcp.request('tools/call', {
      name: 'agentlink_send_message',
      arguments: { conv_id: conv.id, text: '来自 MCP 的消息', client_msg_id: 'mcp-1' },
    });
    const againBody = JSON.parse(again.result.content[0].text);
    eq(againBody.message_id, sentBody.message_id, '返回同一条消息（幂等键生效）');

    section('5. tools/call：读历史与上下文');
    const read = await mcp.request('tools/call', {
      name: 'agentlink_read_messages',
      arguments: { conv_id: conv.id, limit: 10 },
    });
    ok(read.result.content[0].text.includes('来自 MCP 的消息'), '读到了刚才那条');

    const ctxRes = await mcp.request('tools/call', {
      name: 'agentlink_read_context',
      arguments: { conv_id: conv.id, before: 5 },
    });
    ok(
      ctxRes.result.content[0].text.includes('来自 MCP 的消息'),
      'context.fetch 里也有（可直接拼 prompt）',
    );
    ok(
      ctxRes.result.content[0].text.includes('truncated='),
      '返回里带截断信息',
    );

    section('6. tools/call：会话列表与表情');
    const convs = await mcp.request('tools/call', { name: 'agentlink_list_convs', arguments: {} });
    ok(convs.result.content[0].text.includes(conv.id), '会话列表里有这个群');

    const react = await mcp.request('tools/call', {
      name: 'agentlink_react',
      arguments: { conv_id: conv.id, message_id: sentBody.message_id, emoji: '👍' },
    });
    ok(react.result.isError !== true, '加表情成功');
    ok(react.result.content[0].text.includes('👍'), '返回的汇总里有 👍');

    section('7. wait_for_message：等人类说话');
    const waitPromise = mcp.request('tools/call', {
      name: 'agentlink_wait_for_message',
      arguments: { timeout_ms: 8000 },
    });
    // 等它连上并进入等待，再由人类发一条
    await new Promise((r) => setTimeout(r, 500));
    expectOk(
      await human.request('message.send', {
        conv_id: conv.id,
        client_msg_id: 'mcp-human-1',
        content: [{ type: 'text', text: '人类插话' }],
      }),
      '人类发一条',
    );
    const waited = await waitPromise;
    ok(
      waited.result.content[0].text.includes('人类插话'),
      `wait_for_message 把人类的消息交给了模型（实际返回：${waited.result.content[0].text.slice(0, 80)}）`,
    );

    section('8. 工具级失败用 isError 表达（进程不能崩）');
    const bad = await mcp.request('tools/call', {
      name: 'agentlink_send_message',
      arguments: { conv_id: 'c_01M7JD0000000000000000000A', text: 'x' },
    });
    eq(bad.result.isError, true, '失败时 isError=true');
    ok(
      typeof bad.result.content[0].text === 'string' && bad.result.content[0].text.length > 0,
      '错误信息作为文本返回给模型',
    );
    // 进程还活着：再调一个正常工具
    const alive = await mcp.request('tools/call', { name: 'agentlink_list_convs', arguments: {} });
    ok(alive.result !== undefined, '失败之后进程仍可用');

    section('9. 未知工具与方法');
    const unknownTool = await mcp.request('tools/call', { name: 'does_not_exist', arguments: {} });
    eq(unknownTool.error.code, -32602, '未知工具 → JSON-RPC -32602');
    const unknownMethod = await mcp.request('does/not/exist');
    eq(unknownMethod.error.code, -32601, '未知方法 → -32601');

    section('10. stdout 只有 JSON-RPC（不能被日志污染）');
    eq(mcp.badLines.length, 0, `stdout 里没有非 JSON 行${mcp.badLines[0] ? `：${mcp.badLines[0]}` : ''}`);
  } finally {
    mcp.close();
    human.close();
  }

  return summary('mcp');
}
