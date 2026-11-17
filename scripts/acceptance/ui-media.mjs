#!/usr/bin/env node
/**
 * ui-media 验收：附件 UI + 搜索 UI（对齐 TG 客户端的第一批）
 *
 * 这一批都是"客户端能直接做、不需要改协议"的功能：
 *   1. 附件：上传 → 发 image/file 块 → 另一个客户端能取到字节；UI 真渲染 <img>
 *   2. 搜索：HTTP 控制面 GET /api/search（协议 §1 把搜索归在控制面）
 *   3. 安全：excerpt 里的 HTML 不会被当标记执行（XSS）
 *   4. 静态：搜索框/附件按钮已启用，不再是 disabled
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { section, summary, ok, eq, gte, includes, expectOk } from './_assert.mjs';
import { WsClient } from './_client.mjs';

const exec = promisify(execFile);

export const needsServer = true;
export const relaxedRateLimit = true;

async function mkUser(http, username, displayName) {
  const res = await http('POST', '/api/auth/register', {
    body: { username, display_name: displayName, password: 'media-test-pass-123' },
  });
  if (res.status !== 201) throw new Error(`注册 ${username} 失败: ${res.status} ${res.text}`);
  return res.body;
}

async function connect(wsUrl, token) {
  const c = new WsClient(wsUrl);
  await c.connect();
  const res = await c.request('auth', { token });
  if (!res.ok) throw new Error(`auth 失败: ${JSON.stringify(res.error)}`);
  return c;
}

function makePng(size) {
  const header = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return Buffer.concat([header, Buffer.alloc(Math.max(0, size - header.length), 0x37)]);
}

async function upload(baseUrl, token, buf, filename, mime) {
  const form = new FormData();
  form.append('file', new Blob([buf], { type: mime }), filename);
  const res = await fetch(`${baseUrl}/api/attachments`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}` },
    body: form,
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

export async function run(ctx) {
  const { http, wsUrl, repoRoot, baseUrl } = ctx;

  const alice = await mkUser(http, 'alice', '爱丽丝');
  const bob = await mkUser(http, 'bob', '小明');
  const a = await connect(wsUrl, alice.access_token);
  const b = await connect(wsUrl, bob.access_token);

  const conv = expectOk(
    await a.request('conv.create', { kind: 'group', title: '媒体测试群', member_ids: [bob.user.id] }),
    '建群',
  ).conv;

  section('1. 图片附件：上传 → image 块 → 对端能取到字节');
  const png = makePng(64 * 1024);
  const up = await upload(baseUrl, alice.access_token, png, 'shot.png', 'image/png');
  eq(up.status, 201, '上传 png → 201');
  const attId = up.body.attachment_id;

  expectOk(
    await a.request('message.send', {
      conv_id: conv.id,
      client_msg_id: 'img-1',
      content: [{ type: 'text', text: '看图' }, { type: 'image', attachment_id: attId }],
    }),
    '发含 image 块的消息',
  );

  const evt = await b.nextEvent('message.new');
  const imgBlock = evt.data.message.content.find((x) => x.type === 'image');
  ok(imgBlock !== undefined, '对端收到 image 块');
  eq(imgBlock.attachment_id, attId, 'attachment_id 一致');

  // 客户端渲染 <img> 的方式：带 Authorization 头取字节（不能用 <img src>，见 lib/attachments.ts）
  const dl = await fetch(`${baseUrl}/api/attachments/${attId}/shot.png`, {
    headers: { authorization: `Bearer ${bob.access_token}` },
  });
  eq(dl.status, 200, '对端带 token 取附件 → 200');
  const bytes = Buffer.from(await dl.arrayBuffer());
  ok(bytes.equals(png), `取回的字节与上传一致（${bytes.length} 字节）`);
  includes(dl.headers.get('content-type') ?? '', 'image/png', 'content-type 是 image/png');

  section('2. 文件附件：file 块带 filename/size，UI 能直接展示');
  const pdf = Buffer.alloc(3000, 0x50);
  const up2 = await upload(baseUrl, alice.access_token, pdf, 'report.pdf', 'application/pdf');
  eq(up2.status, 201, '上传 pdf → 201');
  eq(up2.body.filename, 'report.pdf', '服务端保留文件名');
  eq(up2.body.size, 3000, 'size 正确');

  expectOk(
    await a.request('message.send', {
      conv_id: conv.id,
      client_msg_id: 'file-1',
      content: [
        {
          type: 'file',
          attachment_id: up2.body.attachment_id,
          filename: 'report.pdf',
          size: 3000,
        },
      ],
    }),
    '发含 file 块的消息',
  );
  const fileEvt = await b.nextEvent(
    (e) => e.type === 'message.new' && e.data?.message?.content?.[0]?.type === 'file',
  );
  eq(fileEvt.data.message.content[0].filename, 'report.pdf', 'file 块保留 filename');
  eq(fileEvt.data.message.content[0].size, 3000, 'file 块保留 size');

  section('3. 搜索：HTTP 控制面 GET /api/search');
  expectOk(
    await a.request('message.send', {
      conv_id: conv.id,
      client_msg_id: 's-1',
      content: [{ type: 'text', text: '周报什么时候交？' }],
    }),
    '发一条可被搜到的消息',
  );
  await new Promise((r) => setTimeout(r, 100));

  const search = await http('GET', '/api/search?q=%E5%91%A8%E6%8A%A5', {
    token: alice.access_token,
  });
  eq(search.status, 200, 'GET /api/search → 200');
  gte(search.body?.hits?.length ?? 0, 1, `命中 ${search.body?.hits?.length ?? 0} 条`);
  ok(
    (search.body?.hits ?? []).every((h) => typeof h.excerpt === 'string'),
    '每条命中都带 excerpt',
  );
  includes(search.body.hits[0].excerpt, '<mark>', 'excerpt 含 <mark> 高亮');

  // excerpt 不能把正文重复一遍（曾经的真实 bug：前缀长度写死 40）
  expectOk(
    await a.request('message.send', {
      conv_id: conv.id,
      client_msg_id: 'dup-excerpt',
      content: [{ type: 'text', text: '这个群是演示数据，随便发消息试试' }],
    }),
    '发一条短消息验证 excerpt 拼接',
  );
  await new Promise((r) => setTimeout(r, 100));
  const dupSearch = await http('GET', '/api/search?q=%E6%BC%94%E7%A4%BA', {
    token: alice.access_token,
  });
  const dupHit = (dupHitFind(dupSearch.body?.hits ?? []) ?? {});
  function dupHitFind(hits) {
    return hits.find((h) => h.excerpt.includes('随便发消息'));
  }
  eq(
    dupHit.excerpt,
    '这个群是<mark>演示</mark>数据，随便发消息试试',
    'excerpt 精确匹配：前缀截到命中点，不重复正文',
  );

  // 空查询被拒
  const emptyQ = await http('GET', '/api/search?q=', { token: alice.access_token });
  eq(emptyQ.status, 400, '空查询 → 400');

  // 不可见会话搜不到（carol 建群，alice 不是成员）
  const carol = await mkUser(http, 'carol', '卡罗');
  const c = await connect(wsUrl, carol.access_token);
  const carolConv = expectOk(
    await c.request('conv.create', { kind: 'group', title: '卡罗的秘密群' }),
    'carol 建自己的群',
  ).conv;
  expectOk(
    await c.request('message.send', {
      conv_id: carolConv.id,
      client_msg_id: 'secret-1',
      content: [{ type: 'text', text: '周报是我的秘密' }],
    }),
    'carol 在私密群发含关键词的消息',
  );
  await new Promise((r) => setTimeout(r, 100));

  const aliceSearch = await http('GET', '/api/search?q=%E5%91%A8%E6%8A%A5', {
    token: alice.access_token,
  });
  ok(
    !(aliceSearch.body?.hits ?? []).some((h) => h.conv_id === carolConv.id),
    '搜不到别人的群（可见性在服务端强制）',
  );

  section('4. XSS：excerpt 不得被当成 HTML');
  // 发一条消息，正文就是一个标签
  expectOk(
    await a.request('message.send', {
      conv_id: conv.id,
      client_msg_id: 'xss-1',
      content: [{ type: 'text', text: '<img src=x onerror=alert(1)> 周报' }],
    }),
    '发一条含 HTML 的消息',
  );
  await new Promise((r) => setTimeout(r, 100));
  const xssSearch = await http('GET', '/api/search?q=%E5%91%A8%E6%8A%A5', {
    token: alice.token ?? alice.access_token,
  });
  const xssHit = (xssSearch.body?.hits ?? []).find((h) =>
    h.excerpt.includes('onerror'),
  );
  ok(xssHit !== undefined, '服务端原样返回 excerpt（含未转义标签）');
  // 服务端不转义是有意的：客户端按 <mark> 分段渲染，其余一律当纯文本
  const searchPanelSrc = await readFile(
    `${repoRoot}/packages/web/src/components/SearchPanel.tsx`,
    'utf8',
  );
  // 注意：注释里会提到这个 API 的名字（解释为什么不用），所以只检查真正的 JSX 用法
  ok(
    !/dangerouslySetInnerHTML\s*=/.test(searchPanelSrc),
    'SearchPanel 没有 dangerouslySetInnerHTML 的 JSX 用法（否则就是 XSS）',
  );
  includes(searchPanelSrc, '<mark>', 'SearchPanel 按 <mark> 切分渲染');

  section('5. 前端产物：搜索框与附件按钮已不再是 disabled');
  const convListSrc = await readFile(
    `${repoRoot}/packages/web/src/components/ConversationList.tsx`,
    'utf8',
  );
  ok(!/placeholder="搜索消息"[\s\S]{0,120}disabled/.test(convListSrc), '搜索框已启用');
  includes(convListSrc, 'onOpenSearch', '搜索框点击打开搜索面板');

  const chatSrc = await readFile(`${repoRoot}/packages/web/src/components/ChatWindow.tsx`, 'utf8');
  ok(!/title="附件[^"]*"\s*\n?\s*disabled/.test(chatSrc), '附件按钮已启用');
  includes(chatSrc, 'type="file"', '有文件选择器');
  includes(chatSrc, 'onPaste', '支持粘贴上传');
  includes(chatSrc, 'onDrop', '支持拖拽上传');

  const bubbleSrc = await readFile(
    `${repoRoot}/packages/web/src/components/MessageBubble.tsx`,
    'utf8',
  );
  includes(bubbleSrc, 'ImageBlockView', '消息气泡渲染图片块');
  includes(bubbleSrc, 'FileBlockView', '消息气泡渲染文件块');
  ok(!bubbleSrc.includes('`[${b.type}]`'), '不再把图片/文件渲染成 [image]/[file] 文字');

  const dist = await stat(`${repoRoot}/packages/web/dist/index.html`).catch(() => null);
  ok(dist !== null, 'web 构建产物存在');

  section('6. web 单测（含 XSS 与附件渲染）');
  const vitest = path.join(repoRoot, 'packages/web/node_modules/.bin/vitest');
  const { stdout } = await exec(vitest, ['run', '--reporter=dot'], {
    cwd: path.join(repoRoot, 'packages/web'),
    timeout: 120_000,
  });
  const plain = stdout.replace(/\u001b\[[0-9;]*m/g, '');
  const passed = /Tests\s+(\d+) passed/.exec(plain);
  ok(!/failed/.test(plain), 'web 单测无失败');
  gte(Number(passed?.[1] ?? 0), 20, `web 单测通过 ${passed?.[1] ?? '?'} 项（≥20）`);

  a.close();
  b.close();
  c.close();

  return summary('ui-media');
}