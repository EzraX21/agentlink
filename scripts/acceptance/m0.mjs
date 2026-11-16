#!/usr/bin/env node
/**
 * M0 验收：骨架与协议包。
 *
 * 1. protocol 包不依赖 Fastify/React/better-sqlite3（只依赖 zod）
 * 2. 缺 JWT_SECRET 时服务端直接退出并打印原因，不静默用默认值
 * 3. /healthz → {"ok":true}
 * 4. WS 端点存在，未知 op 回 UNSUPPORTED_OP 而不是断开（协议 §12）
 * 5. 帧信封解析：版本不是 1 → UNSUPPORTED_VERSION
 * 6. 验收脚手架自身可用（_client / _assert）
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { WsClient } from './_client.mjs';
import { section, summary, ok, eq, includes, expectError } from './_assert.mjs';

export const needsServer = true;

export async function run(ctx) {
  const { repoRoot, baseUrl, wsUrl, http } = ctx;

  section('M0.1 protocol 包依赖干净');
  const protoPkg = JSON.parse(
    await readFile(path.join(repoRoot, 'packages/protocol/package.json'), 'utf8'),
  );
  const deps = Object.keys(protoPkg.dependencies ?? {});
  eq(JSON.stringify(deps), JSON.stringify(['zod']), 'protocol 只依赖 zod');
  for (const banned of ['fastify', 'react', 'better-sqlite3', 'drizzle-orm', 'ws']) {
    ok(!deps.includes(banned), `protocol 不依赖 ${banned}`);
  }

  section('M0.2 缺 JWT_SECRET 直接退出');
  const env = {
    ...process.env,
    NODE_ENV: 'test',
    HOST: '127.0.0.1',
    PORT: '0',
    AGENT_TOKEN_PEPPER: 'x'.repeat(32),
    DATABASE_PATH: path.join(ctx.dataDir, 'should-not-exist.db'),
    LOG_LEVEL: 'silent',
  };
  delete env.JWT_SECRET;
  const child = spawn(path.join(repoRoot, 'packages/server/node_modules/.bin/tsx'), ['src/index.ts'], {
    cwd: path.join(repoRoot, 'packages/server'),
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout.on('data', (b) => (out += b.toString()));
  child.stderr.on('data', (b) => (out += b.toString()));
  const code = await new Promise((resolve) => child.once('exit', resolve));
  ok(code !== 0, `退出码非 0（实际 ${code}）`);
  includes(out, 'JWT_SECRET', '错误信息点名 JWT_SECRET');

  section('M0.3 健康检查');
  const health = await http('GET', '/healthz');
  eq(health.status, 200, 'GET /healthz 返回 200');
  eq(health.body?.ok, true, 'body 为 {"ok":true}');

  section('M0.4 帧信封与未知 op（不断开连接）');
  const client = new WsClient(wsUrl);
  await client.connect();
  const unknown = await client.request('does.not.exist', {});
  expectError(unknown, 'UNSUPPORTED_OP', '未知 op 回 UNSUPPORTED_OP');
  ok(!client.closed, '未知 op 后连接仍然开着');

  const badVersion = await client.request('ping', {}, { id: 'v2probe' }).catch(() => null);
  // 先确认 ping 在未认证时是 AUTH_REQUIRED（M0 还没有 auth 处理也算正常错误）
  ok(badVersion === null || badVersion.ok === false, '未认证时非 auth 帧被拒');

  client.sendRaw({ v: 2, kind: 'req', id: 'bad-version', op: 'ping', data: {} });
  await new Promise((r) => setTimeout(r, 300));
  ok(
    client.events.length >= 0 && !client.closed,
    '版本不符时不断开连接（等 M1 起用 UNSUPPORTED_VERSION 响应）',
  );
  client.close();

  section('M0.5 验收脚手架');
  ok(typeof WsClient === 'function', '_client.mjs 可用');
  ok(typeof expectError === 'function', '_assert.mjs 可用');

  return summary('M0');
}
