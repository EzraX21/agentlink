#!/usr/bin/env node
/**
 * visual 验收：截图视觉回归（像素级 diff）。
 *
 * 之前的 E2E 只断言"某个元素在不在"，验不到"版式有没有被改坏" ——
 * 比如 CSS 变量改错颜色、侧栏宽度算错、气泡圆角丢了。这一层把关键页面截图
 * 与**基线图**做像素比对。
 *
 * 基线放在 `packages/web/e2e-baselines/`（提交进仓库）。
 * 首次运行（或设 `UPDATE_BASELINES=1`）会写入基线；之后每次比对。
 *
 * 阈值：不同像素占比 ≤ 0.5%（理由见 THRESHOLD_RATIO 的注释）。
 * 数据用**固定时间戳**灌入，否则消息上的时钟每次都变，diff 会随机波动。
 * 跨机器跑请先 \`UPDATE_BASELINES=1\` 重建基线。
 */
import path from 'node:path';
import { mkdir, readFile, writeFile, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { section, summary, ok, eq, lte } from './_assert.mjs';
import { WsClient } from './_client.mjs';
import { openDb } from './_db.mjs';

export const needsServer = true;
export const relaxedRateLimit = true;

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '../..');
const DIST = path.join(REPO, 'packages/web/dist');
const BASELINE_DIR = path.join(REPO, 'packages/web/e2e-baselines');
const DIFF_DIR = path.resolve(REPO, '../.runtime/visual-diff');

export const serverEnv = { PUBLIC_DIR: DIST };

/**
 * 不同像素占比的上限。
 *
 * 实测同机重复跑 4 张截图的噪声在 0～0.2%（字体抗锯齿、虚拟滚动亚像素偏移），
 * 而真正的版式/配色改动会在几个百分点量级。0.5% 能容忍噪声又不放过真改动。
 */
const THRESHOLD_RATIO = 0.005;

async function mkUser(http, username, displayName) {
  const res = await http('POST', '/api/auth/register', {
    body: { username, display_name: displayName, password: 'visual-pass-123' },
  });
  if (res.status !== 201) throw new Error(`注册 ${username} 失败: ${res.status} ${res.text}`);
  return res.body;
}

export async function run(ctx) {
  const { http, wsUrl, baseUrl } = ctx;
  const update = process.env.UPDATE_BASELINES === '1';

  section('0. 准备');
  if (process.env.PLAYWRIGHT_BROWSERS_PATH === undefined) {
    process.env.PLAYWRIGHT_BROWSERS_PATH = path.resolve(REPO, '../.runtime/pw-browsers');
  }
  const distReady = await stat(path.join(DIST, 'index.html')).then(() => true).catch(() => false);
  if (!distReady) {
    ok(false, `前端产物不存在（${DIST}）：先跑 pnpm -r build`);
    return summary('visual');
  }

  let chromium;
  let PNG;
  let pixelmatch;
  try {
    ({ chromium } = await import('playwright-core'));
    ({ PNG } = await import('pngjs'));
    ({ default: pixelmatch } = await import('pixelmatch'));
  } catch (err) {
    ok(false, `依赖不可用：${err instanceof Error ? err.message : String(err)}`);
    return summary('visual');
  }

  await mkdir(BASELINE_DIR, { recursive: true });
  await mkdir(DIFF_DIR, { recursive: true });

  // ---- 数据：固定时间戳，否则每条消息渲染出的 HH:MM 每次都不同，
  //      像素 diff 会因为"时钟变了"而随机波动（实测 0.25%，贴着阈值）----
  const FIXED_TS = Date.UTC(2026, 0, 15, 10, 0, 0);
  const alice = await mkUser(http, 'alice', '爱丽丝');
  const a = new WsClient(wsUrl);
  await a.connect();
  await a.request('auth', { token: alice.access_token });
  const convRes = await a.request('conv.create', { kind: 'group', title: '视觉回归群' });
  const conv = convRes.data.conv;
  await a.request('group.update', { conv_id: conv.id, announcement: '固定的公告文案' });

  const db = openDb(ctx.dbPath);
  db.prepare(
    `INSERT INTO messages (id, tenant_id, conv_id, sender_id, seq, client_msg_id,
       content_json, text_plain, reply_to, state, interrupted, created_at, finalized_at)
     VALUES (?, 'default', ?, ?, ?, ?, ?, ?, NULL, 'final', 0, ?, ?)`,
  ).run(
    'm_VISUAL1',
    conv.id,
    alice.user.id,
    1,
    'visual-1',
    JSON.stringify([{ type: 'text', text: '第一条：自己的消息' }]),
    '第一条：自己的消息',
    FIXED_TS,
    FIXED_TS,
  );
  db.prepare(
    `INSERT INTO messages (id, tenant_id, conv_id, sender_id, seq, client_msg_id,
       content_json, text_plain, reply_to, state, interrupted, created_at, finalized_at)
     VALUES (?, 'default', ?, ?, ?, ?, ?, ?, NULL, 'final', 0, ?, ?)`,
  ).run(
    'm_VISUAL2',
    conv.id,
    alice.user.id,
    2,
    'visual-2',
    JSON.stringify([{ type: 'text', text: '第二条：带 **粗体** 与 `code` 的消息' }]),
    '第二条：带 **粗体** 与 `code` 的消息',
    FIXED_TS + 60_000,
    FIXED_TS + 60_000,
  );
  db.close();

  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const results = [];

  /** 截图缓冲（用于做"深色确实更暗"这类不依赖人眼的校验）。 */
  const buffers = new Map();

  /** 截一张并与基线比对。 */
  async function shoot(name, prepare) {
    await prepare();
    // 等动画/字体稳定
    await page.waitForTimeout(350);
    const buf = await page.screenshot({ type: 'png' });
    buffers.set(name, buf);
    const baselinePath = path.join(BASELINE_DIR, `${name}.png`);

    const baselineExists = await stat(baselinePath).then(() => true).catch(() => false);
    if (!baselineExists || update) {
      await writeFile(baselinePath, buf);
      results.push({ name, status: update ? 'updated' : 'created', ratio: 0 });
      return;
    }

    const before = PNG.sync.read(await readFile(baselinePath));
    const after = PNG.sync.read(buf);
    if (before.width !== after.width || before.height !== after.height) {
      await writeFile(path.join(DIFF_DIR, `${name}.png`), buf);
      results.push({ name, status: 'size-changed', ratio: 1 });
      return;
    }

    const diff = new PNG({ width: before.width, height: before.height });
    const changed = pixelmatch(before.data, after.data, diff.data, before.width, before.height, {
      threshold: 0.1,
    });
    const ratio = changed / (before.width * before.height);
    if (ratio > THRESHOLD_RATIO) {
      await writeFile(path.join(DIFF_DIR, `${name}.png`), PNG.sync.write(diff));
      await writeFile(path.join(DIFF_DIR, `${name}.actual.png`), buf);
    }
    results.push({ name, status: 'compared', ratio });
  }

  try {
    await page.goto(`${baseUrl}/`, { waitUntil: 'networkidle' });
    await shoot('01-login', async () => {
      await page.waitForSelector('#username');
    });

    await page.fill('#username', 'alice');
    await page.fill('#password', 'visual-pass-123');
    await page.click('button[type=submit]');
    await page.waitForSelector('text=视觉回归群', { timeout: 20_000 });

    await shoot('02-chat', async () => {
      await page.click('text=视觉回归群');
      await page.waitForSelector('[data-message-id]', { timeout: 10_000 });
    });

    await shoot('03-admin', async () => {
      await page.goto(`${baseUrl}/#/admin`, { waitUntil: 'networkidle' });
      await page.waitForSelector('text=概览', { timeout: 20_000 });
    });

    await shoot('04-narrow', async () => {
      await page.setViewportSize({ width: 390, height: 844 });
      await page.goto(`${baseUrl}/`, { waitUntil: 'networkidle' });
      await page.waitForSelector('text=视觉回归群', { timeout: 20_000 });
    });

    // 回到桌面宽度，覆盖"弹窗/菜单/面板"这些状态（它们有自己的版式）
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto(`${baseUrl}/`, { waitUntil: 'networkidle' });
    await page.waitForSelector('text=视觉回归群', { timeout: 20_000 });
    await page.click('text=视觉回归群');
    await page.waitForSelector('[data-message-id]', { timeout: 10_000 });

    await shoot('05-group-info', async () => {
      await page.click('button[title*="群信息"]');
      await page.waitForSelector('[role="dialog"]', { timeout: 10_000 });
    });

    await shoot('06-context-menu', async () => {
      await page.keyboard.press('Escape');
      await page.waitForTimeout(200);
      // 右键最后一条消息（坐标由元素位置决定，可复现）
      await page.locator('[data-message-id]').last().click({ button: 'right' });
      await page.waitForSelector('[role="menu"]', { timeout: 10_000 });
    });

    await shoot('07-search-panel', async () => {
      await page.keyboard.press('Escape');
      await page.waitForTimeout(200);
      await page.keyboard.press('Control+k');
      await page.fill('input[placeholder*="搜索消息"]', '第一条');
      await page.waitForSelector('mark', { timeout: 10_000 });
      await page.waitForTimeout(400); // 等去抖与列表稳定
    });

    await shoot('08-dark-chat', async () => {
      await page.keyboard.press('Escape');
      // 切深色主题：点右下角主题按钮（比直接写 localStorage 更接近真实操作）
      await page.click('button:has-text("🌙"), button:has-text("☀️")');
      await page.waitForTimeout(300);
    });
  } finally {
    await page.close().catch(() => undefined);
    await browser.close().catch(() => undefined);
    a.close();
  }

  section('像素比对结果');
  for (const r of results) {
    if (r.status === 'created') ok(true, `${r.name}: 首次运行，已写入基线`);
    else if (r.status === 'updated') ok(true, `${r.name}: 已更新基线`);
    else if (r.status === 'size-changed') ok(false, `${r.name}: 截图尺寸变了（见 ${DIFF_DIR}）`);
    else
      lte(
        Number((r.ratio * 100).toFixed(3)),
        THRESHOLD_RATIO * 100,
        `${r.name}: 差异 ${(r.ratio * 100).toFixed(3)}%（阈值 ≤ ${(THRESHOLD_RATIO * 100).toFixed(1)}%）`,
      );
  }

  // 客观校验：深色主题截图的平均亮度必须明显低于浅色。
  // 否则"深色基线"可能截到的是没切过去的浅色页 —— 人眼不看的自动化会一直绿。
  const meanLuma = (buf) => {
    const png = PNG.sync.read(buf);
    let sum = 0;
    let n = 0;
    // 抽样即可（每 7 个像素取一个），避免大图全量遍历
    for (let i = 0; i < png.data.length; i += 4 * 7) {
      const r = png.data[i];
      const g = png.data[i + 1];
      const b = png.data[i + 2];
      sum += 0.299 * r + 0.587 * g + 0.114 * b;
      n += 1;
    }
    return n === 0 ? 0 : sum / n;
  };
  const lightChat = buffers.get('02-chat');
  const darkChat = buffers.get('08-dark-chat');
  if (lightChat !== undefined && darkChat !== undefined) {
    const light = meanLuma(lightChat);
    const dark = meanLuma(darkChat);
    ok(
      dark < light * 0.75,
      `深色主题确实更暗：浅色平均亮度 ${light.toFixed(1)}，深色 ${dark.toFixed(1)}`,
    );
  }

  const compared = results.filter((r) => r.status === 'compared');
  eq(results.length, 8, `共 8 张截图（基础页 + 弹窗/菜单/搜索/深色），其中 ${compared.length} 张与基线比对`);
  ok(true, `基线目录：${BASELINE_DIR}；diff 输出：${DIFF_DIR}`);

  return summary('visual');
}