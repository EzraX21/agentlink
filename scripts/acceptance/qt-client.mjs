#!/usr/bin/env node
/**
 * qt-client 验收：Qt/C++ 桌面客户端的协议核心**真连**一个 AgentLink 服务端。
 *
 * 验的是**客户端侧**的协议正确性：Web 客户端跑的那套协议，
 * C++ 客户端能不能说对、能不能真的完成注册→认证→建群→发消息→收推送→上传附件。
 * 帧格式或握手顺序错了，这里会红。
 *
 * ## 怎么跑
 *
 * 需要两个镜像（先构建好）：
 *   docker build -t agentlink-server:latest .              # 服务端
 *   docker build -f packages/qt-client/Dockerfile -t agentlink-qt:latest .
 *
 * 然后：`node scripts/acceptance/run.mjs qt-client`
 *
 * 本套件做的事：
 *   1. 起一个**隔离的服务端**容器（独立数据目录 + 随机端口，跑完删掉）
 *   2. 在 Qt 构建镜像里跑协议层单测（frames / address / settings，不需要服务端）
 *   3. 用**那个服务端**的地址跑 `test-e2e`（真注册、真建群、真发消息、真收消息）
 *
 * 如果容器里没有 Qt6，会**跳过**而不是红 —— 这是"按需"套件，
 * 不该挡住没有 Docker / Qt 的环境。
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import path from 'node:path';
import { section, ok, eq, gte } from './_assert.mjs';

export const needsServer = false;

const REPO_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');

/** 跑一个 docker 命令并收集输出。 */
function docker(args, opts = {}) {
  return new Promise((resolve) => {
    const child = spawn('docker', args, {
      env: { ...process.env },
      stdio: ['ignore', 'pipe', 'pipe'],
      ...opts,
    });
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

/** 等一个端口能访问。 */
async function waitFor(url, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return true;
    } catch {
      /* 还没起来 */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

export async function run(ctx) {
  section('0. 环境：Docker 与镜像');

  const probe = await docker(['run', '--rm', 'alpine:3', 'sh', '-c', 'echo ok']);
  eq(probe.code, 0, 'Docker 可用');
  if (probe.code !== 0) {
    console.log('  \x1b[33m- 跳过：没有 Docker，无法跑 qt-client 验收\x1b[0m');
    return;
  }

  const hasQt = await docker([
    'image', 'inspect', 'agentlink-qt:latest',
  ]);
  if (hasQt.code !== 0) {
    console.log('  \x1b[33m- 跳过：没有 agentlink-qt:latest 镜像（先构建 packages/qt-client/Dockerfile）\x1b[0m');
    return;
  }
  ok(true, 'agentlink-qt:latest 已构建');

  const hasServer = await docker(['image', 'inspect', 'agentlink-server:latest']);
  if (hasServer.code !== 0) {
    console.log('  \x1b[33m- 跳过：没有 agentlink-server:latest 镜像\x1b[0m');
    return;
  }
  ok(true, 'agentlink-server:latest 已构建');

  // ---- 起一个隔离的服务端 ----
  section('1. 起隔离的服务端容器');
  const port = await freePort();
  const name = `agentlink-qt-server-${port}`;
  // 用 **Docker 具名卷**而不是宿主目录挂载：
  // 宿主目录挂进容器后属主是当前用户，容器里的 `node` 用户写不了 SQLite
  // （SQLITE_CANTOPEN），而容器里的 root 又改不动那个属主
  // （chown/chmod 都报 "Operation not permitted"）。
  // 具名卷由 Docker 自己管属主，没这个问题。
  const volumeName = `agentlink-qt-vol-${port}`;
  await docker(['volume', 'create', volumeName]);

  const started = await docker([
    'run', '-d', '--name', name,
    '-p', `${port}:3000`,
    '-v', `${volumeName}:/data`,
    '-e', `JWT_SECRET=${'q'.repeat(40)}`,
    '-e', `AGENT_TOKEN_PEPPER=${'p'.repeat(20)}`,
    'agentlink-server:latest',
  ]);
  eq(started.code, 0, '服务端容器启动');

  try {
    const healthy = await waitFor(`http://127.0.0.1:${port}/healthz`);
    ok(healthy, `服务端健康（http://127.0.0.1:${port}）`);
    if (!healthy) throw new Error('服务端没有起来');

    section('2. GUI 二进制能起来（平台插件 / 动态库都在位）');
    // 不带显示环境也能验：`--version` 打印完就退出，不进事件循环。
    // 这条能抓到"镜像缺 Qt 平台插件"或"动态库没打进去"这类问题 ——
    // 只跑单测是抓不到的（单测是 GUILESS，不需要平台插件）。
    const version = await docker([
      'run', '--rm', '-e', 'QT_QPA_PLATFORM=offscreen', 'agentlink-qt:latest', '--version',
    ]);
    ok(
      version.code === 0 && version.stdout.includes('agentlink-qt'),
      `GUI 二进制可执行：${version.stdout.trim() || version.stderr.trim().slice(0, 300)}`,
    );
    ok(/Qt \d+\.\d+/.test(version.stdout), `带出 Qt 版本（${/Qt [0-9.]+/.exec(version.stdout)?.[0] ?? '无'}）`);

    section('3. 协议层单测（不需要服务端）');
    // 镜像里已经构建好测试，直接 ctest；-E e2e 排除要连服务端的那个。
    // 注意 --entrypoint sh：镜像的 ENTRYPOINT 是 GUI 可执行文件，
    // 不覆盖的话 "sh -c ..." 会变成 GUI 程序的参数 → 它去开窗口 → 找不到 xcb 插件。
    const tests = await docker([
      'run', '--rm', '--entrypoint', 'sh', 'agentlink-qt:latest',
      '-c', 'cd /build && ctest --output-on-failure -E e2e',
    ]);
    // 断言：三个测试文件都跑了，且没红。
    // CTest 的输出格式是 "100% tests passed, 0 tests failed out of 3"，
    // 不是 "Tests run:" —— 那是 QTest 单测自己的输出，会被 ctest 折叠掉。
    const passLine = /(\d+)% tests passed/.exec(tests.stdout);
    ok(
      tests.code === 0 && passLine !== null,
      `协议层单测通过\n${(tests.stdout + tests.stderr).slice(-1200)}`,
    );
    // ctest 输出里的测试名不带 "test-" 前缀（"Test #1: frames ..."）
    for (const t of ['frames', 'address', 'settings']) {
      ok(new RegExp(`Test #[0-9]+: ${t}\\b`).test(tests.stdout), `跑了 ${t}`);
    }

    section('4. 端到端：真连服务端');
    // 容器里的 127.0.0.1 指向它自己，不是宿主的服务端。
    // 用 --network host：容器直接走宿主网络，127.0.0.1:<port> 就是上面的服务端。
    // 直接跑二进制而不是 ctest：ctest 通过时会折叠 QTest 的用例细节
    // （Totals: N passed 看不到），直接用二进制才能数每个用例。
    const e2eHost = await docker([
      'run', '--rm', '--network', 'host', '--entrypoint', 'sh', 'agentlink-qt:latest',
      '-c',
      `cd /build && AGENTLINK_TEST_URL=http://127.0.0.1:${port} AGENTLINK_TEST_WS_URL=ws://127.0.0.1:${port}/ws ./test-e2e`,
    ]);

    ok(
      e2eHost.code === 0,
      `端到端通过\n${(e2eHost.stdout + e2eHost.stderr).slice(-1500)}`,
    );
    const e2eTotals = /Totals:\s*(\d+) passed/.exec(e2eHost.stdout);
    gte(e2eTotals ? Number(e2eTotals[1]) : 0, 4, `端到端至少 4 个用例（实际 ${e2eTotals ? e2eTotals[1] : '未知'}）`);
  } finally {
    await docker(['rm', '-f', name]);
    await docker(['volume', 'rm', '-f', volumeName]);
  }
}
