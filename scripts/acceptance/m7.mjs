#!/usr/bin/env node
/**
 * M7 验收：附件。
 *
 * 1. 上传 5 MiB png → 得到 attachment_id → 发消息引用 → 另一客户端能渲染
 * 2. 上传 21 MiB → 413
 * 3. 非群成员请求附件 URL → 403
 * 4. 相同文件上传两次 → 磁盘只存一份（sha256 去重）
 * 5. 未带 token 请求附件 → 401
 */
import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { section, summary, ok, eq, gt, includes, expectOk, expectError } from './_assert.mjs';
import { WsClient } from './_client.mjs';
import { openDb, count } from './_db.mjs';

export const needsServer = true;

async function mkUser(http, username, displayName) {
  const res = await http('POST', '/api/auth/register', {
    body: { username, display_name: displayName, password: 'test-password-123' },
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

/** 造一个可复现的"伪 png"（PNG 头 + 填充，5 MiB）。 */
function makePng(sizeBytes) {
  const header = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const body = Buffer.alloc(sizeBytes - header.length, 0x42);
  return Buffer.concat([header, body]);
}

async function upload(baseUrl, token, buf, filename, mime = 'image/png') {
  const form = new FormData();
  form.append('file', new Blob([buf], { type: mime }), filename);
  const res = await fetch(`${baseUrl}/api/attachments`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}` },
    body: form,
  });
  const text = await res.text();
  let json = null;
  try {
    json = text === '' ? null : JSON.parse(text);
  } catch {
    json = null;
  }
  return { status: res.status, body: json, text };
}

/** 磁盘上真实文件数（用于去重断言）。 */
async function countFiles(dir) {
  let n = 0;
  const entries = await readdir(dir, { recursive: true, withFileTypes: true }).catch(() => []);
  for (const e of entries) {
    if (e.isFile()) n += 1;
  }
  return n;
}

export async function run(ctx) {
  const { http, wsUrl, dbPath, uploadsDir, baseUrl } = ctx;

  const alice = await mkUser(http, 'alice', '爱丽丝');
  const bob = await mkUser(http, 'bob', '小明');
  const carol = await mkUser(http, 'carol', '卡罗');

  const a = await connect(wsUrl, alice.access_token);
  const b = await connect(wsUrl, bob.access_token);

  const conv = expectOk(
    await a.request('conv.create', { kind: 'group', title: '附件测试群', member_ids: [bob.user.id] }),
    '建群',
  ).conv;

  section('M7.1 上传 5 MiB png');
  const png = makePng(5 * 1024 * 1024);
  const up1 = await upload(baseUrl, alice.access_token, png, 'photo.png');
  eq(up1.status, 201, '上传返回 201');
  const att = up1.body;
  ok(typeof att?.attachment_id === 'string', '返回 attachment_id');
  ok(att.attachment_id.startsWith('a_'), 'attachment_id 形如 a_<ULID>');
  eq(att.size, png.byteLength, '返回的 size 与实际一致');
  eq(att.mime, 'image/png', 'mime 正确');
  ok(typeof att.sha256 === 'string' && att.sha256.length === 64, '返回 sha256');

  section('M7.2 发消息引用附件，另一客户端能拿到');
  const sent = expectOk(
    await a.request('message.send', {
      conv_id: conv.id,
      client_msg_id: 'att-msg-1',
      content: [
        { type: 'text', text: '看这个' },
        { type: 'image', attachment_id: att.attachment_id },
      ],
    }),
    '发带图片块的消息',
  );

  const evt = await b.nextEvent('message.new');
  const blocks = evt.data.message.content;
  eq(blocks.length, 2, '收到 2 个内容块');
  eq(blocks[1].type, 'image', '第二块是 image');
  eq(blocks[1].attachment_id, att.attachment_id, 'attachment_id 正确');

  // bob（成员）能下载
  const dl = await fetch(`${baseUrl}/api/attachments/${att.attachment_id}/photo.png`, {
    headers: { authorization: `Bearer ${bob.access_token}` },
  });
  eq(dl.status, 200, '成员下载附件 → 200');
  eq(dl.headers.get('content-type'), 'image/png', '下载的 content-type 正确');
  const downloaded = Buffer.from(await dl.arrayBuffer());
  eq(downloaded.byteLength, png.byteLength, '下载字节数一致');
  ok(downloaded.equals(png), '下载内容与上传字节流完全一致（逐字节比对）');

  section('M7.3 上传 21 MiB → 413');
  const big = makePng(21 * 1024 * 1024);
  const up2 = await upload(baseUrl, alice.access_token, big, 'huge.png');
  eq(up2.status, 413, '21 MiB 上传 → 413');
  eq(up2.body?.error?.code, 'PAYLOAD_TOO_LARGE', '错误码 PAYLOAD_TOO_LARGE');

  section('M7.4 非群成员请求附件 → 403');
  const carolDl = await fetch(`${baseUrl}/api/attachments/${att.attachment_id}/photo.png`, {
    headers: { authorization: `Bearer ${carol.access_token}` },
  });
  eq(carolDl.status, 403, '非成员下载 → 403');

  const noAuth = await fetch(`${baseUrl}/api/attachments/${att.attachment_id}/photo.png`);
  eq(noAuth.status, 401, '不带 token → 401');

  section('M7.5 相同文件上传两次 → 磁盘只存一份');
  const filesBefore = await countFiles(uploadsDir);
  const up3 = await upload(baseUrl, alice.access_token, png, 'photo-copy.png');
  eq(up3.status, 201, '同内容再传一次 → 201');
  eq(up3.body.attachment_id, att.attachment_id, '返回同一个 attachment_id（内容寻址）');
  eq(up3.body.deduped, true, 'deduped=true');
  const filesAfter = await countFiles(uploadsDir);
  eq(filesAfter, filesBefore, `磁盘文件数不变（${filesAfter}）`);

  const db = openDb(dbPath);
  eq(count(db, 'SELECT count(*) FROM attachments WHERE sha256 = ?', att.sha256), 1, '库里只有一条记录');

  const absFile = path.join(uploadsDir, att.sha256.slice(0, 2), att.sha256.slice(2, 4), att.sha256);
  const st = await stat(absFile).catch(() => null);
  ok(st !== null, '磁盘路径是 sha256 内容寻址（两级分片）');
  eq(st?.size, png.byteLength, '磁盘文件大小正确');

  section('M7.6 引用不存在的附件被拒');
  const badRef = await a.request('message.send', {
    conv_id: conv.id,
    client_msg_id: 'bad-att',
    content: [{ type: 'image', attachment_id: 'a_01M7JD0000000000000000000Z' }],
  });
  expectError(badRef, 'NOT_FOUND', '引用不存在的附件 → NOT_FOUND');

  section('M7.7 附件元信息接口');
  const meta = await http('GET', `/api/attachments/${att.attachment_id}`, {
    token: bob.access_token,
  });
  eq(meta.status, 200, '元信息接口 200');
  eq(meta.body?.filename, 'photo.png', '文件名正确');
  eq(meta.body?.size, png.byteLength, '大小正确');

  db.close();
  a.close();
  b.close();

  return summary('M7');
}