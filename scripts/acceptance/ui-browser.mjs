#!/usr/bin/env node
/**
 * ui-browser 验收：**真浏览器**端到端（Chromium，headless）。
 *
 * 为什么需要这一层：之前的 UI 验证是 jsdom（组件渲染）+ Node 内驱动 store（状态逻辑）。
 * 那些都验不到"真实渲染结果"——比如虚拟滚动交给浏览器的布局、真实文件上传、
 * CSS 断点、blob URL 图片、Ctrl+K 的键盘事件。这一层补的就是这些。
 *
 * 拿不到浏览器时**明确失败**并提示安装命令，不静默跳过
 * （施工守则 §4：没跑通就是没跑通）。
 *
 * 安装浏览器（一次性，~126 MiB）：
 *   PLAYWRIGHT_BROWSERS_PATH=../.runtime/pw-browsers \
 *     npx playwright-core install chromium
 * 或者：pnpm run e2e:install
 */
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { section, summary, ok, eq, gte, includes, expectOk } from './_assert.mjs';
import { WsClient } from './_client.mjs';

const exec = promisify(execFile);

export const needsServer = true;
export const relaxedRateLimit = true;

/**
 * 浏览器验收要服务端**自己托管前端产物**（否则 `/` 是 404）。
 * 路径必须是绝对的：服务端进程的 cwd 是 packages/server。
 */
const DIST = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../packages/web/dist');
export const serverEnv = { PUBLIC_DIR: DIST };

const SHOT_DIR = path.resolve(process.env.E2E_SHOT_DIR ?? '../.runtime/e2e-shots');

async function loadChromium() {
  // 浏览器路径由环境变量控制（HOME 只读时默认位置不可用）
  if (process.env.PLAYWRIGHT_BROWSERS_PATH === undefined) {
    process.env.PLAYWRIGHT_BROWSERS_PATH = path.resolve('../.runtime/pw-browsers');
  }
  try {
    const mod = await import('playwright-core');
    return mod.chromium;
  } catch (err) {
    throw new Error(
      `playwright-core 未安装：${err instanceof Error ? err.message : String(err)}\n` +
        `先跑 pnpm install，然后 pnpm run e2e:install`,
    );
  }
}

async function mkUser(http, username, displayName) {
  const res = await http('POST', '/api/auth/register', {
    body: { username, display_name: displayName, password: 'browser-pass-123' },
  });
  if (res.status !== 201) throw new Error(`注册 ${username} 失败: ${res.status} ${res.text}`);
  return res.body;
}

export async function run(ctx) {
  const { http, wsUrl, repoRoot, baseUrl } = ctx;

  section('0. 准备浏览器');
  let chromium;
  try {
    chromium = await loadChromium();
  } catch (err) {
    ok(false, `浏览器层不可用：${(err instanceof Error ? err.message : String(err)).split('\n')[0]}`);
    return summary('ui-browser');
  }

  let browser;
  try {
    browser = await chromium.launch();
  } catch (err) {
    ok(
      false,
      `Chromium 启动失败（先跑 pnpm run e2e:install）：${(err instanceof Error ? err.message : String(err)).split('\n')[0]}`,
    );
    return summary('ui-browser');
  }
  ok(true, `Chromium 已启动 ${browser.version()}`);

  // 产物必须存在，否则页面根本打不开（给出可执行的提示，而不是等到超时）
  const distReady = await stat(path.join(DIST, 'index.html')).then(() => true).catch(() => false);
  if (!distReady) {
    ok(false, `前端产物不存在（${DIST}）：先跑 pnpm --filter @agentlink/web build`);
    await browser.close();
    return summary('ui-browser');
  }
  ok(true, '前端产物存在（服务端以 PUBLIC_DIR 托管）');
  await mkdir(SHOT_DIR, { recursive: true });

  // ---- 数据准备（走 API，节省时间；UI 只验证界面本身）----
  const alice = await mkUser(http, 'alice', '爱丽丝');
  const agentRes = await http('POST', '/api/admin/agents', {
    token: alice.access_token,
    body: { username: 'echo', display_name: '回显助手' },
  });
  if (agentRes.status !== 201) throw new Error(`建 agent 失败: ${agentRes.text}`);
  const agentToken = agentRes.body.token;
  const agentId = agentRes.body.agent.id;

  const a = new WsClient(wsUrl);
  await a.connect();
  expectOk(await a.request('auth', { token: alice.access_token }), 'WS 认证');
  const conv = expectOk(
    await a.request('conv.create', {
      kind: 'group',
      title: '浏览器测试群',
      member_ids: [agentId],
    }),
    '建群（含 agent）',
  ).conv;
  expectOk(
    await a.request('group.update', {
      conv_id: conv.id,
      announcement: '这是一条群公告',
    }),
    '设置群公告',
  );

  // 起 echo agent，供流式验证
  const agentProc = spawn(process.execPath, [path.join(repoRoot, 'examples/echo-agent/index.mjs')], {
    cwd: path.join(repoRoot, 'examples/echo-agent'),
    env: { ...process.env, AGENTLINK_URL: wsUrl, AGENTLINK_TOKEN: agentToken },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let agentLogs = '';
  agentProc.stdout.on('data', (b) => (agentLogs += b.toString()));
  agentProc.stderr.on('data', (b) => (agentLogs += b.toString()));

  const page = await browser.newPage({ viewport: { width: 1280, height: 820 } });
  const consoleErrors = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
  });
  page.on('pageerror', (err) => consoleErrors.push(`pageerror: ${err.message}`));

  try {
    section('1. 登录页（真实渲染）');
    await page.goto(`${baseUrl}/`, { waitUntil: 'networkidle' });
    eq(await page.title(), 'AgentLink', '页面标题正确');
    ok((await page.locator('#username').count()) === 1, '渲染出用户名输入框');
    ok((await page.getByRole('button', { name: '登录' }).count()) === 1, '渲染出登录按钮');
    await page.screenshot({ path: path.join(SHOT_DIR, '01-login.png') });

    await page.fill('#username', 'alice');
    await page.fill('#password', 'browser-pass-123');
    await page.click('button[type=submit]');

    section('2. 登录后看到会话与群公告');
    await page.waitForSelector('text=浏览器测试群', { timeout: 20_000 });
    ok(true, '会话列表出现「浏览器测试群」');
    await page.click('text=浏览器测试群');
    await page.waitForSelector('text=这是一条群公告', { timeout: 10_000 });
    ok(true, '群公告横幅渲染出来了');
    await page.screenshot({ path: path.join(SHOT_DIR, '02-chat.png') });

    section('3. 发消息只出现一次（重复 bug 的真浏览器回归）');
    const text = `浏览器发的消息-${Date.now()}`;
    await page.fill('textarea', text);
    await page.keyboard.press('Enter');
    await page.waitForSelector(`text=${text}`, { timeout: 10_000 });
    // 等一拍，确保服务端回推（message.new）也到了
    await page.waitForTimeout(600);
    const occurrences = await page.locator(`[data-message-id]`, { hasText: text }).count();
    eq(occurrences, 1, '同一条消息在 DOM 里只有一个气泡');
    await page.screenshot({ path: path.join(SHOT_DIR, '03-sent.png') });

    section('4. @agent 流式回复：文本在真实 DOM 里逐字增长');
    await page.fill('textarea', '@echo 你好');
    await page.keyboard.press('Enter');
    // 等到出现一个流式气泡（有 al-streaming 类）
    await page.waitForSelector('.al-streaming', { timeout: 15_000 });
    const lengths = [];
    for (let i = 0; i < 12; i += 1) {
      const len = await page.evaluate(() => {
        const el = document.querySelector('.al-streaming');
        return el === null ? -1 : (el.textContent ?? '').length;
      });
      if (len >= 0) lengths.push(len);
      await page.waitForTimeout(120);
      // 流式结束后光标消失，收尾
      if ((await page.locator('.al-streaming').count()) === 0) break;
    }
    const distinct = [...new Set(lengths)];
    gte(distinct.length, 2, `观察到 ${distinct.length} 个不同长度（${lengths.join(',')}）`);
    await page.screenshot({ path: path.join(SHOT_DIR, '04-streaming.png') });
    // 等流式结束
    await page.waitForTimeout(2500);
    const finalHasEcho = await page.locator('[data-message-id]', { hasText: '你说的是' }).count();
    gte(finalHasEcho, 1, '最终把完整回复落在气泡里');

    section('5. 附件：真实文件上传 + blob 图片渲染');
    const pngPath = path.join(SHOT_DIR, 'upload.png');
    await writeFile(pngPath, makePng(48 * 1024));
    await page.setInputFiles('input[type=file]', pngPath);
    await page.waitForSelector('img[src^="blob:"]', { timeout: 20_000 });
    const imgInfo = await page.evaluate(() => {
      const img = document.querySelector('img[src^="blob:"]');
      return img === null
        ? null
        : { w: img.naturalWidth, h: img.naturalHeight };
    });
    ok(imgInfo !== null && imgInfo.w > 0, `图片真的解码出来了（${imgInfo?.w}×${imgInfo?.h}）`);
    await page.screenshot({ path: path.join(SHOT_DIR, '05-image.png') });

    section('6. 搜索（Ctrl+K → 命中高亮）');
    await page.keyboard.press('Control+k');
    await page.waitForSelector('input[placeholder*="搜索消息"]', { timeout: 5000 });
    await page.fill('input[placeholder*="搜索消息"]', '浏览器发的消息');
    await page.waitForSelector('mark', { timeout: 10_000 });
    const markText = await page.locator('mark').first().textContent();
    includes(markText ?? '', '浏览器', '命中片段里 <mark> 包住关键词');
    await page.screenshot({ path: path.join(SHOT_DIR, '06-search.png') });

    // 搜索面板也是按需 chunk：打开搜索后才应出现在资源列表里
    const afterSearchAssets = await page.evaluate(() =>
      performance
        .getEntriesByType('resource')
        .map((e) => e.name)
        .filter((n) => n.includes('/assets/')),
    );
    ok(
      afterSearchAssets.some((n) => /SearchPanel-[^/]+\.js/.test(n)),
      '搜索面板作为独立 chunk 被按需加载',
    );
    await page.keyboard.press('Escape');

    section('7. 管理页（真实路由 + 五个分区 + 按需加载）');
    await page.goto(`${baseUrl}/#/admin`, { waitUntil: 'networkidle' });
    await page.waitForSelector('text=概览', { timeout: 15_000 });
    for (const label of ['概览', '账号', 'Agent', '群组', '审计日志']) {
      ok((await page.locator(`text=${label}`).count()) > 0, `管理页有「${label}」分区`);
    }
    await page.screenshot({ path: path.join(SHOT_DIR, '07-admin.png'), fullPage: true });

    // 管理页是独立 chunk：打开之后才应出现在资源列表里（首屏 bundle 不含它）
    const assetNames = await page.evaluate(() =>
      performance
        .getEntriesByType('resource')
        .map((e) => e.name)
        .filter((n) => n.includes('/assets/')),
    );
    ok(
      assetNames.some((n) => /AdminPage-[^/]+\.js/.test(n)),
      '管理页作为独立 chunk 被按需加载（不在首屏 bundle 里）',
    );

    section('8. 窄屏（390×844）单栏布局');
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${baseUrl}/`, { waitUntil: 'networkidle' });
    await page.waitForSelector('text=浏览器测试群', { timeout: 20_000 });
    // 窄屏先看列表，点了会话才看聊天；聊天里有返回按钮
    await page.click('text=浏览器测试群');
    const backBtn = page.locator('button[title="返回会话列表"]');
    await backBtn.waitFor({ timeout: 10_000 });
    ok(true, '窄屏进入会话后出现返回按钮（单栏）');
    await page.screenshot({ path: path.join(SHOT_DIR, '08-narrow.png') });
    // 点返回 → 回到列表
    await backBtn.click();
    await page.waitForSelector('text=浏览器测试群', { timeout: 5000 });
    ok(true, '点返回回到会话列表');

    section('9. 断线重连：横幅要醒目，恢复后要提示');
    // 回到聊天页（前面在窄屏）
    await page.setViewportSize({ width: 1280, height: 820 });
    await page.goto(`${baseUrl}/`, { waitUntil: 'networkidle' });
    await page.waitForSelector('text=浏览器测试群', { timeout: 20_000 });
    await page.click('text=浏览器测试群');
    await page.waitForSelector('[data-message-id]', { timeout: 10_000 });

    // 杀掉服务端：客户端应显示醒目的横幅（不是一个小圆点）
    await ctx.kill9Server();
    const banner = page.locator('[role="alert"]', { hasText: '实时连接已断开' });
    await banner.waitFor({ timeout: 20_000 });
    ok(true, '断线后出现醒目横幅（role=alert）');
    ok(
      (await page.getByRole('button', { name: '立即重试' }).count()) === 1,
      '横幅上有"立即重试"',
    );
    await page.screenshot({ path: path.join(SHOT_DIR, '09-offline.png') });

    // 重启服务端 → 客户端自动重连并提示"连接已恢复"
    await ctx.startServer();
    await page.locator('[role="status"]', { hasText: '连接已恢复' }).waitFor({ timeout: 40_000 });
    ok(true, '重连后出现"连接已恢复"提示');
    await banner.waitFor({ state: 'hidden', timeout: 20_000 });
    ok(true, '横幅在恢复后消失');
    await page.screenshot({ path: path.join(SHOT_DIR, '10-reconnected.png') });

    section('10. 离线队列：断线时发的消息，恢复后自动送达且只有一条');
    // 此时服务端刚重启、页面已重连。先再断一次，模拟"用户没发现断线就发了消息"
    await ctx.kill9Server();
    await page.locator('[role="alert"]', { hasText: '实时连接已断开' }).waitFor({ timeout: 20_000 });

    const offlineText = `断线时写的-${Date.now()}`;
    // 诊断：确认输入框还在、且断线状态下图里没有别的遮罩挡住
    const textareaCount = await page.locator('textarea').count();
    ok(textareaCount === 1, `断线时输入框仍在（${textareaCount} 个）`);
    await page.fill('textarea', offlineText);
    await page.keyboard.press('Enter');
    // 气泡是虚拟滚动的，确保视图在底部（发送后应用会自动滚到底，这里再兜一下）
    await page.locator('.al-chat-bg').first().evaluate((el) => {
      el.scrollTop = el.scrollHeight;
    });
    // 断线期间：气泡必须留着并标"待发送"（不能把用户写的字丢掉）
    try {
      await page.waitForSelector(`text=${offlineText}`, { timeout: 20_000 });
    } catch (err) {
      const diag = await page.evaluate(() => ({
        bubbles: document.querySelectorAll('[data-message-id]').length,
        lastTexts: [...document.querySelectorAll('[data-message-id]')]
          .slice(-3)
          .map((el) => (el.textContent ?? '').slice(0, 60)),
        draft: (document.querySelector('textarea') ?? {}).value ?? '(无输入框)',
      }));
      console.log('  诊断：', JSON.stringify(diag));
      await page.screenshot({ path: path.join(SHOT_DIR, '11-offline-diag.png') });
      throw err;
    }
    ok(true, '断线时消息仍显示在界面上');
    ok(
      (await page.locator('text=待发送').count()) >= 1,
      '气泡上标了「待发送」',
    );
    await page.screenshot({ path: path.join(SHOT_DIR, '11-offline-queued.png') });

    // 恢复服务端 → 自动重发
    await ctx.startServer();
    await page.locator('[role="status"]', { hasText: '连接已恢复' }).waitFor({ timeout: 40_000 });
    // 等服务端真的收到了这条（用 WS 的 history.fetch 查，比看 DOM 更硬）
    const login = await http('POST', '/api/auth/login', {
      body: { username: 'alice', password: 'browser-pass-123' },
    });
    const token = login.body.access_token;
    let delivered = false;
    for (let i = 0; i < 40; i += 1) {
      const probe = new WsClient(wsUrl);
      await probe.connect();
      await probe.request('auth', { token });
      const pageRes = await probe.request('history.fetch', { conv_id: conv.id, limit: 100 });
      probe.close();
      const msgs = pageRes.data.messages;
      const hits = msgs.filter((m) =>
        m.content.some((c) => c.type === 'text' && c.text === offlineText),
      );
      if (hits.length === 1) {
        delivered = true;
        break;
      }
      if (hits.length > 1) {
        ok(false, `同一条离线消息被送达了 ${hits.length} 次（幂等失效）`);
        break;
      }
      await page.waitForTimeout(500);
    }
    ok(delivered, '恢复连接后，离线消息被自动送达（服务端只有一条）');
    // DOM 里也应只有一条，且不再标"待发送"
    await page.waitForTimeout(500);
    const domCount = await page.locator('[data-message-id]', { hasText: offlineText }).count();
    eq(domCount, 1, '界面上只有一条该消息（没有重复）');
    ok(
      (await page.locator('text=待发送').count()) === 0,
      '送达后「待发送」标记消失',
    );
    await page.screenshot({ path: path.join(SHOT_DIR, '12-offline-delivered.png') });

    section('11. 控制台没有报错');
    // 第 9 步是**故意**杀服务端来验证断线横幅，此时浏览器的 WS 连接失败是预期内的，
    // 不能算"页面报错"。除此之外的错误一律不放过。
    const realErrors = consoleErrors.filter(
      (e) =>
        !/favicon/i.test(e) &&
        !/Failed to load resource: the server responded with a status of 404/i.test(e) &&
        !/WebSocket connection to .* failed/i.test(e) &&
        !/ERR_CONNECTION_REFUSED/i.test(e),
    );
    eq(realErrors.length, 0, `浏览器控制台无错误${realErrors.length > 0 ? `：${realErrors[0]}` : ''}`);

    section('12. 截图产物');
    ok(true, `截图已存到 ${SHOT_DIR}`);
  } finally {
    await page.close().catch(() => undefined);
    await browser.close().catch(() => undefined);
    agentProc.kill('SIGTERM');
    a.close();
    if (agentLogs.includes('已连接')) ok(true, 'echo-agent 在 E2E 期间正常连上');
  }

  return summary('ui-browser');
}

/** 造一个最小合法 PNG（8×8 纯色），供上传测试用。 */
function makePng(size) {
  // 真正的 PNG 头 + IHDR/IDAT/IEND 太啰嗦；这里用一张 1×1 PNG 的字节再填充到指定大小，
  // 浏览器能解码（多余字节会被忽略）。
  const onePixel = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64',
  );
  if (size <= onePixel.length) return onePixel;
  return Buffer.concat([onePixel, Buffer.alloc(size - onePixel.length, 0)]);
}