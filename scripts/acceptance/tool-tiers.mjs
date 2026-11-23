#!/usr/bin/env node
/**
 * tool-tiers 验收：agent 的「会话类型 × 发送者身份」四级工具权限。
 *
 * 就是那张四象限图：
 *   群聊 + 普通群友 → 纯问答，不挂工具
 *   群聊 + 服主     → 沙箱只读工具
 *   私聊 + 普通群友 → 个人助理
 *   私聊 + 服主     → Host Root 全权限
 *
 * 本套件真跑 `examples/host-agent`，用真实消息验证：
 *   1. 服务端 auth 响应带上了 owner_user_id / host_owner_id
 *   2. 私聊里 agent **不 @ 也能收到**消息（only_mentions 不该管私聊）
 *   3. 四个象限各自拿到正确的工具集
 *   4. 沙箱白名单真的挡住了越权读（cat /etc/shadow 之类）
 *   5. Host Root 的危险命令必须先二次确认才执行
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { section, summary, ok, eq, includes as includesText, expectOk } from './_assert.mjs';
import { WsClient } from './_client.mjs';

export const needsServer = true;
export const relaxedRateLimit = true;

/**
 * 服务端启动前注入服主 id。
 *
 * 但服主 id 要等第一个用户注册后才知道 —— 所以这里不设 HOST_OWNER_ID，
 * 走"回退到 agent 的 owner_user_id"这条路径测；单独再测一遍显式配置。
 * （显式配置那条在 suiteEnv 里做不到，因为 id 是运行时生成的，
 *   见本文件末尾的说明。）
 */
export const serverEnv = {};

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

/**
 * 发一条消息，等 agent **在这个会话里**的流式回复 commit，返回回复全文。
 *
 * 两个坑（都踩过）：
 *   1. 同一个 watcher 能看到它所有会话的事件 —— 必须按 conv_id 过滤。
 *   2. 同一会话里**上一条**消息的回复可能还躺在缓冲区里 —— 发之前先清掉，
 *      否则会把上一条的答案当成这一条的（表现为"答非所问"）。
 */
async function askAndCollect(watcher, convId, text, timeoutMs = 25_000) {
  // 清掉这个会话里残留的旧回复事件
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

  // 精确匹配：只认 reply_to == 我们这条消息的 final。
  // 只按 conv_id 匹配不够 —— 同一会话里可能有别的回复（比如补发的旧消息）。
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
      // 不是回复我们这条的（例如补发旧消息的答复）→ 丢掉继续等
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

  // alice = 服主（她建 agent，所以 owner_user_id 是她）
  const alice = await mkUser(http, 'alice', '爱丽丝');
  const bob = await mkUser(http, 'bob', '小明');

  section('1. 建 agent（alice 是 owner）');
  const agentRes = await http('POST', '/api/admin/agents', {
    token: alice.access_token,
    body: { username: 'host', display_name: '宿主助手' },
  });
  if (agentRes.status !== 201) throw new Error(`建 agent 失败: ${agentRes.text}`);
  const agentToken = agentRes.body.token;
  const agentId = agentRes.body.agent.id;
  ok(true, `agent = ${agentId}`);

  section('2. auth 响应带出 owner_user_id（工具分级的关键输入）');
  const agentConn = await connect(wsUrl, agentToken);
  eq(agentConn.self.id, agentId, 'agent 的 self.id 正确');
  eq(agentConn.self.kind, 'agent', 'self.kind = agent');
  eq(agentConn.self.owner_user_id, alice.user.id, 'owner_user_id 指向 alice（建 agent 的人）');
  // 服务端没配 HOST_OWNER_ID → 不带这个字段（agent 会回退到 owner）
  eq(agentConn.self.host_owner_id ?? null, null, '未配置 HOST_OWNER_ID 时不带该字段');

  const aliceConn = await connect(wsUrl, alice.access_token);
  eq(aliceConn.self.is_admin, true, 'alice 是管理员（第一个注册）');

  // 起 agent 进程
  section('3. 启动 examples/host-agent');
  const agent = startAgent(path.join(repoRoot, 'examples/host-agent/index.mjs'), {
    AGENTLINK_URL: wsUrl,
    AGENTLINK_TOKEN: agentToken,
  });
  const up = await waitForLog(agent, '已连接');
  ok(up, 'host-agent 已连接');
  if (!up) {
    console.log('--- agent 日志 ---');
    console.log(agent.logs());
  }
  ok(
    agent.logs().includes(`owner=${alice.user.id}`),
    `日志里报出了 owner（${alice.user.id}）`,
  );

  // 建一个群（alice + bob + agent）
  const group = expectOk(
    await aliceConn.client.request('conv.create', {
      kind: 'group',
      title: '四象限测试群',
      member_ids: [bob.user.id, agentId],
    }),
    '建群',
  ).conv;

  // 建两个私聊：alice↔agent、bob↔agent
  const dmHost = expectOk(
    await aliceConn.client.request('conv.create', {
      kind: 'dm',
      member_ids: [agentId],
    }),
    'alice 与 agent 的私聊',
  ).conv;
  eq(dmHost.kind, 'dm', '私聊 kind = dm');

  const bobConn = await connect(wsUrl, bob.access_token);
  const dmBob = expectOk(
    await bobConn.client.request('conv.create', {
      kind: 'dm',
      member_ids: [agentId],
    }),
    'bob 与 agent 的私聊',
  ).conv;

  try {
    // ---- 象限 1：群聊 + 普通群友 → 纯问答，不挂工具 ----
    section('4. 象限①：群聊 + 普通群友 → 纯问答（不挂工具）');
    // bob 在群里 @agent，让它 ls
    const q1 = await askAndCollect(bobConn.client, group.id, '@host !ls /tmp');
    includesText(q1, '没有挂载工具', '群聊里普通群友调工具被拒（不挂工具）');

    // ---- 象限 2：群聊 + 服主 → 沙箱只读 ----
    section('5. 象限②：群聊 + 服主 → 沙箱只读工具');
    const q2 = await askAndCollect(aliceConn.client, group.id, '@host !ls /tmp');
    ok(!q2.includes('没有挂载工具'), '服主在群里能用工具');
    ok(q2.length > 0 && !q2.startsWith('工具执行失败'), `沙箱 ls 执行成功（输出 ${q2.length} 字符）`);

    // 沙箱白名单：读 /etc/shadow 应被挡
    const q2b = await askAndCollect(aliceConn.client, group.id, '@host !cat /etc/shadow');
    includesText(q2b, '不在沙箱白名单内', '沙箱挡住了越权读（/etc/shadow）');

    // 沙箱里没有 exec（全权限工具）
    const q2c = await askAndCollect(aliceConn.client, group.id, '@host !exec id');
    includesText(q2c, '没有「exec」这个工具', '沙箱里没有 exec（全权限工具不挂载）');

    // ---- 象限 3：私聊 + 普通群友 → 个人助理（也不挂工具）----
    section('6. 象限③：私聊 + 普通群友 → 个人助理（不挂工具）');
    const q3 = await askAndCollect(bobConn.client, dmBob.id, '!ls /tmp');
    includesText(q3, '没有挂载工具', '普通群友私聊里调工具被拒');
    ok(!q3.includes('全权限'), '普通群友私聊拿不到全权限提示');

    // ---- 关键：私聊里不 @ 也能收到消息 ----
    section('7. 私聊不需要 @（only_mentions 不管私聊）');
    const plainText = '你好，帮我看看你是谁';
    const q7 = await askAndCollect(bobConn.client, dmBob.id, plainText);
    ok(q7.length > 0, `私聊不 @ 也收到了回复（${q7.slice(0, 40)}）`);
    ok(!q7.includes('没有挂载工具'), '这是一条普通问答回复（assistant 模式）');

    // ---- 象限 4：私聊 + 服主 → Host Root 全权限 ----
    section('8. 象限④：私聊 + 服主 → Host Root 全权限');
    const q4 = await askAndCollect(aliceConn.client, dmHost.id, '!exec echo hello-from-host-root');
    includesText(q4, 'hello-from-host-root', '服主私聊里 exec 真的执行了命令');

    // ---- 护栏：危险命令要二次确认 ----
    section('9. 护栏：危险命令必须二次确认');
    const q9 = await askAndCollect(aliceConn.client, dmHost.id, '!exec rm -rf /tmp/should-not-run');
    includesText(q9, '看起来危险', '危险命令被拦下，要求确认');
    includesText(q9, '确认', '提示里说明了怎么确认');

    // 不确认就发别的：仍然要求确认，不执行
    const q9b = await askAndCollect(aliceConn.client, dmHost.id, '随便说点什么');
    includesText(q9b, '还在等你确认', '未确认时不会执行，也不会被绕过');

    // 取消
    const q9c = await askAndCollect(aliceConn.client, dmHost.id, '取消');
    includesText(q9c, '已取消', '取消后清除待确认状态');

    // ---- 护栏：普通群友在私聊里发危险命令也不会被当服主 ----
    section('10. 护栏：普通群友私聊拿不到全权限');
    const q10 = await askAndCollect(bobConn.client, dmBob.id, '!exec id');
    includesText(q10, '没有挂载工具', '普通群友私聊里没有 exec');

    // ---- 审计：每次工具执行都在服务端留痕 ----
    section('10b. 审计日志：工具执行真的落到服务端');
    const audit = await http('GET', '/api/admin/audit?limit=100', {
      token: alice.access_token,
    });
    eq(audit.status, 200, '管理员能读审计日志');
    const items = audit.body.items;
    const toolRows = items.filter((r) => String(r.action).startsWith('tool.'));
    ok(toolRows.length > 0, `审计里有 ${toolRows.length} 条工具执行记录`);

    // exec 的记录：detail 里要有触发者、层级、参数预览
    const execRows = toolRows.filter((r) => r.action === 'tool.exec');
    ok(execRows.length > 0, '有 tool.exec 的记录（全权限命令留痕）');
    const execRow = execRows[0];
    eq(execRow.actor_id, agentId, 'actor 是 agent 自己');
    eq(execRow.target_type, 'tool', 'target_type = tool');
    ok(
      typeof execRow.detail.args_preview === 'string' &&
        execRow.detail.args_preview.includes('echo'),
      `detail 里有命令预览（${JSON.stringify(execRow.detail.args_preview)}）`,
    );
    eq(execRow.detail.triggered_by, alice.user.id, 'detail 记下了触发者（alice）');
    eq(execRow.detail.tier, 'host-root', 'detail 记下了层级 host-root');

    // 沙箱的 ls 记录也在，且层级是 sandbox
    const lsRow = toolRows.find((r) => r.action === 'tool.ls' && r.detail.tier === 'sandbox');
    ok(lsRow !== undefined, 'tool.ls 记录带 sandbox 层级');

    // 管理页的 action 下拉能筛出这些动作
    ok(
      (audit.body.actions ?? []).includes('tool.exec'),
      'actions 列表里出现 tool.exec（管理页可筛选）',
    );

    // ---- 服务端是权威：不经 agent，直接伪造申请也会被拒 ----
    section('10c. 服务端权威：越权申请被服务端拒绝');
    // agent 连接自己去申请"帮普通群友执行 exec"
    const forge = await agentConn.client.request('agent.tool.request', {
      conv_id: dmBob.id,
      tool: 'exec',
      args_preview: 'rm -rf /',
      triggered_by: bob.user.id,
    });
    eq(forge.ok, false, '普通群友触发的 exec 被服务端拒绝');
    eq(forge.error.code, 'PERM_DENIED', '错误码是 PERM_DENIED');
    eq(forge.error.details?.tier, 'none', '服务端判出的层级是 none');
    eq((forge.error.details?.allowed ?? []).length, 0, 'none 层级下没有可用工具');

    // 群里服主触发 exec → 也应该被拒（群里只有 sandbox）
    const forgeGroup = await agentConn.client.request('agent.tool.request', {
      conv_id: group.id,
      tool: 'exec',
      args_preview: 'id',
      triggered_by: alice.user.id,
    });
    eq(forgeGroup.ok, false, '群聊里服主申请 exec 被拒（群里只有沙箱）');
    eq(forgeGroup.error.details?.tier, 'sandbox', '服务端判出的层级是 sandbox');

    // 人类客户端不能冒充 agent
    const asHuman = await aliceConn.client.request('agent.tool.request', {
      conv_id: group.id,
      tool: 'ls',
      args_preview: '/tmp',
      triggered_by: alice.user.id,
    });
    eq(asHuman.ok, false, '人类账号调 agent.tool.request 被拒');

    // 伪造非成员当触发者 → 也拒
    const outsider = await mkUser(http, 'outsider', '外人');
    const forgeOutsider = await agentConn.client.request('agent.tool.request', {
      conv_id: group.id,
      tool: 'ls',
      args_preview: '/tmp',
      triggered_by: outsider.user.id,
    });
    eq(forgeOutsider.ok, false, '触发者不是会话成员时被拒');

    // ---- 告警：全权限命令与被拒尝试都要能实时通知管理员 ----
    section('10d. 告警：exec 与被拒尝试实时推给管理员');
    // alice 是管理员：她应当收到前面 exec 的 tool.alert
    const execAlert = await aliceConn.client
      .nextEvent((e) => e.type === 'tool.alert' && e.data?.kind === 'exec', 8000)
      .catch(() => null);
    ok(execAlert !== null, '管理员收到 kind=exec 的告警');
    if (execAlert !== null) {
      eq(execAlert.data.tool, 'exec', '告警里 tool = exec');
      eq(execAlert.data.tier, 'host-root', '告警里 tier = host-root');
      ok(
        typeof execAlert.data.args_preview === 'string' &&
          execAlert.data.args_preview.length > 0,
        `告警里带命令预览（${JSON.stringify(execAlert.data.args_preview)}）`,
      );
      ok(typeof execAlert.data.audit_id === 'string' && execAlert.data.audit_id.length > 0,
        '告警里带 audit_id（能对到具体审计行）');
    }

    // 被拒的尝试也要告警（这是最容易漏的一类信号）
    const deniedAlert = await aliceConn.client
      .nextEvent((e) => e.type === 'tool.alert' && e.data?.kind === 'denied', 8000)
      .catch(() => null);
    ok(deniedAlert !== null, '管理员收到 kind=denied 的告警（有人试图越权）');
    if (deniedAlert !== null) {
      eq(deniedAlert.data.triggered_by, bob.user.id, '告警里触发者是 bob（试图越权的人）');
      eq(deniedAlert.data.tier, 'none', '告警里 tier = none');
    }

    // 被拒也必须留痕：audit 里有 tool.denied
    const deniedAudit = await http('GET', '/api/admin/audit?limit=50&action=tool.denied', {
      token: alice.access_token,
    });
    eq(deniedAudit.status, 200, '能查 tool.denied');
    ok(
      (deniedAudit.body.items ?? []).length > 0,
      `被拒尝试留痕 ${deniedAudit.body.items?.length ?? 0} 条（失败的尝试也要可追溯）`,
    );
    // 有两条 denied：bob 在私聊试探 exec、alice 在群里申请 exec。
    // 不能取 [0]（时间倒序，不一定是我们要的那条），按触发者找。
    const bobDenied = (deniedAudit.body.items ?? []).find(
      (r) => r.detail.triggered_by === bob.user.id,
    );
    ok(bobDenied !== undefined, 'tool.denied 里有 bob 那条（私聊试探 exec）');
    eq(bobDenied?.detail.tier, 'none', 'bob 那条 tier = none');
    ok(
      Array.isArray(bobDenied?.detail.allowed),
      'tool.denied 记录了当时允许的工具清单（便于判断是不是在探测）',
    );
    const groupDenied = (deniedAudit.body.items ?? []).find(
      (r) => r.detail.triggered_by === alice.user.id && r.detail.tier === 'sandbox',
    );
    ok(groupDenied !== undefined, '也记录了"群聊里申请 exec"被拒（tier=sandbox）');

    // 普通群友（bob，非管理员）不该收到告警
    const bobGotAlert = bobConn.client.events.some((e) => e.type === 'tool.alert');
    eq(bobGotAlert, false, '非管理员收不到工具告警（只发给管理员）');

    // ---- HOST_OWNER_ID 显式配置：服主可以不是 agent 的创建者 ----
    section('11. HOST_OWNER_ID 显式配置：服主换成 bob');
    // 关键：先停掉旧 agent。否则服务端重启后它会**自动重连**，
    // 与下面新起的 agent2 抢着回复（旧进程还认为服主是 alice）。
    await agent.stop();
    // restart 会换端口，必须用返回句柄里的新地址（ctx.wsUrl 已失效）
    const h2 = await ctx.restartServer({ HOST_OWNER_ID: bob.user.id });
    ok(h2 !== null && h2 !== undefined, '服务端带 HOST_OWNER_ID 重启');
    const wsUrl2 = h2.wsUrl;

    // 重启后旧连接都断了：重新连 + 重启 agent
    const aliceConn2 = await connect(wsUrl2, alice.access_token);
    const bobConn2 = await connect(wsUrl2, bob.access_token);
    eq(aliceConn2.self.is_admin, true, '重启后 alice 仍是管理员');
    eq(bobConn2.self.host_owner_id, bob.user.id, 'auth 响应带出了 HOST_OWNER_ID');

    // agent 重新连，读新的 auth 响应
    const agent2 = startAgent(path.join(repoRoot, 'examples/host-agent/index.mjs'), {
      AGENTLINK_URL: wsUrl2,
      AGENTLINK_TOKEN: agentToken,
    });
    ok(await waitForLog(agent2, '已连接'), 'agent 在重启后重连');
    ok(
      agent2.logs().includes(`host=${bob.user.id}`),
      `agent 读到了新的服主（bob=${bob.user.id}）`,
    );

    try {
      // 服主换成 bob 之后：bob 的私聊有全权限，alice（原 owner）反而降级
      const q11 = await askAndCollect(bobConn2.client, dmBob.id, '!exec echo now-host-is-bob');
      includesText(q11, 'now-host-is-bob', 'bob 现在拿到了 Host Root 权限');

      const q11b = await askAndCollect(aliceConn2.client, dmHost.id, '!exec echo should-be-denied');
      includesText(
        q11b,
        '没有挂载工具',
        'alice 降级成普通群友（私聊里没有 exec）',
      );
    } finally {
      await agent2.stop();
    }
  } finally {
    await agent.stop();
  }

  return summary('tool-tiers');
}
