#!/usr/bin/env node
/**
 * llm-host-agent：把四象限工具权限接到**真 LLM 的 function-calling** 上。
 *
 * 与 host-agent 的区别：host-agent 是命令式（`!exec xxx`），这个是自然语言驱动 ——
 * 模型自己决定调不调工具、调哪个。于是风险从"人打错命令"变成"模型被诱导"。
 *
 * 所以护栏的位置**必须**变：
 *
 *   ❌ 靠 system prompt 说"不要执行危险命令"        ← 提示词能被绕
 *   ✅ 执行层强制：每次工具调用先过服务端授权；
 *      危险命令必须让真人回「确认」才执行              ← 代码挡得住
 *
 * 流程：
 *   消息 → 按四象限算出可用工具 → 作为 tools 传给 LLM
 *        → LLM 返回 tool_calls → 逐个：服务端授权 → (危险? 人工确认) → 执行
 *        → 结果回灌给 LLM → 直到它给出最终文本
 *
 * 用法：
 *   AGENTLINK_URL=ws://127.0.0.1:3000/ws \
 *   AGENTLINK_TOKEN=ag_... \
 *   LLM_BASE_URL=https://api.openai.com/v1 \
 *   LLM_API_KEY=sk-... \
 *   LLM_MODEL=gpt-4o-mini \
 *   node examples/llm-host-agent/index.mjs
 *
 * 没有 LLM_API_KEY 时会退化成"不调工具的纯文本回复"，方便本地验证链路。
 */
import { exec, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Client } from '@agentlink/agent-sdk';
import { isToolAllowed, toolTierFor, toolsForTier } from '@agentlink/protocol';

const execFileP = promisify(execFile);
const execP = promisify(exec);

const url = process.env.AGENTLINK_URL ?? 'ws://127.0.0.1:3000/ws';
const token = process.env.AGENTLINK_TOKEN;
const baseUrl = (process.env.LLM_BASE_URL ?? 'https://api.openai.com/v1').replace(/\/$/, '');
const apiKey = process.env.LLM_API_KEY;
const model = process.env.LLM_MODEL ?? 'gpt-4o-mini';
/** 一轮对话里最多几轮工具调用（防止模型自己绕圈）。 */
const MAX_TOOL_ROUNDS = 5;

if (!token) {
  console.error('[llm-host-agent] 缺少 AGENTLINK_TOKEN 环境变量');
  process.exit(1);
}

// ---------------------------------------------------------------------------
// 工具实现（与 host-agent 同源：沙箱只读 + Host Root 全权限）
// ---------------------------------------------------------------------------

const SANDBOX_READABLE_DIRS = ['/home', '/tmp', '/var/log'];
const SANDBOX_READABLE_FILES = ['/etc/hostname', '/etc/os-release', '/etc/hosts'];
const CAT_MAX_BYTES = 256 * 1024;

function isAllowedReadPath(p) {
  const abs = p.startsWith('/') ? p : `/${p}`;
  if (SANDBOX_READABLE_FILES.includes(abs)) return true;
  return SANDBOX_READABLE_DIRS.some((d) => abs === d || abs.startsWith(`${d}/`));
}

const DANGEROUS_PATTERNS = [
  /\brm\s+(-[a-zA-Z]*r[a-zA-Z]*f?|--recursive)\b/i,
  /\brm\s+-\w*f\w*\b/i,
  /\bdd\b.*\bof=/i,
  /\bmkfs/i,
  /\bshutdown\b|\breboot\b|\bpoweroff\b/i,
  /\b>\s*\/dev\/sd/i,
  /\bchmod\s+-R\b|\bchown\s+-R\b/i,
  /\bcurl\b.*\|\s*(sh|bash)\b/i,
  /\b(sudo|su)\b/i,
];

function isDangerous(command) {
  return DANGEROUS_PATTERNS.some((re) => re.test(command));
}

/** 工具实现表：名字 → { schema, run }。schema 直接用作 OpenAI tools 定义。 */
const TOOL_IMPL = {
  whoami: {
    schema: { type: 'function', function: { name: 'whoami', description: '当前用户名', parameters: { type: 'object', properties: {} } } },
    run: async () => (await execFileP('whoami')).stdout,
  },
  pwd: {
    schema: { type: 'function', function: { name: 'pwd', description: '当前工作目录', parameters: { type: 'object', properties: {} } } },
    run: async () => (await execFileP('pwd')).stdout,
  },
  uname: {
    schema: { type: 'function', function: { name: 'uname', description: '内核/系统信息', parameters: { type: 'object', properties: {} } } },
    run: async () => (await execFileP('uname', ['-a'])).stdout,
  },
  uptime: {
    schema: { type: 'function', function: { name: 'uptime', description: '开机时长与负载', parameters: { type: 'object', properties: {} } } },
    run: async () => (await execFileP('uptime')).stdout,
  },
  df: {
    schema: { type: 'function', function: { name: 'df', description: '磁盘用量', parameters: { type: 'object', properties: {} } } },
    run: async () => (await execFileP('df', ['-h'])).stdout,
  },
  free: {
    schema: { type: 'function', function: { name: 'free', description: '内存用量', parameters: { type: 'object', properties: {} } } },
    run: async () => (await execFileP('free', ['-h'])).stdout,
  },
  ps: {
    schema: { type: 'function', function: { name: 'ps', description: '进程列表', parameters: { type: 'object', properties: {} } } },
    run: async () => (await execFileP('ps', ['aux'])).stdout,
  },
  ls: {
    schema: {
      type: 'function',
      function: {
        name: 'ls',
        description: '列出目录（仅白名单目录：/home /tmp /var/log）',
        parameters: { type: 'object', properties: { path: { type: 'string', description: '目录路径' } }, required: ['path'] },
      },
    },
    run: async ({ path: p = '/tmp' } = {}) => {
      if (!isAllowedReadPath(p)) throw new Error(`路径 ${p} 不在沙箱白名单内`);
      return (await execFileP('ls', ['-lah', p])).stdout;
    },
  },
  cat: {
    schema: {
      type: 'function',
      function: {
        name: 'cat',
        description: '读文件（仅白名单目录，最多 256KiB）',
        parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
      },
    },
    run: async ({ path: p } = {}) => {
      if (!isAllowedReadPath(p)) throw new Error(`路径 ${p} 不在沙箱白名单内`);
      const r = await execFileP('cat', [p]);
      const out = r.stdout;
      return Buffer.byteLength(out) > CAT_MAX_BYTES ? `${out.slice(0, CAT_MAX_BYTES)}\n…（截断）` : out;
    },
  },
  exec: {
    schema: {
      type: 'function',
      function: {
        name: 'exec',
        description: '执行任意 shell 命令（全权限，仅服主私聊可用）',
        parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] },
      },
    },
    run: async ({ command } = {}) => {
      if (!command || command.trim() === '') throw new Error('exec 需要 command 参数');
      const r = await execP(command, { timeout: 30_000 });
      return `${r.stdout ?? ''}${r.stderr ? `(stderr) ${r.stderr}` : ''}`.trim() || '(无输出)';
    },
  },
};

/**
 * 按层级给出 OpenAI tools 定义。
 *
 * 注意：给模型看的 tools 只是"提议范围"，真正的门在服务端授权 ——
 * 模型即便硬编一个不存在的工具名，也过不了 `agent.tool.request`。
 */
function toolsFor(tier) {
  return toolsForTier(tier)
    .filter((name) => name in TOOL_IMPL)
    .map((name) => TOOL_IMPL[name].schema);
}

// ---------------------------------------------------------------------------
// LLM 调用（OpenAI 兼容 chat/completions，非流式；工具轮次需要完整的 tool_calls）
// ---------------------------------------------------------------------------

async function chatCompletions(messages, tools) {
  const body = {
    model,
    messages,
    temperature: 0.3,
    ...(tools.length === 0 ? {} : { tools, tool_choice: 'auto' }),
  };
  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`LLM 请求失败: ${res.status} ${await res.text()}`);
  }
  const json = await res.json();
  const choice = json.choices?.[0];
  if (!choice) throw new Error('LLM 返回里没有 choices');
  return { message: choice.message ?? {}, finish: choice.finish_reason };
}

// ---------------------------------------------------------------------------
// agent 主体
// ---------------------------------------------------------------------------

const client = new Client({
  url,
  token,
  onlyMentions: true,
  logger: (level, msg) => console.log(`[llm-host-agent] ${level}: ${msg}`),
});

const startedAt = Date.now();
const REPLAY_GRACE_MS = 2_000;

/**
 * 待人工确认的危险工具调用。
 * map: convId → { toolCall, messages, ctx }
 *
 * 存 messages 是为了在用户回「确认」之后能接着推进 LLM 的多轮对话，
 * 而不是从头再来一遍（模型会重新规划，可能又提出同样的命令，陷入循环）。
 */
const pendingConfirm = new Map();

function hostId() {
  // 显式配置优先，没配才回退到创建者（与 docs/TOOL-TIERS.md 一致）
  return client.hostOwnerId ?? client.ownerUserId;
}

client.onMessage(async (ctx) => {
  const createdAt = ctx.message.created_at ?? 0;
  if (createdAt > 0 && createdAt < startedAt - REPLAY_GRACE_MS) return;

  const text = ctx.text.trim();
  const stream = await ctx.client.stream(ctx.convId, { replyTo: ctx.message.id });
  let wrote = false;
  const say = async (s) => {
    wrote = true;
    for (const ch of [...s]) {
      if (stream.interrupted) return;
      await stream.write(ch);
      await new Promise((r) => setTimeout(r, 6));
    }
  };

  try {
    // ---- 人工确认分支 ----
    const pending = pendingConfirm.get(ctx.convId);
    if (pending !== undefined) {
      if (/^(确认|yes|y)$/i.test(text)) {
        pendingConfirm.delete(ctx.convId);
        await say(`执行：${pending.toolCall.function.arguments}\n`);
        const out = await executeToolCall(pending.toolCall, ctx);
        await say(out);
      } else if (/^(取消|no|n)$/i.test(text)) {
        pendingConfirm.delete(ctx.convId);
        await say('已取消。');
      } else {
        await say('有个危险操作在等你确认：回复「确认」执行，或「取消」放弃。');
      }
      await stream.commit();
      return;
    }

    // ---- 四象限：本地算层级（只用于给模型挑选 tools 的范围）----
    const senderId = ctx.message.sender.id;
    const isHost = hostId() !== null && senderId === hostId();
    const tier = toolTierFor(ctx.convKind, isHost);
    const tools = toolsFor(tier);

    const systemPrompt =
      tier === 'host-root'
        ? '你是服主的全权限终端助手。可以用 exec 执行任意命令，也可以读系统状态。回答简洁，用中文。'
        : tier === 'sandbox'
          ? '你是服主的沙箱助手，只能做只读查询（ls/cat/df/ps 等），没有写权限。回答简洁，用中文。'
          : '你是聊天助手。你没有系统工具，只能用已有知识回答问题。回答简洁，用中文。';

    // ---- 多轮工具调用 ----
    const messages = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: text },
    ];

    for (let round = 0; round < MAX_TOOL_ROUNDS; round += 1) {
      if (!apiKey) {
        // 没有 key：不调工具，直接说明（保证链路可验证）
        await say(tier === 'none' ? '（未配置 LLM_API_KEY）收到。' : `（未配置 LLM_API_KEY）当前层级 ${tier}。`);
        break;
      }

      const { message } = await chatCompletions(messages, tools);
      const toolCalls = message.tool_calls ?? [];

      if (toolCalls.length === 0) {
        await say(message.content ?? '(空回复)');
        break;
      }

      messages.push(message);

      let awaitingConfirm = false;
      for (const call of toolCalls) {
        const name = call.function?.name;
        const rawArgs = call.function?.arguments ?? '{}';
        let args = {};
        try {
          args = JSON.parse(rawArgs);
        } catch {
          args = {};
        }

        // 危险命令：不执行，先问人（护栏在**执行层**，不靠提示词）
        if (name === 'exec' && isDangerous(String(args.command ?? ''))) {
          pendingConfirm.set(ctx.convId, { toolCall: call, messages, ctx });
          await say(
            `⚠️ 模型想执行这条危险命令：\n  ${String(args.command ?? '')}\n\n回复「确认」执行，或「取消」放弃。`,
          );
          awaitingConfirm = true;
          break;
        }

        const out = await executeToolCall(call, ctx);
        messages.push({ role: 'tool', tool_call_id: call.id, content: out.slice(0, 4000) });
      }
      if (awaitingConfirm) break;
    }

    if (!wrote) await say('（没有产生回复）');
    await stream.commit();
  } catch (err) {
    console.error('[llm-host-agent] 处理失败', err);
    try {
      await stream.abort(err instanceof Error ? err.message : '处理失败');
    } catch {
      /* 已关闭 */
    }
  }
});

/**
 * 执行一次工具调用。**先向服务端申请授权**，被拒直接返回拒绝说明（不执行）。
 */
async function executeToolCall(call, ctx) {
  const name = call.function?.name ?? '';
  let args = {};
  try {
    args = JSON.parse(call.function?.arguments ?? '{}');
  } catch {
    args = {};
  }

  const impl = TOOL_IMPL[name];
  if (impl === undefined) return `（没有 ${name} 这个工具）`;

  const preview = name === 'exec' ? String(args.command ?? '') : JSON.stringify(args);

  try {
    await ctx.client.requestTool({
      convId: ctx.convId,
      tool: name,
      argsPreview: preview,
      triggeredBy: ctx.message.sender.id,
      messageId: ctx.message.id,
    });
  } catch (err) {
    // 服务端拒绝 → 绝不执行
    return `服务端拒绝了这次 ${name} 调用：${err.message}`;
  }

  try {
    return await impl.run(args);
  } catch (err) {
    return `工具执行失败：${err.message}`;
  }
}

await client.connect();
console.log(
  `[llm-host-agent] 已连接（owner=${client.ownerUserId ?? '?'} host=${client.hostOwnerId ?? '(未配置)'} llm=${apiKey ? model : '未配置'}）`,
);

const shutdown = () => {
  client.disconnect();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
