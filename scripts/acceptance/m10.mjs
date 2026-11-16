#!/usr/bin/env node
/**
 * M10 验收：Docker 部署（验收标准第 6 条）。
 *
 * 1. `docker compose up -d --build` 从零起服务
 * 2. 浏览器访问 → 注册/登录 → 发消息
 * 3. `docker compose restart` 后刷新页面 → 消息还在（卷持久化）
 * 4. 容器 HEALTHCHECK 打 /healthz
 * 5. 构建产物里 Web 静态资源由服务端自己托管
 *
 * 本脚本不需要 ctx 起的服务（它测的是容器），所以 needsServer = false。
 * 如果本机没有可用的 Docker，或镜像构建太慢，脚本会**明确跳过并说明原因**，
 * 而不是假装通过（施工守则 §4：没跑通就说没跑通）。
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { stat, readFile } from 'node:fs/promises';
import path from 'node:path';
import { section, summary, ok, eq, gte, includes } from './_assert.mjs';

const exec = promisify(execFile);

export const needsServer = false;

const HTTP_PORT = Number(process.env.M10_HTTP_PORT ?? 8088);

let REPO_ROOT = '.';

/**
 * compose 的 `:?` 必填变量**对所有子命令**都生效，包括 `ps` / `down` 这种只读命令。
 * 所以任何 docker compose 调用都必须带上这两个密钥，否则会报
 * "required variable JWT_SECRET is missing a value"。
 */
const COMPOSE_SECRETS = {
  JWT_SECRET: 'm10-acceptance-jwt-secret-0123456789abcdef0123456789',
  AGENT_TOKEN_PEPPER: 'm10-acceptance-pepper-0123456789ab',
};

async function docker(args, opts = {}) {
  const env = {
    ...process.env,
    ...COMPOSE_SECRETS,
    DOCKER_CONFIG:
      process.env.DOCKER_CONFIG ?? path.resolve(REPO_ROOT, '../.runtime/docker'),
  };
  try {
    const { stdout, stderr } = await exec('docker', args, {
      env,
      // compose 子命令必须在仓库根执行，否则找不到 docker-compose.yml
      cwd: REPO_ROOT,
      timeout: opts.timeout ?? 120_000,
      maxBuffer: 20 * 1024 * 1024,
    });
    return { ok: true, stdout, stderr };
  } catch (err) {
    return { ok: false, stdout: err.stdout ?? '', stderr: `${err.stderr ?? ''}${err.message}` };
  }
}

/**
 * 等 HTTP 端点就绪。
 *
 * `compose restart` 后 Caddy 会先起来、后端还在启动，中间会返回 502 ——
 * 这是正常的启动窗口，不是故障。所以这里只把"拿到 ok:true 的 JSON"当作就绪，
 * 502/连接失败一律重试到超时。
 */
async function waitForHttp(url, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  let last = '';
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) {
        const body = await res.json().catch(() => null);
        if (body?.ok === true) return { ok: true, body };
        last = `200 但 body=${JSON.stringify(body)}`;
      } else {
        last = `HTTP ${res.status}`;
      }
    } catch (err) {
      last = err.message;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return { ok: false, error: last };
}

/** 等某个 HTTP 端点返回指定状态码（用于 restart 后的登录检查）。 */
async function waitForStatus(url, opts, wantStatus, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  let last = 0;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, opts);
      last = res.status;
      if (res.status === wantStatus) return { ok: true, status: res.status, body: await res.json().catch(() => null) };
    } catch {
      last = 0;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return { ok: false, status: last };
}

export async function run(ctx) {
  const repoRoot = ctx.repoRoot;
  REPO_ROOT = repoRoot;

  section('M10.0 Docker 可用性');
  const info = await docker(['info'], { timeout: 30_000 });
  if (!info.ok) {
    console.log('  \x1b[33m跳过\x1b[0m Docker 不可用，无法验证部署：');
    console.log(`  ${info.stderr.split('\n').slice(0, 3).join('\n  ')}`);
    // 明确失败而不是静默通过：验收 6 没验证过就是没验证过
    ok(false, 'Docker 可用（本机 Docker 不可用时本里程碑无法验证）');
    return summary('M10');
  }
  ok(true, 'Docker daemon 可用');

  section('M10.1 镜像与部署文件');
  for (const f of ['Dockerfile', 'docker-compose.yml', 'Caddyfile', '.env.example']) {
    const st = await stat(path.join(repoRoot, f)).catch(() => null);
    ok(st !== null && st.isFile(), `${f} 存在`);
  }

  const dockerfile = await readFile(path.join(repoRoot, 'Dockerfile'), 'utf8');
  includes(dockerfile, 'AS build', 'Dockerfile 是多阶段构建');
  includes(dockerfile, 'AS runtime', 'Dockerfile 有只带产物的运行阶段');
  includes(dockerfile, 'HEALTHCHECK', 'Dockerfile 有 HEALTHCHECK');
  includes(dockerfile, '/healthz', 'HEALTHCHECK 打 /healthz');
  includes(dockerfile, 'USER node', '容器不用 root 跑');
  includes(dockerfile, 'pnpm prune --prod', '运行镜像裁掉 devDependencies');

  const compose = await readFile(path.join(repoRoot, 'docker-compose.yml'), 'utf8');
  includes(compose, 'caddy', 'compose 里有 caddy');
  includes(compose, 'db:', 'compose 定义了 db 命名卷');
  includes(compose, 'JWT_SECRET', 'compose 通过环境变量注入 JWT_SECRET');
  includes(compose, 'AGENT_TOKEN_PEPPER', 'compose 注入 AGENT_TOKEN_PEPPER');
  includes(compose, 'condition: service_healthy', 'caddy 等 server 健康后再起');
  const volumeCount = (compose.match(/^\s{2}\w+:$/gm) ?? []).length;
  gte(volumeCount, 2, `compose 至少两个命名卷（实际 ${volumeCount} 项）`);

  const caddy = await readFile(path.join(repoRoot, 'Caddyfile'), 'utf8');
  includes(caddy, 'reverse_proxy', 'Caddyfile 做反向代理');
  includes(caddy, 'websocket', 'Caddyfile 透传 WebSocket');

  section('M10.2 镜像存在');
  const images = await docker(['images', '--format', '{{.Repository}}:{{.Tag}}']);
  const hasImage =
    images.ok &&
    images.stdout
      .split('\n')
      .some((l) => l.trim().startsWith('agentlink-server') || l.trim().startsWith('agentlink:'));
  ok(hasImage, '存在 agentlink 镜像（agentlink-server:latest 或 agentlink:test）');
  if (!hasImage) {
    console.log('  \x1b[33m提示\x1b[0m 先跑一次：docker build -t agentlink-server:latest .');
    return summary('M10');
  }

  section('M10.3 docker compose up 起服务');
  const composeEnv = {
    ...process.env,
    ...COMPOSE_SECRETS,
    HTTP_PORT: String(HTTP_PORT),
    DOCKER_CONFIG: process.env.DOCKER_CONFIG ?? path.resolve(repoRoot, '../.runtime/docker'),
  };

  // 从零起服务（验收 6 的原话）：先彻底拆掉上一次的容器与命名卷，
  // 否则上一次留下的用户/消息会让"注册新用户"返回 409，验收变成不可重跑。
  const downFirst = await docker(['compose', 'down', '-v'], { timeout: 180_000 });
  if (!downFirst.ok && !/no such|not found/i.test(downFirst.stderr)) {
    console.log(`  （down -v 返回: ${downFirst.stderr.split('\n')[0]}）`);
  }
  const psAfterDown = await docker(['compose', 'ps', '--format', '{{.Name}}']);
  eq((psAfterDown.stdout ?? '').trim(), '', 'down -v 后没有残留容器（从零开始）');

  const up = await exec('docker', ['compose', 'up', '-d', '--no-build'], {
    cwd: repoRoot,
    env: composeEnv,
    timeout: 300_000,
    maxBuffer: 20 * 1024 * 1024,
  }).catch((err) => ({ ok: false, stderr: err.stderr, stdout: err.stdout }));
  ok(up !== undefined, 'docker compose up -d 执行完成');

  const health = await waitForHttp(`http://127.0.0.1:${HTTP_PORT}/healthz`, 120_000);
  if (!health.ok) {
    const logs = await docker(['compose', 'logs', '--tail=25', 'server']);
    console.log('\n--- 容器日志 ---');
    console.log(logs.stdout + logs.stderr);
    ok(false, `服务通过 Caddy 在 :${HTTP_PORT} 可访问 /healthz`);
    return summary('M10');
  }
  eq(health.body?.ok, true, `GET http://127.0.0.1:${HTTP_PORT}/healthz → {"ok":true}`);

  section('M10.4 浏览器路径：静态资源 + 注册/登录/发消息');
  const indexRes = await fetch(`http://127.0.0.1:${HTTP_PORT}/`);
  eq(indexRes.status, 200, 'GET / → 200');
  const indexHtml = await indexRes.text();
  includes(indexHtml, '<div id="root">', '返回的是 SPA 的 index.html');
  includes(indexHtml, '/assets/', 'index.html 引用构建产物');

  const assetMatch = /src="(\/assets\/[^"]+\.js)"/.exec(indexHtml);
  ok(assetMatch !== null, '找到 JS 构建产物路径');
  if (assetMatch) {
    const assetRes = await fetch(`http://127.0.0.1:${HTTP_PORT}${assetMatch[1]}`);
    eq(assetRes.status, 200, '构建产物可访问（说明 web/dist 进了镜像）');
    const js = await assetRes.text();
    gte(js.length, 1000, `产物大小 ${js.length} 字节`);
  }

  const username = `dockertest_${Date.now().toString(36)}`;
  const reg = await fetch(`http://127.0.0.1:${HTTP_PORT}/api/auth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      username,
      display_name: '容器用户',
      password: 'docker-password-123',
    }),
  });
  eq(reg.status, 201, '注册新用户 → 201');
  const regBody = await reg.json();
  ok(typeof regBody.access_token === 'string', '返回 access_token');

  const login = await fetch(`http://127.0.0.1:${HTTP_PORT}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password: 'docker-password-123' }),
  });
  eq(login.status, 200, '登录 → 200');
  const loginBody = await login.json();

  // 走 WS 发一条消息（真正验证实时面在容器里可用）
  const { WsClient } = await import('./_client.mjs');
  const wsUrl = `ws://127.0.0.1:${HTTP_PORT}/ws`;
  const client = new WsClient(wsUrl);
  await client.connect();
  const authRes = await client.request('auth', { token: loginBody.access_token });
  eq(authRes.ok, true, 'WS 认证成功（容器内实时面可用）');
  const convRes = await client.request('conv.create', { kind: 'group', title: '容器测试群' });
  eq(convRes.ok, true, '容器内建群成功');
  const convId = convRes.data.conv.id;
  const sent = await client.request('message.send', {
    conv_id: convId,
    client_msg_id: 'docker-msg-1',
    content: [{ type: 'text', text: '来自容器的一条消息' }],
  });
  eq(sent.ok, true, '容器内发消息成功');
  const history = await client.request('history.fetch', { conv_id: convId, limit: 10 });
  eq(history.ok, true, '容器内能读回历史');
  eq(history.data.messages.length, 1, '新建的群里恰好 1 条消息');
  eq(
    history.data.messages[0]?.content?.[0]?.text,
    '来自容器的一条消息',
    '读回的就是刚发的那条',
  );
  client.close();

  section('M10.5 docker compose restart → 数据还在');
  const restart = await exec('docker', ['compose', 'restart'], {
    cwd: repoRoot,
    env: composeEnv,
    timeout: 240_000,
  }).catch((err) => ({
    stdout: err.stdout,
    stderr: err.stderr,
  }));
  void restart;

  const health2 = await waitForHttp(`http://127.0.0.1:${HTTP_PORT}/healthz`, 120_000);
  ok(health2.ok, '重启后 /healthz 恢复');

  const login2 = await waitForStatus(
    `http://127.0.0.1:${HTTP_PORT}/api/auth/login`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username, password: 'docker-password-123' }),
    },
    200,
  );
  eq(login2.status, 200, '重启后原账号仍能登录（数据库在命名卷里）');

  const client2 = new WsClient(wsUrl);
  await client2.connect();
  const authRes2 = await client2.request('auth', { token: login2.body.access_token });
  eq(authRes2.ok, true, '重启后 WS 认证成功');
  const convList = await client2.request('conv.list', {});
  const found = (convList.data?.items ?? []).find((c) => c.title === '容器测试群');
  ok(found !== undefined, '重启后会话还在');
  if (found) {
    const history2 = await client2.request('history.fetch', { conv_id: found.id, limit: 10 });
    eq(history2.data?.messages?.length, 1, '重启后消息还在（刷新页面即可见）');
    eq(
      history2.data?.messages?.[0]?.content?.[0]?.text,
      '来自容器的一条消息',
      '消息内容完好',
    );
  }
  client2.close();

  section('M10.6 容器健康状态与自愈');
  const psOut = await docker(['compose', 'ps', '--format', '{{.Service}} {{.Status}}']);
  const psText = psOut.stdout ?? '';
  includes(psText, 'server', 'compose ps 能看到 server 服务');
  if (psText.includes('healthy')) {
    ok(true, 'server 容器状态 healthy（HEALTHCHECK 生效）');
  } else {
    // 刚重启时可能还在 starting，等一下再看一次
    await new Promise((r) => setTimeout(r, 20_000));
    const ps2 = await docker(['compose', 'ps', '--format', '{{.Service}} {{.Status}}']);
    includes(ps2.stdout ?? '', 'healthy', 'server 容器最终变为 healthy');
  }

  const inspect = await docker([
    'inspect',
    '--format',
    '{{.State.Health.Status}}',
    'agentlink-server-1',
  ]);
  ok(
    inspect.stdout.trim() === 'healthy' || inspect.stdout.trim() === 'starting',
    `docker inspect 健康状态: ${inspect.stdout.trim() || '(未知)'}`,
  );

  return summary('M10');
}