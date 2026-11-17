#!/usr/bin/env node
/**
 * 示例：**纯 HTTP + SSE** 的外部 agent（不连 WebSocket，也没有任何模型调用）。
 *
 * 这个文件的意义是证明一件事：AgentLink 只是一条消息通道。
 * 谁在对面接消息、用什么语言、背后是不是大模型，服务端完全不知道也不关心 ——
 * 你甚至可以把这里换成 `curl` 或一个 shell 脚本。
 *
 * 用到的端点（见 docs/AGENT-INTEGRATION.md）：
 *   GET  /api/agent/self      我是谁
 *   GET  /api/agent/convs     我的会话
 *   GET  /api/agent/events    SSE 持续收事件
 *   POST /api/agent/messages  发消息（幂等）
 *   POST /api/agent/typing    正在输入
 *
 * 运行（需要一个 agent token，到管理页建）：
 *   AGENTLINK_URL=http://127.0.0.1:3100 \
 *   AGENTLINK_TOKEN=<agent token> \
 *   node examples/http-agent/index.mjs
 */
const baseUrl = (process.env.AGENTLINK_URL ?? 'http://127.0.0.1:3100').replace(/\/$/, '');
const token = process.env.AGENTLINK_TOKEN;

if (token === undefined || token === '') {
  console.error('缺少 AGENTLINK_TOKEN。到管理页「Agent」分区建一个，或 POST /api/admin/agents。');
  process.exit(1);
}

const auth = { authorization: `Bearer ${token}` };

async function api(path, init = {}) {
  const res = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: { ...auth, ...(init.body === undefined ? {} : { 'content-type': 'application/json' }), ...init.headers },
  });
  const text = await res.text();
  const body = text === '' ? null : JSON.parse(text);
  if (!res.ok) {
    throw new Error(`${path} → ${res.status} ${JSON.stringify(body)}`);
  }
  return body;
}

/** 发消息（同一个 client_msg_id 重发是幂等的）。 */
async function send(convId, text) {
  return api('/api/agent/messages', {
    method: 'POST',
    body: JSON.stringify({
      conv_id: convId,
      text,
      client_msg_id: `http-agent-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    }),
  });
}

/**
 * 订阅事件流。
 *
 * SSE 的每一帧是 `data: <JSON>`，JSON 与 WebSocket 的 evt 帧形状**完全一致**
 * （`{v,kind:'evt',type,seq,ts,data}`），所以同一套处理逻辑可以两边复用。
 *
 * 断线重连时带上上次的 `since=<最大 seq>` 就能接上，不会丢事件。
 */
async function subscribe(since, onEvent, signal) {
  const res = await fetch(`${baseUrl}/api/agent/events?since=${since}`, { headers: auth, signal });
  if (!res.ok) throw new Error(`SSE 建流失败: ${res.status}`);

  let buffer = '';
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
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
          onEvent(JSON.parse(dataLine.slice(6)));
        } catch {
          /* 心跳行忽略 */
        }
      }
      idx = buffer.indexOf('\n\n');
    }
  }
}

const me = await api('/api/agent/self');
console.log(`[http-agent] 我是 ${me.self.display_name}（${me.self.kind}）`);
console.log(`[http-agent] ${me.note}`);

const convs = (await api('/api/agent/convs')).items;
if (convs.length === 0) {
  console.log('[http-agent] 还没有会话：先让别人把你拉进群');
  process.exit(0);
}
const conv = convs[0];
console.log(`[http-agent] 会话：${conv.title}`);

// 断点：从最新一条开始（这里 0 表示从头；生产里应持久化 last_seq）
let lastSeq = 0;
const controller = new AbortController();
process.on('SIGINT', () => controller.abort());

// 收到别人的文本消息就回一句 —— 这就是"外部 agent 在操作 AgentLink"的最小闭环
await subscribe(
  lastSeq,
  (evt) => {
    if (typeof evt.seq === 'number' && evt.seq > lastSeq) lastSeq = evt.seq;
    if (evt.type !== 'message.new') return;
    const msg = evt.data.message;
    if (msg.sender.id === me.self.id) return;
    const text = msg.content.filter((b) => b.type === 'text').map((b) => b.text).join(' ');
    if (text === '') return;
    console.log(`[http-agent] 收到 ${msg.sender.display_name}：${text}`);

    void (async () => {
      await api('/api/agent/typing', {
        method: 'POST',
        body: JSON.stringify({ conv_id: msg.conv_id }),
      });
      await send(msg.conv_id, `我听到你说「${text}」了`);
    })().catch((err) => console.error('[http-agent] 回复失败', err.message));
  },
  controller.signal,
).catch(() => console.log('[http-agent] 事件流已关闭'));
