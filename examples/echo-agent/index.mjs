#!/usr/bin/env node
/**
 * echo-agent：收到 @ 就流式回显（实现计划 M9）。
 *
 * 这是验收标准第 1 条的端到端演示：
 *   两个浏览器窗 + 一个 agent 同群 → @agent 后 3 秒内出现逐字增长的回复
 *
 * 用法：
 *   AGENTLINK_URL=ws://127.0.0.1:3000/ws \
 *   AGENTLINK_TOKEN=ag_u_xxx_secret \
 *   node examples/echo-agent/index.mjs
 *
 * token 从环境变量读，**不从命令行参数读**（会进 shell history 与 ps 输出）。
 */
import { Client } from '@agentlink/agent-sdk';

const url = process.env.AGENTLINK_URL ?? 'ws://127.0.0.1:3000/ws';
const token = process.env.AGENTLINK_TOKEN;

if (!token) {
  console.error('[echo-agent] 缺少 AGENTLINK_TOKEN 环境变量');
  process.exit(1);
}

const client = new Client({
  url,
  token,
  onlyMentions: true,
  logger: (level, msg, extra) => {
    const ts = new Date().toISOString().slice(11, 19);
    console.log(`[${ts}] ${level}: ${msg}`, extra === undefined ? '' : extra);
  },
});

client.onMessage(async ({ convId, text, message, client: c }) => {
  // 先取上下文，演示"一步拿到可拼 prompt 的历史"（协议 §7）
  const ctx = await c.context({ conv_id: convId, before: 10, max_chars: 4000 });
  console.log(`[echo-agent] 收到 ${text || '(空)'}；上下文 ${ctx.messages.length} 条`);

  const stream = await c.stream(convId, { replyTo: message.id });

  const reply = text === '' ? '你叫我了？' : `你说的是：「${text}」`;
  // 逐字写，客户端能看到逐字增长（协议 §8）
  for (const ch of [...reply]) {
    try {
      await stream.write(ch);
    } catch (err) {
      if (err.name === 'StreamClosedError') {
        console.log('[echo-agent] 被人类打断，停止生成');
        return;
      }
      throw err;
    }
    // 刻意慢一点，让"逐字增长"肉眼可见
    await new Promise((r) => setTimeout(r, 35));
  }
  const final = await stream.commit();
  console.log(`[echo-agent] 已提交 seq=${final.seq}`);
});

client.onMessage(async ({ convId, client: c }) => {
  // 演示打断处理：如果 5 秒内又有人 @ 它，上一条会被人类打断
  void convId;
  void c;
});

await client.connect();
console.log('[echo-agent] 已连接，等待 @ 提及…');

const shutdown = () => {
  console.log('\n[echo-agent] 退出');
  client.disconnect();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
