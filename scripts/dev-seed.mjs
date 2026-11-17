#!/usr/bin/env node
/**
 * 给一个**已经跑起来**的实例灌演示数据，方便打开界面就有东西看。
 *
 *   node scripts/dev-seed.mjs http://127.0.0.1:3100
 *
 * 幂等性：用固定用户名，重复跑时已存在的用户会走登录而不是注册（会打印提示），
 * 不会再建一个同名群。数据落在当前实例的库里，不清库。
 */
import { WebSocket } from 'ws';

const base = (process.argv[2] ?? 'http://127.0.0.1:3100').replace(/\/$/, '');
const wsUrl = `${base.replace(/^http/, 'ws')}/ws`;

const PASSWORD = 'agentlink123';

async function http(method, path, { body, token } = {}) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  let json = null;
  try {
    json = text === '' ? null : JSON.parse(text);
  } catch {
    json = null;
  }
  return { status: res.status, body: json };
}

/** 注册；已存在则登录。 */
async function ensureUser(username, displayName) {
  const reg = await http('POST', '/api/auth/register', {
    body: { username, display_name: displayName, password: PASSWORD },
  });
  if (reg.status === 201) {
    console.log(`  建账号 ${username}（${displayName}）${reg.body.is_admin ? ' — 管理员' : ''}`);
    return reg.body;
  }
  const login = await http('POST', '/api/auth/login', {
    body: { username, password: PASSWORD },
  });
  if (login.status !== 200) {
    throw new Error(`账号 ${username} 既不能注册也不能登录: ${reg.status}/${login.status}`);
  }
  console.log(`  账号 ${username} 已存在，用现有账号`);
  return login.body;
}

class Ws {
  constructor() {
    this.ws = new WebSocket(wsUrl);
    this.pending = new Map();
    this.seq = 0;
    this.ws.on('message', (raw) => {
      const f = JSON.parse(raw.toString());
      if (f.kind === 'res') {
        const p = this.pending.get(f.id);
        if (p) {
          this.pending.delete(f.id);
          p(f);
        }
      }
    });
  }
  open() {
    return new Promise((resolve, reject) => {
      this.ws.once('open', resolve);
      this.ws.once('error', reject);
    });
  }
  call(op, data) {
    this.seq += 1;
    const id = `s${this.seq}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${op} 超时`)), 10_000);
      this.pending.set(id, (f) => {
        clearTimeout(timer);
        if (!f.ok) reject(new Error(`${op}: ${f.error?.code} ${f.error?.message}`));
        else resolve(f.data);
      });
      this.ws.send(JSON.stringify({ v: 1, kind: 'req', id, op, data }));
    });
  }
  close() {
    this.ws.close();
  }
}

/** 把一行混排文本直接在终端里画出来（不需要额外依赖）。 */
function banner(lines) {
  const width = Math.max(...lines.map((l) => [...l].length)) + 2;
  const bar = '─'.repeat(width);
  console.log(`\n┌${bar}┐`);
  for (const l of lines) {
    const pad = width - [...l].length - 1;
    console.log(`│ ${l}${' '.repeat(Math.max(0, pad))}│`);
  }
  console.log(`└${bar}┘`);
}

async function main() {
  console.log(`目标实例: ${base}\n`);

  const health = await http('GET', '/healthz').catch(() => null);
  if (health?.body?.ok !== true) {
    console.error(`实例没在跑（${base}/healthz 不可达）。先启动服务再灌数据。`);
    process.exit(1);
  }

  console.log('账号：');
  // 第一个账号会成为管理员（迁移 0003 的引导规则）
  const admin = await ensureUser('admin', '管理员');
  const bob = await ensureUser('bob', '小明');
  const carol = await ensureUser('carol', '卡罗');

  console.log('\nAgent：');
  const existing = await http('GET', '/api/admin/agents', { token: admin.access_token });
  let agentToken = null;
  let agentId = (existing.body?.agents ?? [])[0]?.id ?? null;
  if (existing.status === 200 && (existing.body?.agents ?? []).length > 0) {
    console.log('  已有 Agent，跳过创建（token 只在创建时可见，如需新的请在管理页轮换）');
  } else if (existing.status === 200) {
    const res = await http('POST', '/api/admin/agents', {
      token: admin.access_token,
      body: { username: 'echo', display_name: '回显助手', model: 'demo' },
    });
    if (res.status === 201) {
      agentToken = res.body.token;
      agentId = res.body.agent.id;
      console.log('  建 Agent @echo（回显助手）');
    } else {
      console.log(`  建 Agent 失败: ${res.status} ${JSON.stringify(res.body)}`);
    }
  } else {
    console.log(`  跳过（当前实例不可管理: ${existing.status}）`);
  }

  console.log('\n群组与消息：');
  const a = new Ws();
  await a.open();
  await a.call('auth', { token: admin.access_token });
  const b = new Ws();
  await b.open();
  await b.call('auth', { token: bob.access_token });

  const convs = await a.call('conv.list', { limit: 100 });
  let conv = (convs.items ?? []).find((c) => c.title === '演示群');
  if (conv === undefined) {
    // 关键：把 agent 也拉进群。hub 按"群成员"过滤事件，agent 不在群里就永远收不到 @
    const memberIds = [bob.user.id, carol.user.id];
    if (agentId !== null) memberIds.push(agentId);
    conv = (
      await a.call('conv.create', { kind: 'group', title: '演示群', member_ids: memberIds })
    ).conv;
    console.log(`  建群「演示群」`);
  } else {
    console.log('  「演示群」已存在，只补消息');
    // 老库/重复跑：确保 agent 在群里（走管理接口，跨群视角）
    if (agentId !== null) {
      const added = await http('POST', `/api/admin/convs/${conv.id}/members`, {
        token: admin.access_token,
        body: { user_ids: [agentId] },
      });
      if (added.status === 200 && (added.body?.added ?? 0) > 0) {
        console.log('  把 agent 拉进了「演示群」');
      }
    }
  }

  const history = await a.call('history.fetch', { conv_id: conv.id, limit: 5 });
  if ((history.messages ?? []).length === 0) {
    const script = [
      ['admin', '这个群是演示数据，随便发消息试试'],
      ['bob', '收到。左边会话列表、右边聊天窗，样式参照 Telegram Desktop'],
      ['admin', '试试点左下角的「管理」——概览、账号、Agent、群组、审计五个分区'],
      ['bob', '流式回复要有 agent 才看得到，@echo 一下'],
    ];
    const idByWho = { admin: a, bob: b };
    let i = 0;
    for (const [who, text] of script) {
      i += 1;
      await idByWho[who].call('message.send', {
        conv_id: conv.id,
        client_msg_id: `seed-${Date.now()}-${i}`,
        content: [{ type: 'text', text }],
      });
    }
    console.log(`  发了 ${script.length} 条演示消息`);
  } else {
    console.log(`  已有 ${history.messages.length} 条消息，跳过`);
  }

  a.close();
  b.close();

  const lines = [
    `打开：${base}/`,
    '',
    `管理员  admin / ${PASSWORD}   → 管理页 ${base}/#/admin`,
    `普通用户 bob   / ${PASSWORD}`,
    `普通用户 carol / ${PASSWORD}`,
  ];
  if (agentToken !== null) {
    lines.push('', `Agent token（只这次可见）:`, agentToken);
    lines.push('', `跑起来：AGENTLINK_URL=${wsUrl} AGENTLINK_TOKEN=<上面那串> \\`);
    lines.push('        node examples/echo-agent/index.mjs');
  }
  banner(lines);
}

await main();