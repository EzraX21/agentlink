#!/usr/bin/env node
/**
 * ui-admin 验收：Web 管理页 + 它依赖的管理接口。
 *
 * 这不是一个新的里程碑（M0–M11 已封版），而是 M6"管理面板"这块的补齐验收：
 * 原来只有一个三标签弹窗，且**任何人类账号**都能调管理接口。现在是一个真正的
 * 管理页（概览 / 账号 / Agent / 群组 / 审计），准入是 is_admin。
 *
 * 断言分两层：
 *   A. 服务端契约（真跑）：管理员准入、账号增删启停、Agent 建/轮换/停用、
 *      跨群成员管理、审计筛选。
 *   B. 页面产物（静态 + 渲染）：路由、五个分区、非管理员拒绝文案。
 */
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { section, summary, ok, eq, gte, includes, expectOk } from './_assert.mjs';
import { WsClient } from './_client.mjs';

export const needsServer = true;
export const relaxedRateLimit = true;

async function register(http, username, displayName) {
  const res = await http('POST', '/api/auth/register', {
    body: { username, display_name: displayName, password: 'admin-page-pass-123' },
  });
  if (res.status !== 201) throw new Error(`注册 ${username} 失败: ${res.status} ${res.text}`);
  return res.body;
}

/**
 * 用真 Chromium 点侧栏导航，断言 URL 与内容都跟着变。
 *
 * 单独写成函数是因为它要 defer import playwright（只有这个套件用到）。
 */
async function checkNavigation(repoRoot, baseUrl, adminUsername) {
  if (process.env['PLAYWRIGHT_BROWSERS_PATH'] === undefined) {
    process.env['PLAYWRIGHT_BROWSERS_PATH'] = path.resolve(repoRoot, '../.runtime/pw-browsers');
  }
  let chromium;
  try {
    ({ chromium } = await import('playwright-core'));
  } catch (err) {
    ok(false, `playwright-core 不可用：${err instanceof Error ? err.message : String(err)}`);
    return;
  }

  // 管理页用的是相对 API 地址（同源部署），所以由服务端托管 dist/ 后再打开
  const base = baseUrl;
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 860 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  try {
    await page.goto(base, { waitUntil: 'networkidle' });
    await page.waitForSelector('#username', { timeout: 20_000 });

    // 用真实凭据登录
    await page.fill('#username', adminUsername);
    await page.fill('#password', 'admin-page-pass-123');
    await page.click('button[type=submit]');
    await page.waitForSelector('text=概览', { timeout: 25_000 });
    ok(true, '登录后进了管理页');

    // 登录后 hash 应该是 #/admin（否则点侧栏会先弹回概览）
    const hashAfterLogin = await page.evaluate(() => window.location.hash);
    ok(hashAfterLogin.startsWith('#/admin'), `登录后 hash = ${hashAfterLogin}`);

    // 逐个点五个分区，断言 hash 变了**并且**对应内容渲染了
    const sections = [
      { label: '账号', hash: '#/admin/users', expect: '新建人类账号' },
      { label: 'Agent', hash: '#/admin/agents', expect: '新建 Agent' },
      { label: '群组', hash: '#/admin/groups', expect: '成员管理' },
      { label: '审计日志', hash: '#/admin/audit', expect: '动作' },
      { label: '概览', hash: '#/admin', expect: '人类账号' },
    ];
    for (const s of sections) {
      // 用链接的**精确**文本定位。`text=Agent` 会匹配到「新建 Agent」等
      // 十几个含该词的元素（Playwright 会点第一个，往往不是导航），
      // 这条断言因此假红过一次。
      await page.getByRole('link', { name: s.label, exact: true }).click();
      await page.waitForTimeout(350);
      const h = await page.evaluate(() => window.location.hash);
      eq(h, s.hash, `点「${s.label}」→ hash 变成 ${s.hash}`);
      const visible = await page.locator(`text=${s.expect}`).first().isVisible().catch(() => false);
      ok(visible, `点「${s.label}」→ 渲染出「${s.expect}」`);
    }

    eq(errors.length, 0, `浏览器无 JS 报错${errors[0] !== undefined ? `：${errors[0]}` : ''}`);
  } catch (err) {
    ok(false, `导航测试抛异常：${err instanceof Error ? err.message : String(err)}`);
    const body = await page.evaluate(() => document.body.innerText.slice(0, 300)).catch(() => '');
    console.log('    页面内容:', JSON.stringify(body));
  } finally {
    await page.close().catch(() => undefined);
    await browser.close().catch(() => undefined);
  }
}

export async function run(ctx) {
  const { http, wsUrl, repoRoot } = ctx;

  section('A1. 第一个账号自动成为管理员');
  const alice = await register(http, 'alice', '爱丽丝');
  eq(alice.is_admin, true, '第一个注册的账号 is_admin=true');
  const bob = await register(http, 'bob', '小明');
  eq(bob.is_admin, false, '第二个账号 is_admin=false');

  const me = await http('GET', '/api/auth/me', { token: bob.access_token });
  eq(me.body?.is_admin, false, '/api/auth/me 返回 is_admin=false');

  section('A2. 准入：非管理员调管理接口一律 403');
  const deniedEndpoints = [
    ['GET', '/api/admin/stats'],
    ['GET', '/api/admin/users'],
    ['GET', '/api/admin/agents'],
    ['GET', '/api/admin/audit'],
    ['GET', '/api/admin/convs'],
  ];
  for (const [method, pathname] of deniedEndpoints) {
    const res = await http(method, pathname, { token: bob.access_token });
    eq(res.status, 403, `${method} ${pathname} 非管理员 → 403`);
  }
  const deniedCreate = await http('POST', '/api/admin/agents', {
    token: bob.access_token,
    body: { username: 'nope', display_name: 'nope' },
  });
  eq(deniedCreate.status, 403, '非管理员建 Agent → 403');

  const agentTokenTry = await http('POST', '/api/admin/users', {
    token: bob.access_token,
    body: { username: 'x', display_name: 'x', password: 'password123' },
  });
  eq(agentTokenTry.status, 403, '非管理员建账号 → 403');

  section('A3. 概览统计');
  const stats = await http('GET', '/api/admin/stats', { token: alice.access_token });
  eq(stats.status, 200, '管理员拿 stats → 200');
  eq(stats.body?.humans, 2, 'humans=2');
  eq(stats.body?.agents, 0, 'agents=0');
  eq(stats.body?.admins, 1, 'admins=1');
  ok(typeof stats.body?.messages === 'number', 'messages 是数字');

  section('A4. 账号管理：建号 / 停用 / 启用 / 授予管理员');
  const created = await http('POST', '/api/admin/users', {
    token: alice.access_token,
    body: { username: 'carol', display_name: '卡罗', password: 'carol-pass-123' },
  });
  eq(created.status, 201, '管理员建账号 → 201');
  eq(created.body?.is_admin, false, '新账号默认不是管理员');
  const carolId = created.body?.user?.id;

  // 卡罗能登录
  const carolLogin = await http('POST', '/api/auth/login', {
    body: { username: 'carol', password: 'carol-pass-123' },
  });
  eq(carolLogin.status, 200, '新账号可以登录');

  // 停用后用旧 token 也被挡
  const disabled = await http('POST', `/api/admin/users/${carolId}/disable`, {
    token: alice.access_token,
  });
  eq(disabled.status, 200, '停用账号 → 200');

  const carolAfterDisable = await http('POST', '/api/auth/login', {
    body: { username: 'carol', password: 'carol-pass-123' },
  });
  ok(carolAfterDisable.status >= 400, `停用后登录被拒（${carolAfterDisable.status}）`);

  const enabled = await http('POST', `/api/admin/users/${carolId}/enable`, {
    token: alice.access_token,
  });
  eq(enabled.status, 200, '启用账号 → 200');
  const carolLogin2 = await http('POST', '/api/auth/login', {
    body: { username: 'carol', password: 'carol-pass-123' },
  });
  eq(carolLogin2.status, 200, '启用后能重新登录');

  // 授予管理员 → 卡罗也能开管理页
  const granted = await http('POST', `/api/admin/users/${carolId}/admin`, {
    token: alice.access_token,
    body: { granted: true },
  });
  eq(granted.status, 200, '授予管理员 → 200');
  const carolStats = await http('GET', '/api/admin/stats', { token: carolLogin2.body.access_token });
  eq(carolStats.status, 200, '被授权的账号能访问管理接口');

  // 自我保护：不能撤销自己 / 不能停用自己
  const selfRevoke = await http('POST', `/api/admin/users/${carolId}/admin`, {
    token: carolLogin2.body.access_token,
    body: { granted: false },
  });
  eq(selfRevoke.status, 403, '不能撤销自己的管理员权限 → 403');

  const selfDisable = await http('POST', `/api/admin/users/${carolId}/disable`, {
    token: carolLogin2.body.access_token,
  });
  eq(selfDisable.status, 403, '不能停用自己 → 403');

  // 撤销卡罗的管理员，后面测"降级后立刻失去权限"
  const revoked = await http('POST', `/api/admin/users/${carolId}/admin`, {
    token: alice.access_token,
    body: { granted: false },
  });
  eq(revoked.status, 200, '撤销管理员 → 200');
  const carolStats2 = await http('GET', '/api/admin/stats', { token: carolLogin2.body.access_token });
  eq(carolStats2.status, 403, '撤销后立即失去管理权限（403）');

  section('A5. Agent 管理：建 / 轮换 token / 停用');
  const agentRes = await http('POST', '/api/admin/agents', {
    token: alice.access_token,
    body: { username: 'helper', display_name: '助手', model: 'test-model' },
  });
  eq(agentRes.status, 201, '建 Agent → 201');
  const agentId = agentRes.body?.agent?.id;
  const agentToken = agentRes.body?.token;
  ok(typeof agentToken === 'string' && agentToken.startsWith('ag_'), '返回 ag_ 开头的 token');

  const agentWs = new WsClient(wsUrl);
  await agentWs.connect();
  const agentAuth = await agentWs.request('auth', { token: agentToken });
  eq(agentAuth.ok, true, 'Agent 用新 token 能连上');

  const rotated = await http('POST', `/api/admin/agents/${agentId}/rotate-token`, {
    token: alice.access_token,
  });
  eq(rotated.status, 200, '轮换 token → 200');
  ok(rotated.body?.token !== agentToken, '新 token 与旧的不同');
  const closedByRotate = await agentWs.waitClose(5000);
  eq(closedByRotate.code, 1008, '轮换后旧连接被断开');

  const agentWs2 = new WsClient(wsUrl);
  await agentWs2.connect();
  expectOk(await agentWs2.request('auth', { token: rotated.body.token }), '新 token 可用');

  const agentDisabled = await http('POST', `/api/admin/agents/${agentId}/disable`, {
    token: alice.access_token,
  });
  eq(agentDisabled.status, 200, '停用 Agent → 200');
  const closedByDisable = await agentWs2.waitClose(5000);
  eq(closedByDisable.code, 1008, '停用后连接立即断开');

  const agentWs3 = new WsClient(wsUrl);
  await agentWs3.connect();
  const disabledAuth = await agentWs3.request('auth', { token: rotated.body.token });
  eq(disabledAuth.ok, false, '停用后不能再认证');
  agentWs3.close();

  await http('POST', `/api/admin/agents/${agentId}/enable`, { token: alice.access_token });
  const agentList = await http('GET', '/api/admin/users', { token: alice.access_token });
  const agentRow = (agentList.body?.agents ?? []).find((a) => a.id === agentId);
  eq(agentRow?.disabled, false, '重新启用后列表里不再标记停用');

  section('A6. 群组：跨群视角 + 成员管理（管理员不必是群成员）');
  const a = new WsClient(wsUrl);
  await a.connect();
  expectOk(await a.request('auth', { token: alice.access_token }), 'alice 连上');
  const conv = expectOk(
    await a.request('conv.create', { kind: 'group', title: '管理页测试群' }),
    'alice 建群（只有自己是成员）',
  ).conv;

  const convs = await http('GET', '/api/admin/convs', { token: alice.access_token });
  eq(convs.status, 200, '管理员能列全部会话');
  const row = (convs.body?.items ?? []).find((c) => c.id === conv.id);
  ok(row !== undefined, '新建的群出现在管理页列表里');
  eq(row.memberCount, 1, '成员数 1');

  // 拉 bob 进群（bob 不是管理员，也根本不在群里）
  const addMembers = await http('POST', `/api/admin/convs/${conv.id}/members`, {
    token: alice.access_token,
    body: { user_ids: [bob.user.id] },
  });
  eq(addMembers.status, 200, '管理员把 bob 拉进群 → 200');
  eq(addMembers.body?.added, 1, '实际加入 1 人');

  const members = await http('GET', `/api/admin/convs/${conv.id}/members`, {
    token: alice.access_token,
  });
  eq(members.status, 200, '管理页能读群成员');
  const bobRow = (members.body?.members ?? []).find((m) => m.user_id === bob.user.id);
  ok(bobRow !== undefined, 'bob 在成员列表里');
  eq(bobRow.role, 'member', 'bob 的群内角色是 member');

  // bob 现在能读这个群的消息（证明是真的进了群，不只是管理页的假象）
  const b = new WsClient(wsUrl);
  await b.connect();
  expectOk(await b.request('auth', { token: bob.access_token }), 'bob 连上');
  const bobConvGet = await b.request('conv.get', { conv_id: conv.id });
  eq(bobConvGet.ok, true, 'bob 客户端能 conv.get 这个群（真的进群了）');

  // 群主不能被移除
  const removeOwner = await http(
    'POST',
    `/api/admin/convs/${conv.id}/members/${alice.user.id}/remove`,
    { token: alice.access_token },
  );
  eq(removeOwner.status, 403, '不能通过管理页移除群主 → 403');

  const removeBob = await http(
    'POST',
    `/api/admin/convs/${conv.id}/members/${bob.user.id}/remove`,
    { token: alice.access_token },
  );
  eq(removeBob.status, 200, '移除 bob → 200');
  const bobAfter = await b.request('conv.get', { conv_id: conv.id });
  eq(bobAfter.ok, false, '移除后 bob 立刻读不到该群');

  section('A7. 审计日志：记录管理动作 + 可按动作/操作者筛');
  const audit = await http('GET', '/api/admin/audit?limit=200', { token: alice.access_token });
  eq(audit.status, 200, '读审计日志 → 200');
  const actions = (audit.body?.items ?? []).map((r) => r.action);
  for (const expected of [
    'user.create',
    'user.disable',
    'user.enable',
    'user.grant_admin',
    'user.revoke_admin',
    'agent.create',
    'agent.rotate_token',
    'agent.disable',
    'member.invite',
    'member.kick',
  ]) {
    includes(actions.join(','), expected, `审计里有 ${expected}`);
  }

  ok(Array.isArray(audit.body?.actions) && audit.body.actions.length > 0, '返回动作清单供筛选');

  const filtered = await http('GET', '/api/admin/audit?action=user.disable', {
    token: alice.access_token,
  });
  eq(filtered.status, 200, '按动作筛选 → 200');
  ok(
    (filtered.body?.items ?? []).every((r) => r.action === 'user.disable'),
    '筛选结果只含 user.disable',
  );

  const byActor = await http(
    'GET',
    `/api/admin/audit?actor_id=${encodeURIComponent(alice.user.id)}`,
    { token: alice.access_token },
  );
  eq(byActor.status, 200, '按操作者筛选 → 200');
  ok(
    (byActor.body?.items ?? []).length > 0,
    `alice 的操作有 ${(byActor.body?.items ?? []).length} 条`,
  );
  ok(
    (byActor.body?.items ?? []).every((r) => r.actor_id === alice.user.id),
    '筛选结果只含 alice 的操作',
  );

  section('B1. 页面产物与路由');
  const distIndex = `${repoRoot}/packages/web/dist/index.html`;
  const st = await stat(distIndex).catch(() => null);
  ok(st !== null, 'packages/web/dist/index.html 存在');

  const routerSrc = await readFile(`${repoRoot}/packages/web/src/lib/router.ts`, 'utf8');
  includes(routerSrc, "'/admin'", 'router 定义了 /admin 路由');
  for (const s of ['overview', 'users', 'agents', 'groups', 'audit']) {
    includes(routerSrc, `'${s}'`, `router 有 ${s} 分区`);
  }

  const pageSrc = await readFile(`${repoRoot}/packages/web/src/pages/AdminPage.tsx`, 'utf8');
  includes(pageSrc, '需要管理员权限', '页面有非管理员拒绝态');
  includes(pageSrc, '新建人类账号', '账号分区有建号表单');
  includes(pageSrc, '新建 Agent', 'Agent 分区有建号表单');
  includes(pageSrc, '轮换 token', 'Agent 分区有轮换入口');
  includes(pageSrc, '拉人进群', '群组分区有拉人入口');
  includes(pageSrc, '审计日志', '有审计分区');
  includes(pageSrc, 'api.setUserAdmin', '账号分区能授予/撤销管理员');

  const appSrc = await readFile(`${repoRoot}/packages/web/src/App.tsx`, 'utf8');
  // 架构：Web 只做管理后台，登录后直接渲染 AdminPage（聊天在桌面客户端）。
  includes(appSrc, 'AdminPage', 'App 渲染管理页');
  ok(!appSrc.includes('ChatWindow') && !appSrc.includes('ConversationList'),
     'App 不再引用聊天组件');
  includes(appSrc, 'isAdmin={isAdmin}', 'App 把管理员身份传给管理页');

  const oldPanel = await stat(`${repoRoot}/packages/web/src/components/AdminPanel.tsx`).catch(
    () => null,
  );
  eq(oldPanel, null, '旧的三标签弹窗已删除（被管理页取代）');

  const testSrc = await readFile(`${repoRoot}/packages/web/src/pages/AdminPage.test.tsx`, 'utf8');
  includes(testSrc, 'isAdmin={false}', '有非管理员的渲染测试');
  includes(testSrc, 'isAdmin', '有管理员的渲染测试');

  // 静态检查再怎么写也发现不了"点了没反应"——
  // 之前 App 把 section 写死成 'overview'，侧栏导航改 hash 但没人读，
  // 五个分区全部点不动，而上面所有 includes() 断言照样全绿。
  // 所以这里必须真开浏览器点一遍。
  section('B2. 真浏览器：五个分区真的能点（这条抓"点了没反应"）');
  // 管理页是相对路径请求 API 的，所以要让服务端把 dist/ 托管起来（同源），
  // 否则打开的是 404 页面，导航无从点起。
  const webDist = path.join(repoRoot, 'packages/web/dist');
  const distExists = await stat(path.join(webDist, 'index.html')).then(() => true).catch(() => false);
  ok(distExists, 'packages/web/dist/index.html 存在（先 pnpm --filter @agentlink/web build）');
  if (distExists) {
    const h = await ctx.restartServer({ PUBLIC_DIR: webDist });
    await checkNavigation(repoRoot, h.baseUrl, 'alice');
  }

  a.close();
  b.close();

  return summary('ui-admin');
}