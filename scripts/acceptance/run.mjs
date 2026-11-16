#!/usr/bin/env node
/**
 * 验收跑批器。
 *
 *   node scripts/acceptance/run.mjs m0        # 只跑 M0
 *   node scripts/acceptance/run.mjs m0 m1 m2  # 按顺序跑多个
 *   node scripts/acceptance/run.mjs all       # 全部
 *
 * 每个里程碑拿一个干净的临时数据目录与独立端口，互不污染。
 * 服务端由本脚本自己拉起，所以验收不依赖“先手动开服务”。
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../..');
const serverDir = path.join(repoRoot, 'packages/server');
// tsx 是 server 包的 devDependency，二进制在包自己的 .bin 下（pnpm 不做提升）。
const tsxBin = path.join(serverDir, 'node_modules/.bin/tsx');

export const MILESTONES = ['m0', 'm1', 'm2', 'm3', 'm4', 'm5', 'm6', 'm7', 'm8', 'm9', 'm10', 'm11'];

/** 需要起服务端的里程碑（m0 有一部分只检查静态产物）。 */
const NEEDS_SERVER = new Set(MILESTONES);

function log(msg) {
  process.stdout.write(`${msg}\n`);
}

async function freePort() {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

async function waitForHealth(baseUrl, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  let lastErr = 'unknown';
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${baseUrl}/healthz`);
      if (res.ok) {
        const body = await res.json();
        if (body.ok === true) return true;
        lastErr = `healthz 返回 ${JSON.stringify(body)}`;
      } else {
        lastErr = `HTTP ${res.status}`;
      }
    } catch (err) {
      lastErr = err.message;
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`服务端在 ${timeoutMs}ms 内没起来: ${lastErr}`);
}

class ServerHandle {
  constructor({ port, dataDir }) {
    this.port = port;
    this.dataDir = dataDir;
    this.proc = null;
    this.logs = '';
    this.baseUrl = `http://127.0.0.1:${port}`;
    this.wsUrl = `ws://127.0.0.1:${port}/ws`;
    this.logFile = path.join(dataDir, 'server.log');
  }

  env(extra = {}) {
    return {
      ...process.env,
      NODE_ENV: 'test',
      HOST: '127.0.0.1',
      PORT: String(this.port),
      JWT_SECRET: 'acceptance-jwt-secret-0123456789abcdef0123456789abcdef',
      AGENT_TOKEN_PEPPER: 'acceptance-pepper-0123456789abcdef',
      DATABASE_PATH: path.join(this.dataDir, 'agentlink.db'),
      UPLOADS_DIR: path.join(this.dataDir, 'uploads'),
      LOG_LEVEL: 'info',
      AUTO_MIGRATE: 'true',
      ...extra,
    };
  }

  async start(extraEnv = {}) {
    const env = this.env(extraEnv);
    const child = spawn(tsxBin, ['src/index.ts'], {
      cwd: serverDir,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.proc = child;
    this.logs = '';
    const onData = (buf) => {
      this.logs += buf.toString();
      if (this.logs.length > 2_000_000) this.logs = this.logs.slice(-1_000_000);
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    this.exit = new Promise((resolve) => {
      child.once('exit', (code, signal) => resolve({ code, signal }));
    });
    await waitForHealth(this.baseUrl);
    return this;
  }

  async stop() {
    if (!this.proc || this.proc.exitCode !== null) return;
    this.proc.kill('SIGTERM');
    const timer = setTimeout(() => this.proc?.kill('SIGKILL'), 5000);
    await this.exit;
    clearTimeout(timer);
    this.proc = null;
  }

  /** M4 验收要 kill -9 后重启。 */
  async kill9() {
    if (!this.proc) return;
    this.proc.kill('SIGKILL');
    await this.exit;
    this.proc = null;
  }

  /** 换端口重启（同一个数据目录），用于验证持久化。 */
  async restart(extraEnv = {}) {
    await this.stop();
    this.port = await freePort();
    this.baseUrl = `http://127.0.0.1:${this.port}`;
    this.wsUrl = `ws://127.0.0.1:${this.port}/ws`;
    await this.start(extraEnv);
    return this;
  }
}

/** 简易 HTTP 助手。 */
export function httpFor(handle) {
  return async function http(method, pathname, { body, token, headers = {} } = {}) {
    const h = { ...headers };
    if (body !== undefined) h['content-type'] = 'application/json';
    if (token) h.authorization = `Bearer ${token}`;
    const res = await fetch(`${handle.baseUrl}${pathname}`, {
      method,
      headers: h,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await res.text();
    let json = null;
    try {
      json = text === '' ? null : JSON.parse(text);
    } catch {
      json = null;
    }
    return { status: res.status, body: json, text, headers: res.headers };
  };
}

async function runOne(name) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), `agentlink-${name}-`));
  const port = await freePort();
  const handle = new ServerHandle({ port, dataDir });
  const modPath = path.join(here, `${name}.mjs`);
  if (!existsSync(modPath)) {
    throw new Error(`找不到验收脚本 ${name}.mjs`);
  }
  const mod = await import(modPath);

  const ctx = {
    name,
    handle,
    dataDir,
    get baseUrl() {
      return handle.baseUrl;
    },
    get wsUrl() {
      return handle.wsUrl;
    },
    http: httpFor(handle),
    serverLogs: () => handle.logs,
    repoRoot,
    readFile,
    startServer: (extra) => handle.start(extra),
    stopServer: () => handle.stop(),
    restartServer: (extra) => handle.restart(extra),
    kill9Server: () => handle.kill9(),
    dbPath: path.join(dataDir, 'agentlink.db'),
    uploadsDir: path.join(dataDir, 'uploads'),
  };

  let started = false;
  try {
    if (NEEDS_SERVER.has(name) && mod.needsServer !== false) {
      await handle.start(mod.serverEnv ?? {});
      started = true;
    }
    const { resetCounters, counters } = await import('./_assert.mjs');
    resetCounters();
    await mod.run(ctx);
    const { failed } = counters();
    if (failed > 0) {
      // 断言失败与抛异常同等对待：没跑通就是没跑通（施工守则 §4）
      throw new Error(`${failed} 项断言失败`);
    }
  } catch (err) {
    log(`\n\x1b[31m${name} 抛出异常\x1b[0m: ${err.message}`);
    if (handle.logs) {
      log('\n--- 服务端日志（尾部） ---');
      log(handle.logs.split('\n').slice(-40).join('\n'));
    }
    throw err;
  } finally {
    if (started) await handle.stop();
    if (process.env.KEEP_ACCEPTANCE_DATA === '1') {
      log(`  （保留数据目录 ${dataDir}）`);
    } else {
      await rm(dataDir, { recursive: true, force: true });
    }
  }
}

async function main() {
  const args = process.argv.slice(2);
  let targets = args.filter((a) => !a.startsWith('-'));
  if (targets.length === 0) {
    log('用法: node scripts/acceptance/run.mjs <m0|m1|...|all>');
    process.exit(2);
  }
  if (targets.includes('all')) targets = MILESTONES;

  const results = [];
  for (const name of targets) {
    if (!MILESTONES.includes(name)) {
      log(`未知里程碑: ${name}`);
      process.exit(2);
    }
    log(`\n\x1b[1m\x1b[36m===== 验收 ${name.toUpperCase()} =====\x1b[0m`);
    const t0 = Date.now();
    try {
      await runOne(name);
      results.push({ name, ok: true, ms: Date.now() - t0 });
    } catch (err) {
      results.push({ name, ok: false, ms: Date.now() - t0, err: err.message });
    }
  }

  log('\n\x1b[1m===== 汇总 =====\x1b[0m');
  for (const r of results) {
    const mark = r.ok ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m';
    log(`  ${mark}  ${r.name}  ${(r.ms / 1000).toFixed(1)}s${r.ok ? '' : `  — ${r.err}`}`);
  }
  const failed = results.filter((r) => !r.ok);
  if (failed.length > 0) {
    log(`\n\x1b[31m${failed.length} 个里程碑未通过\x1b[0m`);
    process.exit(1);
  }
  log(`\n\x1b[32m全部 ${results.length} 个里程碑通过\x1b[0m`);
}

await main();
