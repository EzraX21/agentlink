#!/usr/bin/env node
/**
 * AgentLink 演示：一条命令跑通「两个真人 + 一个 AI agent 同群聊天」。
 *
 * 这是验收标准第 1 条的现场版。脚本会：
 *   1. 注册两个人类账号（alice / bob）
 *   2. alice（第一个注册的用户自动是管理员）创建一个 agent 身份
 *   3. 建群，把三个人拉进去
 *   4. agent 上线（回显机器人，逐字流式回复）
 *   5. alice 发「@echo 你好」→ agent 流式回复 → bob 实时看到全部
 *   6. bob 断线 → alice 发一条 → bob 重连凭 resume 补齐（协议 §3.3）
 *
 * 前置：一个在跑的 AgentLink 服务端。最快的方式是单容器：
 *
 *   docker run -d --name agentlink -p 3000:3000 \
 *     -e JWT_SECRET=$(openssl rand -hex 32) \
 *     -e AGENT_TOKEN_PEPPER=$(openssl rand -hex 16) \
 *     -v agentlink-data:/data \
 *     agentlink:latest
 *
 * 然后跑本脚本（仓库根目录）：
 *
 *   node examples/demo.mjs
 *
 * 指向别的服务端：
 *   AGENTLINK_URL=http://chat.example.com node examples/demo.mjs
 */
import { WebSocket } from 'ws';
import { Client } from '@agentlink/agent-sdk';

const base = (process.env.AGENTLINK_URL ?? 'http://127.0.0.1:3000').replace(/\/$/, '');
const wsUrl = base.replace(/^http/, 'ws') + '/ws';
const suffix = Math.random().toString(36).slice(2, 6); // 避免与已有账号重名

const bold = (s) => `\x1b[1m${s}\x1b[0m`;
const dim = (s) => `\x1b[2m${s}\x1b[0m`;
const green = (s) => `\x1b[32m${s}\x1b[0m`;
const say = (t) => console.log(`  ${t}`);

async function api(path, init = {}, token) {
  const res = await fetch(`${base}${path}`, {
    ...init,
    headers: {
      ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
    },
  });
  const text = await res.text();
  const body = text === '' ? null : JSON.parse(text);
  if (!res.ok) {
    throw new Error(`${path} → ${res.status} ${JSON.stringify(body)}`);
  }
  return body;
}

/**
 * 最小的 WS 会话：连接 + 认证 + 请求 + 收事件。
 * 刻意不引用 protocol 包 —— 演示要证明"协议就这么简单，裸 WebSocket 都能说"。
 */
class Session {
  constructor(token, label) {
    this.label = label;
    this.ws = new WebSocket(wsUrl, ['agentlink.v1']);
    this.seq = 0;
    this.pending = new Map();
    this.opened = new Promise((resolve, reject) => {
      this.ws.once('open', resolve);
      this.ws.once('error', reject);
    });
    this.authed = this.opened.then(
      () =>
        new Promise((resolve, reject) => {
          this.ws.once('message', (raw) => {
            const frame = JSON.parse(raw.toString());
            if (frame.kind === 'res' && frame.ok) resolve(frame);
            else reject(new Error(JSON.stringify(frame.error ?? frame)));
          });
          this.ws.send(JSON.stringify({ v: 1, kind: 'req', id: 'auth', op: 'auth', data: { token } }));
        }),
    );
    this.ws.on('message', (raw) => {
      const frame = JSON.parse(raw.toString());
      if (frame.kind === 'res') {
        const p = this.pending.get(frame.id);
        if (p) {
          this.pending.delete(frame.id);
          p(frame);
        }
        return;
      }
      if (frame.kind === 'evt' && frame.type === 'message.new') this.#onMessageNew(frame.data.message);
    });
  }

  #onMessageNew(m) {
    const who = m.sender.display_name;
    const text = m.content.map((b) => (b.type === 'text' ? b.text : `[${b.type}]`)).join(' ');
    const mark = m.state === 'streaming' ? dim(' …流式中') : '';
    say(`${dim(`[${this.label} 看到]`)} ${bold(who)}: ${text}${mark}`);
  }

  request(op, data) {
    const id = `r${++this.seq}`;
    return new Promise((resolve) => {
      this.pending.set(id, resolve);
      this.ws.send(JSON.stringify({ v: 1, kind: 'req', id, op, data }));
    });
  }

  close() {
    this.ws.close();
  }
}

// ---------------------------------------------------------------------------

console.log(bold(`\nAgentLink 演示 → ${base}\n`));

// 1. 注册两个人类
console.log(bold('1. 注册两个人类账号'));
const alice = await api('/api/auth/register', {
  method: 'POST',
  body: JSON.stringify({ username: `alice_${suffix}`, display_name: '爱丽丝', password: 'demo-password-123' }),
});
const bob = await api('/api/auth/register', {
  method: 'POST',
  body: JSON.stringify({ username: `bob_${suffix}`, display_name: '鲍勃', password: 'demo-password-123' }),
});
say(green(`✓ alice = ${alice.user.id}${alice.is_admin ? '（管理员：这台服务器上第一个用户）' : ''}`));
say(green(`✓ bob   = ${bob.user.id}`));

// 2. 建 agent 身份。
// 建 agent 需要管理员。两种情况都能跑：
//   a) 全新服务端：alice 是第一个注册的用户，自动是管理员
//   b) 已有服务端：用 AGENTLINK_ADMIN_TOKEN 传一个管理员的 token
console.log(bold('\n2. 创建 agent 身份'));
const adminToken = process.env.AGENTLINK_ADMIN_TOKEN ?? alice.access_token;
const agentRes = await api(
  '/api/admin/agents',
  { method: 'POST', body: JSON.stringify({ username: `echo_${suffix}`, display_name: '回显助手' }) },
  adminToken,
).catch((err) => {
  if (process.env.AGENTLINK_ADMIN_TOKEN === undefined) {
    console.error(
      '\n创建 agent 需要管理员权限，而 alice 不是管理员（这台服务器已有别的用户）。\n' +
        '两种解决方式：\n' +
        '  1. 用一台**全新**的服务端跑本演示（新容器的第一个注册用户自动是管理员）\n' +
        '  2. AGENTLINK_ADMIN_TOKEN=<管理员token> node examples/demo.mjs\n',
    );
  }
  throw err;
});
say(green(`✓ echo agent = ${agentRes.agent.id}`));

// 3. 建群拉人
console.log(bold('\n3. 建群「演示群」'));
const aliceWs = new Session(alice.access_token, 'alice');
await aliceWs.authed;
const convRes = await aliceWs.request('conv.create', {
  kind: 'group',
  title: '演示群',
  member_ids: [bob.user.id, agentRes.agent.id],
});
if (!convRes.ok) throw new Error(`建群失败: ${JSON.stringify(convRes.error)}`);
say(green(`✓ 群 ${convRes.data.conv.id}，成员 3 人（alice / bob / echo）`));

// 4. agent 上线
console.log(bold('\n4. agent 上线（收到 @ 后逐字流式回复）'));
const agent = new Client({
  url: wsUrl,
  token: agentRes.token,
  onlyMentions: true,
  logger: () => {},
});
agent.onMessage(async ({ convId, text, message, client }) => {
  const ctx = await client.context({ conv_id: convId, before: 5, max_chars: 2000 });
  say(`${dim('[echo 收到]')} @我:「${text}」（上下文 ${ctx.messages.length} 条）`);

  const stream = await client.stream(convId, { replyTo: message.id });
  const reply =
    '你好！我是 AgentLink 的回显机器人。注意看这条回复——它是逐字出现的，这就是协议 §8 的流式推送（stream.begin → 一串 stream.delta → stream.commit）。';
  for (const ch of [...reply]) {
    try {
      await stream.write(ch);
    } catch {
      return; // 被打断
    }
    await new Promise((r) => setTimeout(r, 16));
  }
  const final = await stream.commit();
  say(`${dim('[echo 完成]')} seq=${final.seq}`);
});
await agent.connect();
say(green('✓ echo 已连接'));

// 5. 群聊
console.log(bold('\n5. 群聊开始（bob 也在线看着）'));
const bobWs = new Session(bob.access_token, 'bob');
await bobWs.authed;

await new Promise((r) => setTimeout(r, 300));
// @ 提及认三种写法：@<id> / @<昵称> / @<username>。这里用 username（演示里带随机后缀）。
const mention = `@${agentRes.agent.username}`;
say(`${dim('[alice 发出]')} ${mention} 你好，请介绍一下你自己`);
const sendRes = await aliceWs.request('message.send', {
  conv_id: convRes.data.conv.id,
  client_msg_id: `demo-${Date.now()}`,
  content: [{ type: 'text', text: `${mention} 你好，请介绍一下你自己` }],
});
if (!sendRes.ok) throw new Error(`发消息失败: ${JSON.stringify(sendRes.error)}`);

await new Promise((r) => setTimeout(r, 4000)); // 等 agent 流式打完

// 6. 断线补齐
console.log(bold('\n6. 断线补齐：bob 掉线 → alice 发一条 → bob 重连凭 last_seq 补回'));
bobWs.close();
await new Promise((r) => setTimeout(r, 500));

const lastSeq = 0; // bob 掉线前记录到的位置（演示里简化为从头补）
say(`${dim('[alice 发出]')} bob 断线期间发的这条`);
await aliceWs.request('message.send', {
  conv_id: convRes.data.conv.id,
  client_msg_id: `demo2-${Date.now()}`,
  content: [{ type: 'text', text: 'bob 断线期间的这条消息' }],
});
await new Promise((r) => setTimeout(r, 300));

const bobWs2 = new Session(bob.access_token, 'bob(重连)');
await bobWs2.authed;
// resume 的响应只有 {replayed, up_to, gap} —— 补的消息本体是以 message.new
// 事件的形式推过来的（在上面「bob(重连) 看到」两行里已经出现了）。
const resumeRes = await bobWs2.request('resume', { last_seq: lastSeq });
say(
  green(
    `✓ resume 补发 ${resumeRes.data.replayed} 条到 seq=${resumeRes.data.up_to}（gap=${resumeRes.data.gap}）—— 就是上面那两行`,
  ),
);

// 7. 收官：以服务端为准的最终历史
console.log(bold('\n7. 最终会话历史（服务端存储为准）'));
const history = await aliceWs.request('history.fetch', { conv_id: convRes.data.conv.id, limit: 10 });
for (const m of history.data.messages.slice().reverse()) {
  const text = m.content.map((b) => (b.type === 'text' ? b.text : `[${b.type}]`)).join(' ');
  say(`${bold(m.sender.display_name)}: ${text.slice(0, 72)}${text.length > 72 ? '…' : ''}`);
}

console.log(green('\n✓ 演示完成。上面每一条消息、每一次流式推送、断线补发，都来自同一个 AgentLink 服务端。\n'));

agent.disconnect();
aliceWs.close();
bobWs2.close();
process.exit(0);
