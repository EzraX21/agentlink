#!/usr/bin/env node
/**
 * agent-http 验收：外部 agent 的 HTTP + SSE 接入面（`/api/agent/*`）。
 *
 * 这条验证的定位：**AgentLink 不接入模型**，它只对外部 AI 运行时暴露消息通道。
 * Claude Code / openclaw / DSH / hermes 这类进程拿一个 agent token，就能：
 *   - 查我是谁、我的会话、历史
 *   - 发消息（幂等）
 *   - 上报"正在输入"
 *   - 用 SSE 持续接收新事件
 *
 * 语义必须与 WS 完全一致：这里发一条消息，WS 客户端要能收到 `message.new`，
 * 反之亦然。
 */
import { section, summary, ok, eq, gte, expectOk } from './_assert.mjs';
import { WsClient } from './_client.mjs';

export const needsServer = true;

const TOKEN = 'http-agent-pass-123';

export async function run(ctx) {
  const { http, wsUrl } = ctx;

  section('0. 准备：人类管理员 + 一个 agent 身份');
  const reg = await http('POST', '/api/auth/register', {
    body: { username: 'alice', display_name: '爱丽丝', password: TOKEN },
  });
  if (reg.status !== 201) throw new Error(`注册失败: ${reg.text}`);
  const alice = reg.body;

  const agentRes = await http('POST', '/api/admin/agents', {
    token: alice.access_token,
    body: { username: 'helper', display_name: '外部助手' },
  });
  eq(agentRes.status, 201, '创建 agent 身份');
  const agentToken = agentRes.body.token;
  const agentId = agentRes.body.agent.id;

  // 建群（会话创建仍走 WS：这是控制面，不属本次桥接范围）
  const ws = new WsClient(wsUrl);
  await ws.connect();
  expectOk(await ws.request('auth', { token: alice.access_token }), 'alice WS 认证');
  const conv = expectOk(
    await ws.request('conv.create', {
      kind: 'group',
      title: 'HTTP 桥测试群',
      member_ids: [agentId],
    }),
    '建群（含 agent）',
  ).conv;

  section('1. GET /api/agent/self：确认身份与"不接模型"的定位');
  const self = await http('GET', '/api/agent/self', { token: agentToken });
  eq(self.status, 200, '200');
  eq(self.body.self.kind, 'agent', 'kind = agent');
  eq(self.body.self.id, agentId, 'id 一致');
  ok(
    typeof self.body.note === 'string' && self.body.note.includes('模型'),
    '响应里明确说明：只提供消息通道，模型调用在调用方进程里',
  );

  section('2. GET /api/agent/convs');
  const convs = await http('GET', '/api/agent/convs', { token: agentToken });
  eq(convs.status, 200, '200');
  ok(
    convs.body.items.some((c) => c.id === conv.id),
    'agent 能看到自己被拉进的群',
  );

  section('3. POST /api/agent/messages：发消息 → WS 侧收到');
  const sent = await http('POST', '/api/agent/messages', {
    token: agentToken,
    body: { conv_id: conv.id, text: '这是外部 agent 通过 HTTP 发出的', client_msg_id: 'cmid-1' },
  });
  eq(sent.status, 200, '200');
  eq(sent.body.duplicate, false, '首次发送不是重复');
  gte(sent.body.seq, 1, `分配了 seq=${sent.body.seq}`);

  const evt = await ws.nextEvent('message.new');
  eq(evt.data.message.id, sent.body.message_id, 'WS 客户端收到同一条消息');
  eq(evt.data.message.content[0].text, '这是外部 agent 通过 HTTP 发出的', '内容一致');

  section('4. 幂等：同一个 client_msg_id 重发不会产生第二条');
  const again = await http('POST', '/api/agent/messages', {
    token: agentToken,
    body: { conv_id: conv.id, text: '这是外部 agent 通过 HTTP 发出的', client_msg_id: 'cmid-1' },
  });
  eq(again.status, 200, '重发也是 200（协议 §5.3：幂等命中不报错）');
  eq(again.body.duplicate, true, 'duplicate = true');
  eq(again.body.message_id, sent.body.message_id, '返回同一条消息 id');
  eq(again.body.seq, sent.body.seq, 'seq 也相同');

  section('5. GET /api/agent/history');
  const hist = await http('GET', `/api/agent/history?conv_id=${conv.id}&limit=10`, {
    token: agentToken,
  });
  eq(hist.status, 200, '200');
  eq(hist.body.messages.length, 1, '历史里只有一条（幂等没有写第二条）');
  eq(hist.body.messages[0].id, sent.body.message_id, '就是刚发的那条');

  section('6. POST /api/agent/typing → WS 侧收到 typing');
  const typing = await http('POST', '/api/agent/typing', {
    token: agentToken,
    body: { conv_id: conv.id },
  });
  eq(typing.status, 200, '200');
  const typingEvt = await ws.nextEvent('typing');
  eq(typingEvt.data.user_id, agentId, 'typing 的 user_id 是 agent');
  eq(typingEvt.seq, null, '瞬时事件（seq=null）');

  section('7. SSE：人类发消息 → agent 通过流收到');
  // 从"当前最大 seq 之前"开始订阅，确保能收到接下来的人消息
  const since = Math.max(0, sent.body.seq - 1);
  const controller = new AbortController();
  const streamRes = await fetch(`${ctx.baseUrl}/api/agent/events?since=${since}`, {
    headers: { authorization: `Bearer ${agentToken}` },
    signal: controller.signal,
  });
  eq(streamRes.status, 200, 'SSE 建流 200');
  eq(
    streamRes.headers.get('content-type')?.includes('text/event-stream'),
    true,
    'content-type 是 text/event-stream',
  );

  const received = [];
  const reader = streamRes.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const pump = (async () => {
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let idx = buffer.indexOf('\n\n');
        while (idx >= 0) {
          const chunk = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          const dataLine = chunk.split('\n').find((l) => l.startsWith('data: '));
          if (dataLine !== undefined && !chunk.includes('event: ready')) {
            try {
              received.push(JSON.parse(dataLine.slice(6)));
            } catch {
              /* 心跳/非 JSON 行忽略 */
            }
          }
          idx = buffer.indexOf('\n\n');
        }
      }
    } catch {
      /* abort 时的正常中断 */
    }
  })();

  // 人类通过 WS 发一条
  const humanText = `人类回复 ${Date.now()}`;
  expectOk(
    await ws.request('message.send', {
      conv_id: conv.id,
      client_msg_id: `human-${Date.now()}`,
      content: [{ type: 'text', text: humanText }],
    }),
    '人类发消息',
  );

  // 等 SSE 推到
  for (let i = 0; i < 40 && !received.some((e) => JSON.stringify(e).includes(humanText)); i += 1) {
    await new Promise((r) => setTimeout(r, 100));
  }
  controller.abort();
  await pump;

  const hit = received.find((e) => JSON.stringify(e).includes(humanText));
  ok(hit !== undefined, `agent 通过 SSE 收到了人类的消息（累积 ${received.length} 条事件）`);
  if (hit !== undefined) {
    eq(hit.kind, 'evt', '帧形状与 WS 事件一致（kind=evt）');
    eq(hit.type, 'message.new', 'type = message.new');
    gte(hit.seq, 1, '带 seq，可用来断点续拉');
  }

  section('8. ?once=1：给 shell 用的一次性批量');
  const once = await http('GET', `/api/agent/events?since=0&once=1`, { token: agentToken });
  eq(once.status, 200, '200');
  gte(once.body.events.length, 2, `一次拿到 ${once.body.events.length} 条历史事件`);
  eq(
    once.body.next_seq,
    once.body.events[once.body.events.length - 1].seq,
    'next_seq 指向最后一条，便于下次续拉',
  );

  section('9. 权限：非成员不能往别人群里发');
  const other = await http('POST', '/api/auth/register', {
    body: { username: 'mallory', display_name: '马洛里', password: TOKEN },
  });
  const outsider = await http('POST', '/api/agent/messages', {
    token: other.body.access_token,
    body: { conv_id: conv.id, text: '我不该能发' },
  });
  eq(outsider.status, 403, '非成员 → 403');
  eq(outsider.body.error.code, 'PERM_DENIED', '错误码 PERM_DENIED');

  section('10. 定位：服务端不接模型，示例也不强制接');
  {
    const { readFile: read } = await import('node:fs/promises');
    const { repoRoot } = ctx;
    // 服务端代码里不该出现任何模型 SDK / 模型端点
    const serverFiles = ['routes/agent.ts', 'ops/typing.ts', 'app.ts'];
    for (const f of serverFiles) {
      const src = await read(`${repoRoot}/packages/server/src/${f}`, 'utf8');
      ok(
        !/openai|anthropic|chat\/completions|api\.deepmind/i.test(src),
        `${f} 里没有模型调用`,
      );
    }
    // 纯 HTTP 示例必须没有任何模型依赖
    const httpAgent = await read(`${repoRoot}/examples/http-agent/index.mjs`, 'utf8');
    ok(
      !/openai|anthropic|chat\/completions|LLM_/i.test(httpAgent),
      'examples/http-agent 完全不接模型（只有 HTTP）',
    );
    const doc = await read(`${repoRoot}/docs/AGENT-INTEGRATION.md`, 'utf8');
    ok(doc.includes('不内置模型'), '文档明确说明 AgentLink 不内置模型');
    ok(doc.includes('client_msg_id'), '文档说明了幂等键怎么用');
  }

  section('11. 鉴权：没有 token 一律拒绝');
  const noAuth = await http('GET', '/api/agent/self');
  eq(noAuth.status, 401, '缺 token → 401');

  ws.close();
  return summary('agent-http');
}
