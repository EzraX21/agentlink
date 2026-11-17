#!/usr/bin/env node
/**
 * perf 验收：性能实测（写入 reports/perf.md）。
 *
 * 这一套补的是 M6 验收第 3 条 —— "造 1000 条消息，滚动流畅（DevTools Performance
 * 记录，长任务 < 50ms）"。之前的验证只测了"1000 条插入 store 的耗时"，
 * 那是逻辑耗时，不是**浏览器里**的渲染与滚动。
 *
 * 这里用真 Chromium + PerformanceObserver 采集 longtask 与 rAF 帧间隔，
 * 并把原始数字写进 reports/perf.md（不只给结论，给证据）。
 *
 * 阈值刻意分成两档：
 *   - 硬门槛（会让验收失败）：单次 longtask > 200ms、最差帧 > 250ms
 *   - 目标（只报告不失败）：长任务中位数 ≤ 50ms（M6 的目标值）
 * 因为在共享/虚拟化的 CI 机器上，偶发一次长任务不能说明实现有问题；
 * 但"每次滚动都卡半秒"必须拦住。
 */
import { spawn } from 'node:child_process';
import { mkdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { section, summary, ok, eq, gte, lte, expectOk } from './_assert.mjs';
import { WsClient } from './_client.mjs';
import { openDb } from './_db.mjs';

export const needsServer = true;
export const relaxedRateLimit = true;

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.resolve(HERE, '../../packages/web/dist');
const REPORT_DIR = path.resolve(HERE, '../../reports');
export const serverEnv = { PUBLIC_DIR: DIST };

const MSG_COUNT = 1000;

async function mkUser(http, username, displayName) {
  const res = await http('POST', '/api/auth/register', {
    body: { username, display_name: displayName, password: 'perf-pass-123' },
  });
  if (res.status !== 201) throw new Error(`注册 ${username} 失败: ${res.status} ${res.text}`);
  return res.body;
}

export async function run(ctx) {
  const { http, wsUrl, repoRoot, baseUrl, dbPath } = ctx;

  section('0. 准备浏览器与产物');
  if (process.env.PLAYWRIGHT_BROWSERS_PATH === undefined) {
    process.env.PLAYWRIGHT_BROWSERS_PATH = path.resolve(HERE, '../../../.runtime/pw-browsers');
  }
  const distReady = await stat(path.join(DIST, 'index.html')).then(() => true).catch(() => false);
  if (!distReady) {
    ok(false, `前端产物不存在（${DIST}）：先跑 pnpm -r build`);
    return summary('perf');
  }

  let chromium;
  try {
    ({ chromium } = await import('playwright-core'));
  } catch (err) {
    ok(false, `playwright-core 不可用：${err instanceof Error ? err.message : String(err)}`);
    return summary('perf');
  }

  // ---- 数据准备：1000 条消息（直接写库，避免撞限流）----
  const alice = await mkUser(http, 'alice', '爱丽丝');
  const a = new WsClient(wsUrl);
  await a.connect();
  expectOk(await a.request('auth', { token: alice.access_token }), 'WS 认证');
  const conv = expectOk(
    await a.request('conv.create', { kind: 'group', title: '性能测试群', member_ids: [] }),
    '建群',
  ).conv;

  const db = openDb(dbPath);
  const insert = db.prepare(
    `INSERT INTO messages (id, tenant_id, conv_id, sender_id, seq, client_msg_id,
       content_json, text_plain, reply_to, state, interrupted, created_at, finalized_at)
     VALUES (?, 'default', ?, ?, ?, ?, ?, ?, NULL, 'final', 0, ?, ?)`,
  );
  const insertEvent = db.prepare(
    `INSERT INTO events (tenant_id, conv_id, type, payload, created_at) VALUES ('default', ?, ?, ?, ?)`,
  );
  const seedStart = Date.now();
  db.transaction(() => {
    for (let i = 0; i < MSG_COUNT; i += 1) {
      const id = `m_PERF${String(i).padStart(18, '0')}`;
      const text = `性能测试消息 ${i}，内容是中等长度的一段中文，用来模拟真实聊天里的消息体`;
      const ts = Date.now() - (MSG_COUNT - i) * 1000;
      insert.run(
        id,
        conv.id,
        alice.user.id,
        10_000 + i,
        `perf-${i}`,
        JSON.stringify([{ type: 'text', text }]),
        text,
        ts,
        ts,
      );
      // 事件 payload 必须与真实发送一致（含 sender/content/seq）：
      // 客户端 resume 会回放这些事件，缺字段会让它崩 —— 这正是本轮抓到的问题
      insertEvent.run(
        conv.id,
        'message.new',
        JSON.stringify({
          conv_id: conv.id,
          mentions: [],
          message: {
            id,
            conv_id: conv.id,
            seq: 10_000 + i,
            sender: { id: alice.user.id, kind: 'human', display_name: '爱丽丝' },
            content: [{ type: 'text', text }],
            reply_to: null,
            state: 'final',
            interrupted: false,
            created_at: ts,
            revoked_at: null,
          },
        }),
        ts,
      );
    }
  })();
  const seeded = db.prepare('SELECT count(*) AS n FROM messages WHERE conv_id = ?').get(conv.id).n;
  const seedMs = Date.now() - seedStart;
  db.close();
  eq(seeded, MSG_COUNT, `库里灌了 ${seeded} 条消息`);
  ok(true, `灌数据耗时 ${seedMs}ms`);

  section('1. 接口层耗时（history.fetch / search）');
  const t1 = performance.now();
  const page1 = expectOk(
    await a.request('history.fetch', { conv_id: conv.id, limit: 50 }),
    'history.fetch limit=50',
  );
  const historyMs = performance.now() - t1;
  eq(page1.messages.length, 50, '返回 50 条');
  ok(true, `history.fetch(50) ${historyMs.toFixed(1)}ms`);

  const t2 = performance.now();
  const searchRes = expectOk(
    await a.request('search.messages', { q: '性能测试消息 999', limit: 20 }),
    'search.messages',
  );
  const searchMs = performance.now() - t2;
  gte(searchRes.hits.length, 1, `搜索命中 ${searchRes.hits.length} 条`);
  ok(true, `search ${searchMs.toFixed(1)}ms`);

  section('2. 浏览器内：1000 条消息的滚动与长任务');
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const browserErrors = [];
  page.on('pageerror', (e) => browserErrors.push(e.message));

  let scrollMetrics = null;
  let firstPaintMs = null;
  let openLtWorst = 0;
  let bubblesInDom = 0;
  try {
    await page.goto(`${baseUrl}/`, { waitUntil: 'networkidle' });
    await page.fill('#username', 'alice');
    await page.fill('#password', 'perf-pass-123');
    await page.click('button[type=submit]');
    await page.waitForSelector('text=性能测试群', { timeout: 20_000 });

    // 开始采集 longtask 与 rAF 帧间隔
    await page.evaluate(() => {
      // 注意：这段在浏览器里执行，必须是纯 JS（不能有 TS 语法）
      const w = window;
      w.__perf = { longtasks: [], frames: [], last: 0 };
      try {
        const po = new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) w.__perf.longtasks.push(entry.duration);
        });
        po.observe({ entryTypes: ['longtask'] });
      } catch {
        /* 不支持 longtask 就只靠帧间隔 */
      }
      const tick = (t) => {
        if (w.__perf.last !== 0) w.__perf.frames.push(t - w.__perf.last);
        w.__perf.last = t;
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });

    const openStart = Date.now();
    await page.click('text=性能测试群');
    // 等到消息真的渲染出来（虚拟滚动首屏）
    await page.waitForSelector('[data-message-id]', { timeout: 25_000 });
    firstPaintMs = Date.now() - openStart;

    // 打开会话那次长任务单独记（渲染首屏 1000 条的 rows + 虚拟化测量），
    // 不应该混进"滚动流畅度"里 —— 规格 M6 第 3 条说的是滚动。
    const openLongTasks = await page.evaluate(() => {
      const w = window;
      const lt = [...w.__perf.longtasks];
      w.__perf.longtasks = [];
      w.__perf.frames = [];
      w.__perf.last = 0;
      return lt;
    });
    openLtWorst = openLongTasks.length === 0 ? 0 : Math.max(...openLongTasks);

    const scroller = page.locator('.al-chat-bg').first();
    // 来回滚动多次，覆盖虚拟滚动的挂载/卸载
    for (let round = 0; round < 6; round += 1) {
      await scroller.evaluate((el) => {
        el.scrollTop = 0;
      });
      await page.waitForTimeout(250);
      await scroller.evaluate((el) => {
        el.scrollTop = el.scrollHeight;
      });
      await page.waitForTimeout(250);
      await scroller.evaluate((el) => {
        el.scrollTop = Math.floor(el.scrollHeight * 0.5);
      });
      await page.waitForTimeout(200);
    }

    scrollMetrics = await page.evaluate(() => {
      const w = window;
      const frames = w.__perf.frames.filter((f) => f > 0);
      const sorted = [...frames].sort((x, y) => x - y);
      const p = (q) => (sorted.length === 0 ? 0 : sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))]);
      return {
        longtasks: w.__perf.longtasks,
        frames: frames.length,
        p50: p(0.5),
        p95: p(0.95),
        worst: sorted.length === 0 ? 0 : sorted[sorted.length - 1],
      };
    });

    const rendered = await page.locator('[data-message-id]').count();
    bubblesInDom = rendered;
    ok(rendered > 0 && rendered < 200, `DOM 里只有 ${rendered} 个气泡（虚拟滚动生效，没有全量渲染 1000 条）`);
    await page.screenshot({ path: path.resolve(HERE, '../../../.runtime/e2e-shots/perf-1000.png') });
  } finally {
    await page.close().catch(() => undefined);
    await browser.close().catch(() => undefined);
    a.close();
  }

  eq(browserErrors.length, 0, `浏览器无 JS 报错${browserErrors[0] !== undefined ? `：${browserErrors[0]}` : ''}`);
  ok(firstPaintMs !== null && firstPaintMs < 5000, `打开含 1000 条的会话首屏 ${firstPaintMs}ms（< 5000ms）`);

  const lt = scrollMetrics?.longtasks ?? [];
  const sortedLt = [...lt].sort((x, y) => x - y);
  const ltP50 = sortedLt.length === 0 ? 0 : (sortedLt[Math.floor(sortedLt.length / 2)] ?? 0);
  const ltWorst = sortedLt.length === 0 ? 0 : (sortedLt[sortedLt.length - 1] ?? 0);

  section('3. 结论');
  ok(true, `打开会话那一次的最长任务 ${openLtWorst.toFixed(0)}ms（含渲染 1000 条的 list；只报告不设门禁）`);
  ok(
    ltWorst <= 200,
    `滚动期间最差长任务 ${ltWorst.toFixed(0)}ms（硬门槛 ≤200ms，共 ${lt.length} 次）`,
  );
  ok(
    (scrollMetrics?.worst ?? 0) <= 250,
    `滚动期间最差帧间隔 ${(scrollMetrics?.worst ?? 0).toFixed(0)}ms（硬门槛 ≤250ms）`,
  );
  // 滚动阶段：只要出现 longtask，最短也是 50ms 量级（该 API 只报 >50ms 的任务）
  eq(
    lt.length,
    0,
    `滚动期间没有长任务（M6 验收 3 的目标：长任务 < 50ms）${lt.length > 0 ? `，实际 ${lt.length} 次，最长 ${ltWorst.toFixed(0)}ms` : ''}`,
  );

  // ---- 报告 ----
  await mkdir(REPORT_DIR, { recursive: true });
  const report = `# 性能实测（自动生成）

> 由 \`node scripts/acceptance/run.mjs perf\` 生成，数据来自真 Chromium（headless）。
> 机器：本机沙箱（可能与你的机器差异较大，看相对量级即可）。

## 环境

- 消息数：${MSG_COUNT} 条（同一会话）
- 浏览器：Chromium headless（Playwright）
- 视口：1280×800

## 接口层

| 操作 | 耗时 |
|---|---|
| 灌 ${MSG_COUNT} 条（直接写库，单事务） | ${seedMs} ms |
| \`history.fetch\`（limit 50） | ${historyMs.toFixed(1)} ms |
| \`search.messages\`（命中 ${searchRes.hits.length} 条） | ${searchMs.toFixed(1)} ms |

## 浏览器内（滚动 + 虚拟滚动）

| 指标 | 数值 |
|---|---|
| 打开会话到首屏消息渲染 | ${firstPaintMs} ms |
| 打开会话那次的最长任务（只报告） | ${openLtWorst.toFixed(0)} ms |
| DOM 中气泡数（虚拟滚动生效） | ${bubblesInDom}（共 ${MSG_COUNT} 条） |
| rAF 采样帧数 | ${scrollMetrics?.frames ?? 0} |
| 帧间隔 p50 / p95 / 最差 | ${(scrollMetrics?.p50 ?? 0).toFixed(1)} / ${(scrollMetrics?.p95 ?? 0).toFixed(1)} / ${(scrollMetrics?.worst ?? 0).toFixed(1)} ms |
| longtask 次数 | ${lt.length} |
| longtask 中位数 / 最差 | ${ltP50.toFixed(1)} / ${ltWorst.toFixed(1)} ms |

## 判读

- M6 验收第 3 条的目标是"滚动流畅（长任务 < 50ms）"。**滚动期间**共 ${lt.length} 次长任务，
  中位数 ${ltP50.toFixed(0)}ms、最差 ${ltWorst.toFixed(0)}ms。
- **打开会话**那一次另有 ${openLtWorst.toFixed(0)}ms 的长任务（一次性：构造 1000 行的列表
  索引 + 虚拟化首次测量）。它不是滚动卡顿，但如果要优化，方向是"只按可见窗口构造行"。
- 注：\`longtask\` API 只上报 **> 50ms** 的任务，所以"0 次"等于"没有任何任务超过 50ms"。
- 虚拟滚动生效：1000 条消息下 DOM 里只挂载了少量气泡，没有全量渲染。
- 硬门槛（本仓库 \`perf\` 套件）：最差长任务 ≤ 200ms、最差帧 ≤ 250ms。
`;

  await writeFile(path.join(REPORT_DIR, 'perf.md'), report, 'utf8');
  ok(true, `报告已写入 reports/perf.md`);

  return summary('perf');
}