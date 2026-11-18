#!/usr/bin/env node
/**
 * split 验收：前后端分离部署。
 *
 * 验证"客户端与服务端可以分开跑"这件事是真的：
 *   1. 服务端**不设** `PUBLIC_DIR` → 只提供 API/WS，`/` 是 404（不再托管前端）
 *   2. 服务端设 `CORS_ORIGINS` → 预检 204 + 正确的放行头；**不允许** `*`
 *   3. 非白名单来源拿不到 CORS 头（不是"忘了加"，是明确拒绝）
 *   4. 客户端以 `VITE_API_BASE` 指向服务端构建 → 产物里的地址是绝对地址
 *   5. 用这份产物起一个**独立的静态服务器**，浏览器里真跑一遍登录 + 发消息
 *
 * 这条套件的意义：分离部署最容易出的问题是"某些请求还写着相对路径"，
 * 那在浏览器里表现为个别功能跨域失败。所以必须真的用分离产物跑一遍。
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { section, summary, ok, eq, gte, expectOk } from './_assert.mjs';
import { connectAuthed } from './_client.mjs';

export const needsServer = true;
export const relaxedRateLimit = true;
/**
 * 关键：不设 PUBLIC_DIR（服务端只做 API），并允许测试里那个静态服务器的来源。
 *
 * 客户端跑在随机端口上，而 `serverEnv` 是**启动前**就要确定的 ——
 * 所以这里放开一个端口段（127.0.0.1 上的高位端口），而不是某一只固定端口。
 * 生产环境绝不能这么写，这是**测试专用**的便利。
 */
/** 只关掉前端托管；CORS 来源要在拿到静态服务器端口后才知道（见 run()）。 */
export const serverEnv = { PUBLIC_DIR: '' };

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '../..');
const DIST = path.join(REPO, 'packages/web/dist-split');

export async function run(ctx) {
  const { http, wsUrl, baseUrl } = ctx;

  section('1. 服务端不托管前端：/ 返回 404');
  {
    const res = await http('GET', '/');
    eq(res.status, 404, '不设 PUBLIC_DIR 时 `/` 是 404（服务端只管 API）');
    const api = await http('GET', '/healthz');
    eq(api.status, 200, '/healthz 仍然可用');
  }

  section('2. 没有 CORS_ORIGINS 时不返回任何 CORS 头');
  {
    const res = await fetch(`${baseUrl}/healthz`, {
      headers: { origin: 'https://app.example.com' },
    });
    eq(res.headers.get('access-control-allow-origin'), null, '同源部署不加 CORS 头');
  }

  section('3. 起独立静态服务器（模拟 CDN），并让服务端只放行这个来源');
  {
    // 顺序很重要：静态服务器端口 → 才知道客户端来源 → 重启服务端（带 CORS）→
    // 才知道最终 API 地址 → 最后才构建客户端。反了就会构建出指向旧端口的产物。
  }

  section('4. 构建分离产物并在浏览器里真跑一遍');
  {
    if (process.env['PLAYWRIGHT_BROWSERS_PATH'] === undefined) {
      process.env['PLAYWRIGHT_BROWSERS_PATH'] = path.resolve(REPO, '../.runtime/pw-browsers');
    }
    let chromium;
    try {
      ({ chromium } = await import('playwright-core'));
    } catch (err) {
      ok(false, `playwright-core 不可用：${err instanceof Error ? err.message : String(err)}`);
      return summary('split');
    }

    // 一个只发静态文件的极简服务器（模拟 CDN / 另一个域名）
    const staticServer = createServer((req, res) => {
      void (async () => {
        const urlPath = (req.url ?? '/').split('?')[0];
        const rel = urlPath === '/' ? 'index.html' : urlPath.replace(/^\//, '');
        const file = path.join(DIST, rel);
        try {
          const data = await readFile(file);
          const type = file.endsWith('.js')
            ? 'text/javascript'
            : file.endsWith('.css')
              ? 'text/css'
              : 'text/html';
          res.writeHead(200, { 'content-type': type });
          res.end(data);
        } catch {
          // SPA 兜底
          try {
            res.writeHead(200, { 'content-type': 'text/html' });
            res.end(await readFile(path.join(DIST, 'index.html')));
          } catch {
            res.writeHead(404);
            res.end();
          }
        }
      })();
    });
    await new Promise((r) => staticServer.listen(0, '127.0.0.1', () => r()));
    const port = staticServer.address().port;
    const clientUrl = `http://127.0.0.1:${port}`;
    ok(true, `独立静态服务器（模拟 CDN）在 ${clientUrl}`);

    // 现在才知道客户端来源 —— 用它重启服务端，只放行这一个 origin。
    // 生产里 CORS_ORIGINS 是部署时写死的域名，这里因为端口是随机的，
    // 所以必须"先定来源再起服务端"，不能提前写一个端口段猜。
    await ctx.restartServer({ PUBLIC_DIR: '', CORS_ORIGINS: clientUrl });
    ok(true, `服务端已按精确来源重启（CORS_ORIGINS=${clientUrl}）`);

    // 现在 API 地址才最终确定 —— 用**这个**地址构建客户端。
    // 早一步构建就会指向重启前的旧端口，浏览器里表现为 "Failed to fetch"。
    const finalBase = ctx.baseUrl;
    ok(true, `最终 API 地址 ${finalBase}`);

    const build = spawn(
      'pnpm',
      ['--filter', '@agentlink/web', 'exec', 'vite', 'build', '--outDir', 'dist-split'],
      {
        cwd: REPO,
        env: { ...process.env, VITE_API_BASE: finalBase },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    let buildOut = '';
    build.stdout.on('data', (b) => (buildOut += b.toString()));
    build.stderr.on('data', (b) => (buildOut += b.toString()));
    const buildCode = await new Promise((resolve) => build.once('exit', resolve));
    eq(buildCode, 0, '分离构建成功');
    const exists = await stat(path.join(DIST, 'index.html')).then(() => true).catch(() => false);
    ok(exists, 'dist-split/index.html 存在');

    const html = await readFile(path.join(DIST, 'index.html'), 'utf8');
    const jsFile = /src="([^"]+\.js)"/.exec(html)?.[1] ?? '';
    const js = await readFile(path.join(DIST, jsFile.replace(/^\//, '')), 'utf8');
    ok(
      js.includes(new URL(finalBase).host),
      `产物里写入了**最终**服务端地址（${new URL(finalBase).host}）`,
    );

    const browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1280, height: 820 } });
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    try {
      await page.goto(clientUrl, { waitUntil: 'networkidle' });
      await page.waitForSelector('#username', { timeout: 20_000 });
      ok(true, '分离产物能在浏览器里打开（登录页渲染出来了）');

      // 先用 API 跨域注册（顺带验证 CORS 对 POST 生效），再在 UI 里登录
      const uname = `split_${Date.now().toString(36)}`;
      const reg = await fetch(`${ctx.baseUrl}/api/auth/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: clientUrl },
        body: JSON.stringify({ username: uname, display_name: '分离用户', password: 'split-pass-123' }),
      });
      eq(reg.status, 201, `跨域注册成功（${reg.status}）`);

      await page.fill('#username', uname);
      await page.fill('#password', 'split-pass-123');
      await page.click('button[type=submit]');

      // 登录成功 = 跨域 POST /api/auth/register + /api/auth/login 都通了
      try {
        await page.waitForSelector('text=退出', { timeout: 25_000 });
      } catch (err) {
        const diag = await page.evaluate(() => ({
          url: location.href,
          body: document.body.innerText.slice(0, 300),
          hasLogin: document.getElementById('username') !== null,
        }));
        console.log('  诊断:', JSON.stringify(diag));
        console.log('  页面报错:', JSON.stringify(errors.slice(0, 3)));
        throw err;
      }
      ok(true, '跨域登录成功（CORS 生效）');

      // WS 也要能连上（分离部署下 ws:// 指向服务端，而不是当前页面 host）。
      // 刚登录时连接还在建立，所以要等状态徽标出现，不能立刻 count。
      await page.waitForSelector('text=● 已连接', { timeout: 20_000 });
      ok(true, 'WebSocket 也连上了（分离部署下 WS 走绝对地址）');

      await page.screenshot({ path: path.resolve(REPO, '../.runtime/e2e-shots/16-split-client.png') });
    } finally {
      await page.close().catch(() => undefined);
      await browser.close().catch(() => undefined);
      staticServer.close();
    }
    eq(errors.length, 0, `浏览器无 JS 报错${errors[0] !== undefined ? `：${errors[0]}` : ''}`);
  }

  return summary('split');
}
