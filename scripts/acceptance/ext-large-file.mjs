#!/usr/bin/env node
/**
 * ext-large-file 验收：解除附件大小上限（`MAX_ATTACHMENT_BYTES=0`）。
 *
 * 默认上限是 20 MiB（m7 验证它仍会拒绝 21 MiB）。这条套件用**放开上限**的
 * 服务端实例（`serverEnv = { MAX_ATTACHMENT_BYTES: '0' }`）验证：
 *   1. 25 MiB 能传上去（超过原来的硬上限）
 *   2. 内容是**流式落盘**的：sha256 与本地计算一致、字节数一致
 *   3. 能完整下载回来，字节逐段相同
 *   4. 内容寻址去重仍然生效（同内容第二次上传 deduped）
 *
 * 为什么单独一个套件而不是改 m7：m7 验的是"协议默认上限生效"，
 * 这条验的是"配置放开后能工作"，两者需要不同的服务端配置。
 */
import { createHash } from 'node:crypto';
import { section, summary, ok, eq, gte } from './_assert.mjs';
import { WsClient } from './_client.mjs';

export const needsServer = true;
export const relaxedRateLimit = true;
export const serverEnv = { MAX_ATTACHMENT_BYTES: '0' };

const SIZE = 25 * 1024 * 1024; // 25 MiB，超过默认的 20 MiB

export async function run(ctx) {
  const { http, wsUrl } = ctx;

  const reg = await http('POST', '/api/auth/register', {
    body: { username: 'alice', display_name: '爱丽丝', password: 'large-pass-123' },
  });
  if (reg.status !== 201) throw new Error(`注册失败: ${reg.text}`);
  const alice = reg.body;

  const ws = new WsClient(wsUrl);
  await ws.connect();
  await ws.request('auth', { token: alice.access_token });
  const conv = (await ws.request('conv.create', { kind: 'group', title: '大文件群' })).data.conv;

  section('1. 构造 25 MiB 文件并上传');
  // 用确定性伪随机内容，保证两边 sha256 可比
  const buf = Buffer.allocUnsafe(SIZE);
  let seed = 12345;
  for (let i = 0; i < SIZE; i += 1) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    buf[i] = seed & 0xff;
  }
  const expectedSha = createHash('sha256').update(buf).digest('hex');

  const form = new FormData();
  form.append('file', new Blob([buf], { type: 'application/octet-stream' }), 'big.bin');
  const t0 = Date.now();
  const up = await fetch(`${ctx.baseUrl}/api/attachments`, {
    method: 'POST',
    headers: { authorization: `Bearer ${alice.access_token}` },
    body: form,
  });
  const upMs = Date.now() - t0;
  eq(up.status, 201, `25 MiB 上传成功（${upMs}ms，超过原来 20 MiB 的硬上限）`);
  const upBody = await up.json();
  eq(upBody.size, SIZE, `返回的 size 与上传字节数一致（实际 ${upBody.size}，期望 ${SIZE}）`);
  eq(upBody.sha256, expectedSha, '服务端算出的 sha256 与本地一致（流式哈希正确）');
  eq(upBody.deduped, false, '首次上传不是去重');

  section('2. 引用后下载回来，内容完整');
  const sent = await ws.request('message.send', {
    conv_id: conv.id,
    client_msg_id: 'big-1',
    content: [
      {
        type: 'file',
        attachment_id: upBody.attachment_id,
        filename: 'big.bin',
        size: SIZE,
      },
    ],
  });
  eq(sent.ok, true, '把附件放进消息');

  const t1 = Date.now();
  const dl = await fetch(`${ctx.baseUrl}/api/attachments/${upBody.attachment_id}/big.bin`, {
    headers: { authorization: `Bearer ${alice.access_token}` },
  });
  eq(dl.status, 200, '下载 200');
  const got = Buffer.from(await dl.arrayBuffer());
  const dlMs = Date.now() - t1;
  eq(got.byteLength, SIZE, `下载字节数一致（${dlMs}ms）`);
  eq(
    createHash('sha256').update(got).digest('hex'),
    expectedSha,
    '下载内容的 sha256 与上传一致（没有截断/错位）',
  );
  gte(300, 0, `完整往返 ${upMs + dlMs}ms`);

  section('3. 内容寻址去重仍然生效');
  const form2 = new FormData();
  form2.append('file', new Blob([buf], { type: 'application/octet-stream' }), 'big-copy.bin');
  const up2 = await fetch(`${ctx.baseUrl}/api/attachments`, {
    method: 'POST',
    headers: { authorization: `Bearer ${alice.access_token}` },
    body: form2,
  });
  const up2Body = await up2.json();
  eq(up2Body.attachment_id, upBody.attachment_id, '相同内容复用同一个 attachment_id');
  eq(up2Body.deduped, true, 'deduped = true（没有在磁盘上写第二份）');

  section('4. 磁盘上只有一份');
  const { stat, readdir } = await import('node:fs/promises');
  const { resolve } = await import('node:path');
  const path = resolve(ctx.uploadsDir, upBody.sha256.slice(0, 2), upBody.sha256.slice(2, 4), upBody.sha256);
  const st = await stat(path).catch(() => null);
  ok(st !== null, '按内容寻址路径能找到文件');
  eq(st?.size, SIZE, '磁盘上的文件大小正确');
  // 临时目录应该被清空（流式落盘不能留垃圾）
  const tmpFiles = await readdir(resolve(ctx.uploadsDir, 'tmp')).catch(() => []);
  eq(tmpFiles.length, 0, 'tmp 目录没有残留临时文件');

  ws.close();
  return summary('ext-large-file');
}
