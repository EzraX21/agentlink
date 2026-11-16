#!/usr/bin/env node
/**
 * llm-agent：接一个 OpenAI 兼容接口，流式输出（实现计划 M9，可选）。
 *
 * 用法：
 *   AGENTLINK_URL=ws://127.0.0.1:3000/ws \
 *   AGENTLINK_TOKEN=ag_... \
 *   LLM_BASE_URL=https://api.openai.com/v1 \
 *   LLM_API_KEY=sk-... \
 *   LLM_MODEL=gpt-4o-mini \
 *   node examples/llm-agent/index.mjs
 *
 * 没有 LLM_API_KEY 时会退化成 echo 行为，方便本地验证链路。
 *
 * 关键点：用 context.fetch 拿到可直接拼 prompt 的历史（协议 §7），
 * 然后按 SSE 逐块写入流式消息。
 */
import { Client } from '@agentlink/agent-sdk';

const url = process.env.AGENTLINK_URL ?? 'ws://127.0.0.1:3000/ws';
const token = process.env.AGENTLINK_TOKEN;
const baseUrl = (process.env.LLM_BASE_URL ?? 'https://api.openai.com/v1').replace(/\/$/, '');
const apiKey = process.env.LLM_API_KEY;
const model = process.env.LLM_MODEL ?? 'gpt-4o-mini';
const systemPrompt =
  process.env.LLM_SYSTEM_PROMPT ??
  '你是一个在群聊里的助手。回答简洁，用中文，不要复述别人的话。';

if (!token) {
  console.error('[llm-agent] 缺少 AGENTLINK_TOKEN 环境变量');
  process.exit(1);
}

const client = new Client({
  url,
  token,
  onlyMentions: true,
  logger: (level, msg) => console.log(`[llm-agent] ${level}: ${msg}`),
});

/** 把 context.fetch 的结果拼成 OpenAI messages（这一步就是"零自建历史"）。 */
function toPrompt(messages) {
  return [
    { role: 'system', content: systemPrompt },
    ...messages.map((m) => ({
      role: m.sender_kind === 'agent' ? 'assistant' : 'user',
      content: m.quote === null ? `${m.sender}: ${m.text}` : `${m.sender}（引用「${m.quote}」）: ${m.text}`,
    })),
  ];
}

/** 逐块产出 SSE 的 delta。 */
async function* streamLlm(messages, signal) {
  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({ model, messages, stream: true, temperature: 0.7 }),
    signal,
  });
  if (!res.ok || res.body === null) {
    throw new Error(`LLM 请求失败: ${res.status} ${await res.text()}`);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop() ?? '';
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data:')) continue;
      const payload = trimmed.slice(5).trim();
      if (payload === '[DONE]') return;
      try {
        const json = JSON.parse(payload);
        const delta = json.choices?.[0]?.delta?.content;
        if (typeof delta === 'string' && delta !== '') yield delta;
      } catch {
        // 不完整的一行，等下一块
      }
    }
  }
}

client.onMessage(async ({ convId, text, message, client: c }) => {
  const ctx = await c.context({ conv_id: convId, before: 20, max_chars: 8000 });
  const stream = await c.stream(convId, { replyTo: message.id });

  // 人类打断时，服务端会关掉这条流；这里用 AbortController 停掉上游请求
  const ac = new AbortController();
  const watchdog = setInterval(() => {
    if (stream.interrupted) {
      ac.abort();
      clearInterval(watchdog);
    }
  }, 200);
  watchdog.unref?.();

  try {
    if (!apiKey) {
      // 没有 key：退化成回显，保证链路可验证
      for (const ch of [...`（未配置 LLM_API_KEY，回显）${text}`]) {
        if (stream.interrupted) return;
        await stream.write(ch);
        await new Promise((r) => setTimeout(r, 25));
      }
    } else {
      const prompt = toPrompt(ctx.messages);
      for await (const delta of streamLlm(prompt, ac.signal)) {
        if (stream.interrupted) {
          ac.abort();
          return;
        }
        await stream.write(delta);
      }
    }
    await stream.commit();
  } catch (err) {
    if (stream.interrupted || err.name === 'AbortError' || err.name === 'StreamClosedError') {
      console.log('[llm-agent] 被人类打断');
      return;
    }
    console.error('[llm-agent] 生成失败', err);
    try {
      await stream.abort('生成失败');
    } catch {
      /* 已关闭 */
    }
  } finally {
    clearInterval(watchdog);
  }
});

await client.connect();
console.log('[llm-agent] 已连接，等待 @ 提及…');

const shutdown = () => {
  client.disconnect();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
