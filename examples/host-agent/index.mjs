#!/usr/bin/env node
/**
 * host-agent：按「会话类型 × 发送者身份」分级的工具权限 agent。
 *
 * 这就是那张四象限图：
 *
 *   ┌─────────────┬──────────────────┬──────────────────┐
 *   │             │ 群聊 group        │ 私聊 dm          │
 *   ├─────────────┼──────────────────┼──────────────────┤
 *   │ 普通群友     │ 纯问答（无工具）   │ 个人助理/答疑     │
 *   │ 服主本人     │ 沙箱只读工具       │ Host Root 全权限  │
 *   └─────────────┴──────────────────┴──────────────────┘
 *
 * 用法（本地验证不需要 LLM key，纯命令式）：
 *   AGENTLINK_URL=ws://127.0.0.1:3000/ws \
 *   AGENTLINK_TOKEN=ag_... \
 *   node examples/host-agent/index.mjs
 *
 * 服主是谁：服务端 `HOST_OWNER_ID` 显式指定的 user id；没配置就回退到
 * 创建这个 agent 的人（auth 响应里的 owner_user_id）。
 *
 * 消息格式（命令式，便于离线验证；接 LLM 时把工具集转成 function-calling tools 即可）：
 *   !ls /tmp           执行沙箱只读工具
 *   !exec uptime       执行全权限命令（只对私聊+服主开放，危险命令要二次确认）
 *   其他任意文本       普通问答（按象限给不同的助手人设）
 */
import { exec, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Client } from '@agentlink/agent-sdk';

const execFileP = promisify(execFile);
const execP = promisify(exec);

const url = process.env.AGENTLINK_URL ?? 'ws://127.0.0.1:3000/ws';
const token = process.env.AGENTLINK_TOKEN;

if (!token) {
  console.error('[host-agent] 缺少 AGENTLINK_TOKEN 环境变量');
  process.exit(1);
}

// ---------------------------------------------------------------------------
// 工具集：schema 化（name / description / args / run），与 MCP tool 同一形态。
// ---------------------------------------------------------------------------

/**
 * 沙箱允许读的目录白名单。
 *
 * **不要把 `/etc` 整个放进来**：那等于允许读 `/etc/shadow`（密码哈希）、
 * `/etc/ssh/*`（主机私钥）——进程是 root 时这些就是服务器完整沦陷。
 * 所以 /etc 下只放行几个"事实性"的公开文件。
 */
const SANDBOX_READABLE_DIRS = ['/home', '/tmp', '/var/log'];
/** /etc 下单独放行的文件（都是非敏感的系统标识信息）。 */
const SANDBOX_READABLE_FILES = ['/etc/hostname', '/etc/os-release', '/etc/hosts'];
/** cat 的文件大小上限（字节），防读到超大文件把进程打爆。 */
const CAT_MAX_BYTES = 256 * 1024;

function isAllowedReadPath(p) {
  const abs = p.startsWith('/') ? p : `/${p}`;
  if (SANDBOX_READABLE_FILES.includes(abs)) return true;
  return SANDBOX_READABLE_DIRS.some((d) => abs === d || abs.startsWith(`${d}/`));
}

/** 沙箱只读工具：无副作用，只看系统状态。 */
const sandboxTools = {
  whoami: { desc: '当前用户名', args: [], run: () => execFileP('whoami') },
  pwd: { desc: '当前工作目录', args: [], run: () => execFileP('pwd') },
  uname: { desc: '内核/系统信息', args: [], run: () => execFileP('uname', ['-a']) },
  uptime: { desc: '开机时长与负载', args: [], run: () => execFileP('uptime') },
  df: { desc: '磁盘用量', args: [], run: () => execFileP('df', ['-h']) },
  free: { desc: '内存用量', args: [], run: () => execFileP('free', ['-h']) },
  ps: { desc: '进程列表', args: [], run: () => execFileP('ps', ['aux']) },
  ls: {
    desc: '列出目录（白名单目录）',
    args: ['path'],
    run: (path = '/tmp') => {
      if (!isAllowedReadPath(path)) return Promise.reject(new Error(`路径 ${path} 不在沙箱白名单内`));
      return execFileP('ls', ['-lah', path]);
    },
  },
  cat: {
    desc: '读文件（白名单目录 + ≤256KiB）',
    args: ['path'],
    run: (path) => {
      if (!isAllowedReadPath(path)) return Promise.reject(new Error(`路径 ${path} 不在沙箱白名单内`));
      return execFileP('cat', [path]).then((r) => {
        if (Buffer.byteLength(r.stdout) > CAT_MAX_BYTES) {
          return { stdout: `${r.stdout.slice(0, CAT_MAX_BYTES)}\n…（截断，超 ${CAT_MAX_BYTES} 字节）`, stderr: '' };
        }
        return r;
      });
    },
  },
};

/** 危险命令模式：命中就要求服主二次确认（Host Root 的硬护栏）。 */
const DANGEROUS_PATTERNS = [
  /\brm\s+(-[a-zA-Z]*r[a-zA-Z]*f?|--recursive)\b/i, // rm -rf
  /\brm\s+-\w*f\w*\b/i, // rm -f
  /\bdd\b.*\bof=/i, // dd 写盘
  /\bmkfs/i, // 格式化
  /\bshutdown\b|\breboot\b|\bpoweroff\b/i, // 关机/重启
  /\b>\s*\/dev\/sd/i, // 写块设备
  /\bchmod\s+-R\b|\bchown\s+-R\b/i, // 递归改权限
  /\bcurl\b.*\|\s*(sh|bash)\b/i, // curl | sh 执行远程脚本
  /\b(sudo|su)\b/i, // 提权
];

function isDangerous(command) {
  return DANGEROUS_PATTERNS.some((re) => re.test(command));
}

/** Host Root 工具：全权限 shell。只有私聊 + 服主能挂载。 */
const hostTools = {
  exec: {
    desc: '执行任意 shell 命令（全权限）',
    args: ['command'],
    /** 单个参数是"整条命令"，其余词要拼回去（见 runTool）。 */
    shell: true,
    run: (command) => {
      if (command === undefined || command.trim() === '') {
        return Promise.reject(new Error('exec 需要一个命令参数'));
      }
      return execP(command, { timeout: 30_000 });
    },
  },
};

// ---------------------------------------------------------------------------
// 四象限路由
// ---------------------------------------------------------------------------

/**
 * 决定当前消息落在哪个象限，返回挂载的工具集 + 人设。
 *
 * `isHost`：发送者是服主（HOST_OWNER_ID 优先，回退 owner_user_id）。
 */
function route(ctx, client) {
  const senderId = ctx.message.sender.id;
  // 服主的判定：**显式配置优先，没配才回退到创建者**。
  // 不能写成 `hostOwnerId || ownerUserId` 的 OR —— 那样一旦显式配了别的人，
  // 创建者仍会被当成服主，等于权限没真正转移（验收抓到过）。
  const hostId = client.hostOwnerId ?? client.ownerUserId;
  const isHost = hostId !== null && senderId === hostId;
  const isDm = ctx.convKind === 'dm';

  if (isDm && isHost) {
    return { mode: 'host-root', tools: hostTools, persona: '你是服主的全权限终端助手。' };
  }
  if (!isDm && isHost) {
    return { mode: 'sandbox', tools: sandboxTools, persona: '你是服主的沙箱助手，只能做只读无害操作。' };
  }
  if (isDm) {
    return { mode: 'assistant', tools: {}, persona: '你是个人助理，答疑、聊天、给建议。' };
  }
  return { mode: 'basic-qa', tools: {}, persona: '你是群聊里的问答助手，回答简洁。' };
}

// ---------------------------------------------------------------------------
// agent 主体
// ---------------------------------------------------------------------------

const client = new Client({
  url,
  token,
  onlyMentions: true,
  logger: (level, msg) => console.log(`[host-agent] ${level}: ${msg}`),
});

/** 待二次确认的危险命令（map: convId → command）。 */
const pendingConfirm = new Map();

/**
 * 进程启动时刻。**早于它的消息一律不回复**。
 *
 * 为什么需要这道闸：agent 重连时 SDK 会用 `resume` 把断线期间的事件补回来。
 * 新起的进程 last_seq=0，等于把**全部历史**补一遍 —— 于是它会把几小时前
 * 别人 @ 过它的消息全部再答一遍，重启一次就刷一屏。
 * 补发是为了"不漏消息"，不是为了"重答旧问题"。
 */
const startedAt = Date.now();
const REPLAY_GRACE_MS = 2_000;

/** 把 execFile/exec 的 {stdout,stderr} 拼成给用户看的文本。 */
function fmtExecResult(r) {
  const out = (r.stdout ?? '').toString().trim();
  const err = (r.stderr ?? '').toString().trim();
  if (out && err) return `${out}\n(stderr) ${err}`;
  return out || err || '(无输出)';
}

async function runTool(tool, argv) {
  const args = tool.args ?? [];
  // `shell: true` 的工具（`exec <command>`）要把剩余所有词拼成一个参数 ——
  // 只取 argv[0] 会把 `echo hello world` 截成 `echo`（实测踩过）。
  // 路径类工具（ls / cat）不拼，避免把两个路径拼成一个不存在的路径。
  const argValues = tool.shell === true ? [argv.join(' ')] : args.map((_name, i) => argv[i]);
  const r = await tool.run(...argValues);
  return fmtExecResult(r);
}

client.onMessage(async (ctx) => {
  // 历史补发里的事件不回复（见 startedAt 的说明）
  const createdAt = ctx.message.created_at ?? 0;
  if (createdAt > 0 && createdAt < startedAt - REPLAY_GRACE_MS) {
    console.log(`[host-agent] 跳过历史消息 ${ctx.message.id}（${new Date(createdAt).toISOString()}）`);
    return;
  }

  const { mode, tools, persona } = route(ctx, client);
  const text = ctx.text.trim();
  const stream = await ctx.client.stream(ctx.convId, { replyTo: ctx.message.id });
  const say = async (s) => {
    for (const ch of [...s]) {
      if (stream.interrupted) return;
      await stream.write(ch);
      await new Promise((r) => setTimeout(r, 8));
    }
  };

  try {
    // ---- 二次确认流程（Host Root 护栏）----
    if (pendingConfirm.has(ctx.convId)) {
      if (/^(确认|yes|y)$/i.test(text)) {
        const command = pendingConfirm.get(ctx.convId);
        pendingConfirm.delete(ctx.convId);
        await say(`执行：${command}\n`);
        const r = await runTool(hostTools.exec, [command]);
        await say(r);
      } else if (/^(取消|no|n)$/i.test(text)) {
        pendingConfirm.delete(ctx.convId);
        await say('已取消。');
      } else {
        await say('上一条危险命令还在等你确认：回复「确认」执行，或「取消」放弃。');
      }
      await stream.commit();
      return;
    }

    // ---- 命令式工具调用：`!工具名 [参数...]` ----
    if (text.startsWith('!')) {
      const parts = text.slice(1).split(/\s+/).filter(Boolean);
      const toolName = parts[0];
      const argv = parts.slice(1);

      const tool = tools[toolName];
      if (tool === undefined) {
        await say(
          mode === 'basic-qa' || mode === 'assistant'
            ? '抱歉，我没有挂载工具。我在这里是问答/助理模式。'
            : `没有「${toolName}」这个工具。可用：${Object.keys(tools).join(' / ')}`,
        );
      } else {
        // Host Root 危险命令二次确认
        if (mode === 'host-root' && toolName === 'exec' && isDangerous(argv.join(' '))) {
          pendingConfirm.set(ctx.convId, argv.join(' '));
          await say(`⚠️ 这条命令看起来危险：\n  ${argv.join(' ')}\n\n回复「确认」执行，或「取消」放弃。`);
        } else {
          try {
            const result = await runTool(tool, argv);
            await say(result);
          } catch (err) {
            await say(`工具执行失败：${err.message}`);
          }
        }
      }
      await stream.commit();
      return;
    }

    // ---- 普通问答（无工具或纯聊天）----
    const intro = mode === 'host-root'
      ? '（全权限模式）收到。'
      : mode === 'sandbox'
        ? '（沙箱模式）收到。'
        : '收到。';
    const hint = mode === 'host-root'
      ? '用 !exec <命令> 执行任意命令。'
      : mode === 'sandbox'
        ? '用 !ls / !cat / !df 等做只读查询。'
        : '';
    await say(`${intro}${hint ? ` ${hint}` : ''}`);
    await stream.commit();
  } catch (err) {
    console.error('[host-agent] 处理失败', err);
    try {
      await stream.abort(err instanceof Error ? err.message : '处理失败');
    } catch {
      /* 已关闭 */
    }
  }
});

await client.connect();
console.log(
  `[host-agent] 已连接（owner=${client.ownerUserId ?? '?'} host=${client.hostOwnerId ?? '(未配置)'}）`,
);

const shutdown = () => {
  client.disconnect();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
