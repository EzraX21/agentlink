#!/usr/bin/env node
/**
 * AgentLink MCP server（stdio 传输）。
 *
 * 为什么要有它：AgentLink 本身**不接模型**，它提供消息通道；外部 AI 运行时
 * （Claude Code、DSH、openclaw…）拿 agent token 接进来收发消息。
 * MCP 是这类客户端的通用"工具协议" —— 挂上这个 server 就能直接用工具，
 * 不必自己拼 curl 或维护 WebSocket。
 *
 * 传输选 stdio 而不是 HTTP：MCP 客户端（Claude Code 等）默认就是
 * "spawn 一个子进程、按行读写 JSON-RPC"，这样零配置、不需要额外端口，
 * 也不会把 token 暴露在网络上。
 *
 * 协议实现刻意保持最小：initialize / tools/list / tools/call / ping。
 * 没有 resources、prompts、sampling —— 这个 server 的职责只有"操作消息通道"。
 *
 * 环境变量：
 *   AGENTLINK_URL            ws(s)://host:port/ws（默认 ws://127.0.0.1:3100/ws）
 *   AGENTLINK_TOKEN          agent token（管理页「Agent」分区创建）
 *   AGENTLINK_ONLY_MENTIONS  1 = 只订阅 @ 我的消息（默认 0：看全场，
 *                            因为 MCP 是模型主动轮询，不是被动应答）
 */
import { Client } from '@agentlink/agent-sdk';
import type { Message } from '@agentlink/protocol';

const PROTOCOL_VERSION = '2024-11-05';
const SERVER_INFO = { name: 'agentlink', version: '1.0.0' };

// ---------------------------------------------------------------------------
// JSON-RPC 帧（stdio：一行一个 JSON）
// ---------------------------------------------------------------------------

interface RpcRequest {
  jsonrpc: '2.0';
  id?: number | string;
  method: string;
  params?: unknown;
}

interface RpcError {
  code: number;
  message: string;
  data?: unknown;
}

function write(frame: unknown): void {
  process.stdout.write(`${JSON.stringify(frame)}\n`);
}

function respond(id: number | string | undefined, result: unknown): void {
  if (id === undefined) return; // 通知不需要回
  write({ jsonrpc: '2.0', id, result });
}

function respondError(id: number | string | undefined, error: RpcError): void {
  if (id === undefined) return;
  write({ jsonrpc: '2.0', id, error });
}

// ---------------------------------------------------------------------------
// 与 AgentLink 的连接（懒连接：只有真正调工具时才连，避免客户端只列工具就占一个连接）
// ---------------------------------------------------------------------------

let client: Client | null = null;
let connecting: Promise<Client> | null = null;
/** 收件箱：wait_for_message 从这里取。 */
const inbox: Message[] = [];
const inboxWaiters: Array<(m: Message | null) => void> = [];

function url(): string {
  return process.env['AGENTLINK_URL'] ?? 'ws://127.0.0.1:3100/ws';
}

function token(): string {
  const t = process.env['AGENTLINK_TOKEN'];
  if (t === undefined || t === '') {
    throw new Error('缺少 AGENTLINK_TOKEN 环境变量（到管理页「Agent」分区创建）');
  }
  return t;
}

async function getClient(): Promise<Client> {
  if (client !== null) return client;
  if (connecting !== null) return connecting;
  connecting = (async () => {
    // MCP 是"模型主动操作消息通道"的场景：默认**不**只订阅 @ 消息，
    // 否则 wait_for_message 永远等不到普通发言（SDK 的默认是 onlyMentions: true，
    // 那是给"被动应答型 agent"用的）。需要旧行为就设 AGENTLINK_ONLY_MENTIONS=1。
    const c = new Client({
      url: url(),
      token: token(),
      onlyMentions: process.env['AGENTLINK_ONLY_MENTIONS'] === '1',
    });
    // SDK 的回调签名是 (MessageContext) => void，真正的消息在 ctx.message。
    // **过滤掉自己发的**：否则 wait_for_message 会把自己刚发的消息当成"有人说话"。
    c.onMessage((ctx) => {
      if (ctx.message.sender.id === c.id) return;
      const waiter = inboxWaiters.shift();
      if (waiter !== undefined) waiter(ctx.message);
      else inbox.push(ctx.message);
    });
    await c.connect();
    await c.waitReady();
    client = c;
    return c;
  })();
  try {
    return await connecting;
  } finally {
    connecting = null;
  }
}

// ---------------------------------------------------------------------------
// 工具定义
// ---------------------------------------------------------------------------

interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  run: (args: Record<string, unknown>) => Promise<string>;
}

const str = (v: Record<string, unknown>, key: string): string => {
  const value = v[key];
  if (typeof value !== 'string' || value === '') throw new Error(`参数 ${key} 必须是非空字符串`);
  return value;
};
const optStr = (v: Record<string, unknown>, key: string): string | undefined => {
  const value = v[key];
  return typeof value === 'string' && value !== '' ? value : undefined;
};
const optNum = (v: Record<string, unknown>, key: string): number | undefined => {
  const value = v[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
};

function formatMessage(m: Message): string {
  const text = m.content
    .map((b) => (b.type === 'text' ? b.text : b.type === 'image' ? '[图片]' : `[文件 ${b.filename ?? ''}]`))
    .join(' ');
  const flags = [
    m.state === 'streaming' ? 'streaming' : '',
    m.edited_at !== null && m.edited_at !== undefined ? 'edited' : '',
    m.state === 'revoked' ? 'revoked' : '',
  ].filter((x) => x !== '');
  return `#${m.seq ?? '?'} ${m.sender.display_name}: ${text}${flags.length > 0 ? ` (${flags.join(',')})` : ''}`;
}

const TOOLS: ToolDef[] = [
  {
    name: 'agentlink_whoami',
    description: '查看当前 agent 身份（id / 昵称 / 连接的服务端）。',
    inputSchema: { type: 'object', properties: {} },
    run: async () => {
      const c = await getClient();
      // SDK 不暴露 self，这里用 conv.list 证明连接可用，并给出服务端地址
      const res = await c.convList();
      return JSON.stringify(
        {
          url: url(),
          connected: true,
          self: { id: c.id, display_name: c.displayName },
          conversations: res.items.length,
        },
        null,
        2,
      );
    },
  },
  {
    name: 'agentlink_list_convs',
    description: '列出这个 agent 所在的所有会话（群/单聊）。',
    inputSchema: { type: 'object', properties: {} },
    run: async () => {
      const c = await getClient();
      const res = await c.convList();
      return JSON.stringify(res.items, null, 2);
    },
  },
  {
    name: 'agentlink_read_messages',
    description:
      '读取某个会话的历史消息（新的在前）。适合"先看看群里聊了什么再回"。',
    inputSchema: {
      type: 'object',
      properties: {
        conv_id: { type: 'string', description: '会话 id' },
        limit: { type: 'number', description: '最多几条（默认 20，最大 100）' },
      },
      required: ['conv_id'],
    },
    run: async (args) => {
      const c = await getClient();
      const limit = Math.min(100, Math.max(1, optNum(args, 'limit') ?? 20));
      const page = await c.call<{ messages: Message[] }>('history.fetch', {
        conv_id: str(args, 'conv_id'),
        limit,
      });
      const lines = page.messages.slice().reverse().map(formatMessage);
      return lines.length === 0 ? '（没有消息）' : lines.join('\n');
    },
  },
  {
    name: 'agentlink_send_message',
    description:
      '往会话里发一条文本消息。**请自带 client_msg_id**（幂等键）：重试时用同一个值，服务端不会写出两条。',
    inputSchema: {
      type: 'object',
      properties: {
        conv_id: { type: 'string' },
        text: { type: 'string' },
        client_msg_id: { type: 'string', description: '幂等键，重试要复用同一个值' },
        reply_to: { type: 'string', description: '要引用的消息 id（可选）' },
      },
      required: ['conv_id', 'text'],
    },
    run: async (args) => {
      const c = await getClient();
      const replyTo = optStr(args, 'reply_to');
      const res = await c.send({
        conv_id: str(args, 'conv_id'),
        text: str(args, 'text'),
        ...(optStr(args, 'client_msg_id') === undefined
          ? {}
          : { client_msg_id: str(args, 'client_msg_id') }),
        ...(replyTo === undefined ? {} : { reply_to: replyTo }),
      });
      return JSON.stringify({ message_id: res.message_id, seq: res.seq }, null, 2);
    },
  },
  {
    name: 'agentlink_wait_for_message',
    description:
      '等待下一条新消息（长等待，最多 timeout_ms）。适合"等用户说话再回复"的循环。',
    inputSchema: {
      type: 'object',
      properties: {
        timeout_ms: { type: 'number', description: '最长等多久（默认 30000，最大 120000）' },
      },
    },
    run: async (args) => {
      await getClient(); // 确保已连接并开始收件
      const queued = inbox.shift();
      if (queued !== undefined) return formatMessage(queued);

      const timeoutMs = Math.min(120_000, Math.max(1000, optNum(args, 'timeout_ms') ?? 30_000));
      const next = await new Promise<Message | null>((resolve) => {
        const timer = setTimeout(() => {
          const idx = inboxWaiters.indexOf(waiter);
          if (idx >= 0) inboxWaiters.splice(idx, 1);
          resolve(null);
        }, timeoutMs);
        const waiter = (m: Message | null): void => {
          clearTimeout(timer);
          resolve(m);
        };
        inboxWaiters.push(waiter);
      });
      return next === null ? '（超时，没有新消息）' : formatMessage(next);
    },
  },
  {
    name: 'agentlink_typing',
    description: '告诉群里"我正在输入"（3 秒后自动过期）。',
    inputSchema: {
      type: 'object',
      properties: { conv_id: { type: 'string' } },
      required: ['conv_id'],
    },
    run: async (args) => {
      const c = await getClient();
      await c.call('typing.send', { conv_id: str(args, 'conv_id') });
      return 'ok';
    },
  },
  {
    name: 'agentlink_react',
    description: '给某条消息加/取消一个表情回应（同一个表情再调一次就是取消）。',
    inputSchema: {
      type: 'object',
      properties: {
        conv_id: { type: 'string' },
        message_id: { type: 'string' },
        emoji: { type: 'string', description: '单个 emoji，例如 👍' },
        remove: { type: 'boolean', description: 'true = 取消这个回应' },
      },
      required: ['conv_id', 'message_id', 'emoji'],
    },
    run: async (args) => {
      const c = await getClient();
      const remove = args['remove'] === true;
      const res = await c.call<{ reactions: unknown }>(
        remove ? 'reaction.remove' : 'reaction.add',
        {
          conv_id: str(args, 'conv_id'),
          message_id: str(args, 'message_id'),
          emoji: str(args, 'emoji'),
        },
      );
      return JSON.stringify(res.reactions, null, 2);
    },
  },
  {
    name: 'agentlink_edit_message',
    description: '编辑自己发过的消息（只能改自己的、已发送完成、未撤回的）。',
    inputSchema: {
      type: 'object',
      properties: {
        conv_id: { type: 'string' },
        message_id: { type: 'string' },
        text: { type: 'string' },
      },
      required: ['conv_id', 'message_id', 'text'],
    },
    run: async (args) => {
      const c = await getClient();
      const res = await c.call<{ message: Message }>('message.edit', {
        conv_id: str(args, 'conv_id'),
        message_id: str(args, 'message_id'),
        content: [{ type: 'text', text: str(args, 'text') }],
      });
      return formatMessage(res.message);
    },
  },
  {
    name: 'agentlink_read_context',
    description:
      '取一段**可直接拼进 prompt** 的会话上下文（服务端已做截断与引用展开）。这是本系统相对"自己攒历史"的核心差异。',
    inputSchema: {
      type: 'object',
      properties: {
        conv_id: { type: 'string' },
        before: { type: 'number', description: '往前取几条（默认 20）' },
        after: { type: 'number', description: '往后取几条（默认 0）' },
        max_chars: { type: 'number', description: '总字符上限（默认 8000）' },
      },
      required: ['conv_id'],
    },
    run: async (args) => {
      const c = await getClient();
      const maxChars = optNum(args, 'max_chars');
      const res = await c.context({
        conv_id: str(args, 'conv_id'),
        before: optNum(args, 'before') ?? 20,
        after: optNum(args, 'after') ?? 0,
        ...(maxChars === undefined ? {} : { max_chars: maxChars }),
      });
      const body = res.messages.map((m) => `${m.sender}: ${m.text}`).join('\n');
      return `${body}\n\n(truncated=${String(res.truncated)}, dropped=${res.dropped_count})`;
    },
  },
];

// ---------------------------------------------------------------------------
// 供两种传输复用的"处理一个 JSON-RPC 请求"
// ---------------------------------------------------------------------------

/**
 * 处理一条 JSON-RPC 请求，返回响应帧（通知类返回 null）。
 *
 * 抽出来是因为现在有**两种传输**：stdio（本机客户端 spawn）和 HTTP（远程客户端，
 * 按 MCP 的 Streamable HTTP 约定：POST 一个 JSON-RPC，回 application/json）。
 * 工具实现只应有一份 —— 两种传输只是把请求送进来的方式不同。
 */
async function dispatch(req: RpcRequest): Promise<unknown | null> {
  const isNotification = req.id === undefined;
  switch (req.method) {
    case 'initialize':
      if (isNotification) return null;
      return {
        jsonrpc: '2.0',
        id: req.id,
        result: {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: SERVER_INFO,
        },
      };

    case 'notifications/initialized':
    case 'notifications/cancelled':
      return null;

    case 'ping':
      return isNotification ? null : { jsonrpc: '2.0', id: req.id, result: {} };

    case 'tools/list':
      return isNotification
        ? null
        : {
            jsonrpc: '2.0',
            id: req.id,
            result: {
              tools: TOOLS.map((t) => ({
                name: t.name,
                description: t.description,
                inputSchema: t.inputSchema,
              })),
            },
          };

    case 'tools/call': {
      if (isNotification) return null;
      const params = (req.params ?? {}) as { name?: string; arguments?: Record<string, unknown> };
      const tool = TOOLS.find((t) => t.name === params.name);
      if (tool === undefined) {
        return {
          jsonrpc: '2.0',
          id: req.id,
          error: { code: -32602, message: `未知工具: ${String(params.name)}` },
        };
      }
      try {
        const text = await tool.run(params.arguments ?? {});
        return { jsonrpc: '2.0', id: req.id, result: { content: [{ type: 'text', text }] } };
      } catch (err) {
        // 工具级失败用 isError（MCP 约定），模型能看到错误文本自己决定重试
        return {
          jsonrpc: '2.0',
          id: req.id,
          result: {
            content: [{ type: 'text', text: err instanceof Error ? err.message : String(err) }],
            isError: true,
          },
        };
      }
    }

    default:
      return isNotification
        ? null
        : {
            jsonrpc: '2.0',
            id: req.id,
            error: { code: -32601, message: `不支持的方法: ${req.method}` },
          };
  }
}

// ---------------------------------------------------------------------------
// JSON-RPC 分发（stdio 用：把 dispatch 的结果写回 stdout）
// ---------------------------------------------------------------------------

async function handle(req: RpcRequest): Promise<void> {
  const res = await dispatch(req);
  if (res !== null) write(res);
}


// ---------------------------------------------------------------------------
// HTTP 传输（MCP Streamable HTTP 的最小实现）
// ---------------------------------------------------------------------------
//
// 为什么还要 HTTP：stdio 只能本机 spawn。远程客户端（容器里的 DSH、
// 另一台机器上的 agent 运行时）没法 spawn 本地进程，只能连 URL。
//
// 实现取最小可用子集：POST /mcp 收一个 JSON-RPC（或一批），回 application/json。
// **不做** GET 的服务器推送流与会话管理（Mcp-Session-Id）—— 需要推送的场景
// 用 `agentlink_wait_for_message` 工具（长轮询 30 秒）已经够用，不必再引入
// 一条长连接与它自己的断线重连语义。
//
// 用 AGENTLINK_MCP_HTTP_PORT 打开：设了端口就以 HTTP 模式跑（stdio 仍然可用）。

async function startHttp(port: number): Promise<void> {
  const { createServer } = await import('node:http');
  const server = createServer((req, res) => {
    // 只允许 POST /mcp：其余路径明确 404，避免被当成通用 RPC 网关
    if (req.method !== 'POST' || (req.url ?? '').split('?')[0] !== '/mcp') {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'only POST /mcp is supported' }));
      return;
    }
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      void (async () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let parsed: unknown;
        try {
          parsed = JSON.parse(raw);
        } catch {
          res.writeHead(400, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'JSON 解析失败' } }));
          return;
        }
        const batch = Array.isArray(parsed);
        const requests = (batch ? parsed : [parsed]) as RpcRequest[];
        const responses: unknown[] = [];
        for (const r of requests) {
          const out = await dispatch(r);
          if (out !== null) responses.push(out);
        }
        // 全是通知时按 MCP 约定回 202 且无 body
        if (responses.length === 0) {
          res.writeHead(202);
          res.end();
          return;
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(batch ? responses : responses[0]));
      })().catch((err: unknown) => {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            jsonrpc: '2.0',
            id: null,
            error: { code: -32603, message: err instanceof Error ? err.message : String(err) },
          }),
        );
      });
    });
  });
  await new Promise<void>((resolve) => server.listen(port, '0.0.0.0', () => resolve()));
  process.stderr.write(`[agentlink-mcp] HTTP 传输监听 0.0.0.0:${port}（POST /mcp）\n`);
}

// ---------------------------------------------------------------------------
// stdio 主循环：一行一个 JSON-RPC
// ---------------------------------------------------------------------------

let buffer = '';

async function onLine(line: string): Promise<void> {
  const trimmed = line.trim();
  if (trimmed === '') return;
  let req: RpcRequest;
  try {
    req = JSON.parse(trimmed) as RpcRequest;
  } catch {
    respondError(undefined, { code: -32700, message: 'JSON 解析失败' });
    return;
  }
  try {
    await handle(req);
  } catch (err) {
    respondError(req.id, {
      code: -32603,
      message: err instanceof Error ? err.message : String(err),
    });
  }
}

const httpPortRaw = process.env['AGENTLINK_MCP_HTTP_PORT'];
if (httpPortRaw !== undefined && httpPortRaw !== '') {
  const port = Number(httpPortRaw);
  if (Number.isFinite(port) && port > 0) {
    void startHttp(port);
  } else {
    process.stderr.write(`[agentlink-mcp] AGENTLINK_MCP_HTTP_PORT 非法: ${httpPortRaw}\n`);
  }
}

process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk: string) => {
  buffer += chunk;
  let nl = buffer.indexOf('\n');
  while (nl >= 0) {
    const line = buffer.slice(0, nl);
    buffer = buffer.slice(nl + 1);
    void onLine(line);
    nl = buffer.indexOf('\n');
  }
});

process.stdin.on('end', () => {
  void (async () => {
    if (buffer.trim() !== '') await onLine(buffer);
    if (client !== null) client.disconnect();
    process.exit(0);
  })();
});

// stdout 只放 JSON-RPC；日志一律走 stderr，否则会污染协议流
process.on('uncaughtException', (err) => {
  process.stderr.write(`[agentlink-mcp] 未捕获异常: ${String(err)}\n`);
});
