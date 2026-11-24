#!/usr/bin/env node
/**
 * first-run 验收：一键启动 → 日志给出地址与凭据 → 首登引导。
 *
 * 验的是"用户第一次接触这个系统"的完整路径，而不是某个内部 API：
 *   1. 容器**不带任何环境变量**就能起来（entrypoint 自己生成密钥）
 *   2. 启动日志里明确写出管理页地址 + 管理员用户名/密码
 *   3. 密码是随机的（不是 admin/admin123 这类固定值）
 *   4. 凭据同时留在数据卷里（错过日志还能查）
 *   5. 用日志里的凭据能登录；`/api/admin/setup` 报 first_run=true
 *   6. 改密码后 first_run 变 false，旧密码失效、新密码可用
 *   7. 重启容器不会重新建管理员、也不会换密钥（否则所有人要重新登录）
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { section, summary, ok, eq, includes as includesText, gte } from './_assert.mjs';

/** 这个套件要 docker，run.mjs 会据此跳过没有 docker 的环境。 */
export const needsDocker = true;
export const needsServer = false;

const IMAGE = 'agentlink:latest';

function docker(args, opts = {}) {
  return new Promise((resolve) => {
    const child = spawn('docker', args, { env: { ...process.env }, stdio: ['ignore', 'pipe', 'pipe'], ...opts });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (b) => { stdout += b.toString(); });
    child.stderr.on('data', (b) => { stderr += b.toString(); });
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

async function freePort() {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
  });
}

async function waitHealth(url, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${url}/healthz`);
      if (res.ok) return true;
    } catch {
      /* 还没起来 */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

/**
 * 从启动日志里挖出用户名/密码/地址。
 *
 * 日志是 JSON 行（pino），内容形如 {"msg":"    用户名： admin"}——
 * 直接对 `\S+` 取词会把结尾的 `"}` 一起吃进去（第一次跑就是这么挂的，
 * 拿到的是 `admin"}`，登录当然失败）。所以先把 JSON 解开、只取 msg 字段。
 */
function parseBanner(logs) {
  const msgs = [];
  for (const line of logs.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) {
      msgs.push(trimmed);
      continue;
    }
    try {
      const parsed = JSON.parse(trimmed);
      if (typeof parsed.msg === 'string') msgs.push(parsed.msg);
    } catch {
      msgs.push(trimmed);
    }
  }
  const text = msgs.join('\n');
  const user = /用户名：\s*(\S+)/.exec(text)?.[1] ?? null;
  const pass = /密码：\s*(\S+)/.exec(text)?.[1] ?? null;
  const urls = [...text.matchAll(/管理页：\s*(\S+)/g)].map((m) => m[1]);
  return { user, pass, urls };
}

export async function run() {
  section('0. 环境');
  const probe = await docker(['run', '--rm', 'alpine:3', 'sh', '-c', 'echo ok']);
  eq(probe.code, 0, 'Docker 可用');
  if (probe.code !== 0) {
    console.log('  \x1b[33m- 跳过：没有 Docker\x1b[0m');
    return summary('first-run');
  }
  const hasImage = await docker(['image', 'inspect', IMAGE]);
  if (hasImage.code !== 0) {
    console.log(`  \x1b[33m- 跳过：没有 ${IMAGE}（先 docker build -f Dockerfile.allinone -t agentlink .）\x1b[0m`);
    return summary('first-run');
  }
  ok(true, `${IMAGE} 已构建`);

  const port = await freePort();
  const name = `agentlink-firstrun-${port}`;
  const volume = `agentlink-firstrun-vol-${port}`;
  const base = `http://127.0.0.1:${port}`;
  await docker(['volume', 'create', volume]);

  try {
    // ---- 1. 零环境变量启动 ----
    section('1. 一条命令启动（不给任何密钥）');
    const started = await docker([
      'run', '-d', '--name', name,
      '-p', `${port}:3000`,
      '-v', `${volume}:/data`,
      // 故意**不**给 JWT_SECRET / AGENT_TOKEN_PEPPER：entrypoint 要自己生成
      IMAGE,
    ]);
    eq(started.code, 0, '容器启动（没有传 JWT_SECRET / AGENT_TOKEN_PEPPER）');
    // 注意：这里刻意不显式失败跳过，因为"起不来"正是本套件要抓的
    ok(await waitHealth(base), `服务端健康（${base}）`);

    const logsRes = await docker(['logs', name]);
    const logs = logsRes.stdout + logsRes.stderr;

    section('2. 启动日志给出管理页地址与凭据');
    const banner = parseBanner(logs);
    ok(banner.urls.length > 0, `日志里有管理页地址（${banner.urls[0] ?? '无'}）`);
    ok(banner.user !== null, `日志里有管理员用户名（${banner.user ?? '无'}）`);
    ok(banner.pass !== null, '日志里有初始密码');
    includesText(logs, '首次启动，已自动创建管理员账号', '明确说明这是首次启动自动建的');
    includesText(logs, '已生成随机密钥', 'entrypoint 报出密钥已生成');

    section('3. 密码是随机的，不是固定默认值');
    const pass = banner.pass ?? '';
    gte(pass.length, 12, `密码长度 ${pass.length}（≥12）`);
    for (const weak of ['admin', 'admin123', 'password', '123456', 'changeme']) {
      ok(pass !== weak, `不是弱默认密码 "${weak}"`);
    }
    ok(/[A-Z]/.test(pass) && /[a-z]/.test(pass) && /[0-9]/.test(pass),
      '密码含大小写与数字（不是纯小写串）');

    section('4. 凭据同时留在数据卷里');
    const credFile = await docker(['exec', name, 'cat', '/data/initial-admin.txt']);
    eq(credFile.code, 0, '能读到 /data/initial-admin.txt');
    includesText(credFile.stdout, pass, '文件里的密码与日志一致');
    const secrets = await docker(['exec', name, 'cat', '/data/secrets.env']);
    includesText(secrets.stdout, 'JWT_SECRET=', '密钥也持久化到 /data/secrets.env');

    section('5. 用日志里的凭据登录 + 引导状态是"首次"');
    const login = await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: banner.user, password: pass }),
    });
    eq(login.status, 200, '用日志里的用户名/密码能登录');
    const loginBody = await login.json();
    const token = loginBody.access_token;
    ok(typeof token === 'string' && token.length > 0, '拿到 access_token');
    // 登录响应只有 token（协议设计如此）；管理员标记要问 /api/auth/me
    const auth = { authorization: `Bearer ${token}` };
    const me = await (await fetch(`${base}/api/auth/me`, { headers: auth })).json();
    eq(me.is_admin, true, '这个账号是管理员');
    eq(me.username, banner.user, '/api/auth/me 返回的用户名与日志一致');
    const setup1 = await fetch(`${base}/api/admin/setup`, { headers: auth });
    eq(setup1.status, 200, '能读引导状态');
    const s1 = await setup1.json();
    eq(s1.first_run, true, 'first_run = true（首次）');
    eq(s1.steps.password_changed, false, '还没改过密码（引导第一步未完成）');

    section('6. 改密码 → 引导第一步完成，旧密码失效');
    const changed = await fetch(`${base}/api/auth/password`, {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ old_password: pass, new_password: 'my-new-pass-123' }),
    });
    eq(changed.status, 200, '改密码成功');

    const setup2 = await (await fetch(`${base}/api/admin/setup`, { headers: auth })).json();
    eq(setup2.steps.password_changed, true, 'password_changed = true');
    eq(setup2.first_run, false, 'first_run = false（不再弹向导）');

    const oldLogin = await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: banner.user, password: pass }),
    });
    eq(oldLogin.status, 401, '旧密码不能再登录');

    const newLogin = await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: banner.user, password: 'my-new-pass-123' }),
    });
    eq(newLogin.status, 200, '新密码能登录');

    // 改密码必须验旧密码 —— 光有 token 就能改，等于 token 泄露即可永久接管
    const badChange = await fetch(`${base}/api/auth/password`, {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ old_password: 'wrong-one', new_password: 'another-pass-123' }),
    });
    eq(badChange.status, 401, '旧密码不对时拒绝改密码');

    section('7. 重启容器：不重建管理员、不换密钥');
    await docker(['restart', name]);
    ok(await waitHealth(base), '重启后仍然健康');
    const logs2 = await docker(['logs', '--tail', '80', name]);
    // 同样要先解 JSON 再匹配，否则 msg 里的中文和引号会干扰
    const msgs2 = [];
    for (const line of (logs2.stdout + logs2.stderr).split('\n')) {
      const t = line.trim();
      if (!t.startsWith('{')) { if (t !== '') msgs2.push(t); continue; }
      try {
        const p = JSON.parse(t);
        if (typeof p.msg === 'string') msgs2.push(p.msg);
      } catch { /* 跳过坏行 */ }
    }
    const text2 = msgs2.join('\n');
    includesText(text2, '管理员账号已存在', '第二次启动说明账号已存在');
    // 注意：不能断言"日志里没有『已自动创建』"——  `docker logs` 会重放
    // 首次启动的日志，那句话必然在。判断"有没有重建"要看**账号状态**：
    // 下面的"改过的密码仍能登录"才是真证据（重建会把密码重置成新的随机值）。
    const banner2After = msgs2.filter((m) => m.includes('首次启动，已自动创建')).length;
    ok(banner2After <= 1, `『首次启动』横幅只出现 1 次（实际 ${banner2After}）`);

    const secrets2 = await docker(['exec', name, 'cat', '/data/secrets.env']);
    eq(secrets2.stdout, secrets.stdout, '密钥文件没变（重建容器不会让所有人重登）');

    // 重启后旧密码仍然无效、新密码仍有效 —— 证明账号没被重新初始化
    const afterRestart = await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: banner.user, password: 'my-new-pass-123' }),
    });
    eq(afterRestart.status, 200, '重启后用改过的密码登录成功');
  } finally {
    await docker(['rm', '-f', name]);
    await docker(['volume', 'rm', '-f', volume]);
  }

  return summary('first-run');
}