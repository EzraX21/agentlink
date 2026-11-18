#!/usr/bin/env node
/**
 * video-thumb 验收：视频附件缩略图。
 *
 * 服务端在**上传时**用 ffmpeg 抽一帧存成 JPEG，客户端列表里显示缩略图而不是黑框。
 *
 * 这条套件验四件事：
 *   1. 上传一个真视频（ffmpeg 现场生成的 mp4）→ 缩略图端点返回 JPEG
 *   2. 缩略图是**合法 JPEG**（SOI 魔数 + ffmpeg 能解出尺寸），不是空文件
 *   3. 缩略图比视频本体小得多（不然就没意义了）
 *   4. 权限与本体一致：非群成员拿缩略图 → 403
 *   5. 非视频附件没有缩略图 → 404
 *
 * 注意：ffmpeg 缺失时服务端会**跳过**缩略图生成（这是设计好的降级），
 * 所以这条套件在没装 ffmpeg 的环境里必须**跳过**而不是红。
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { section, summary, ok, eq, gt, lte } from './_assert.mjs';
import { WsClient } from './_client.mjs';

const execFileAsync = promisify(execFile);

export const needsServer = true;
export const relaxedRateLimit = true;

async function hasFfmpeg() {
  try {
    await execFileAsync('ffmpeg', ['-version'], { timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

/** 用 ffmpeg 造一段测试视频。 */
async function makeTestVideo(dir) {
  const out = path.join(dir, 'clip.mp4');
  await execFileAsync(
    'ffmpeg',
    [
      '-f',
      'lavfi',
      '-i',
      // 6 秒 640x480。叠一层噪声：纯 testsrc 是合成图案，H.264 压得极狠
      // （6 秒才 35 KB），拿它比"缩略图比视频小"没有说服力 ——
      // 真实视频是几 MB 起步。加噪声后体积才接近真实。
      'testsrc=duration=6:size=640x480:rate=25',
      '-f',
      'lavfi',
      '-i',
      'nullsrc=duration=6:size=640x480:rate=25,geq=random(1)*255:128:128',
      '-filter_complex',
      '[0:v][1:v]blend=all_mode=overlay:all_opacity=0.12',
      '-pix_fmt',
      'yuv420p',
      '-y',
      out,
    ],
    { timeout: 120_000 },
  );
  return out;
}

export async function run(ctx) {
  const { http, wsUrl, baseUrl } = ctx;

  section('0. 环境：ffmpeg');
  if (!(await hasFfmpeg())) {
    console.log('  \x1b[33m- 跳过：这台机器没有 ffmpeg，服务端会按设计不生成缩略图\x1b[0m');
    return;
  }
  ok(true, 'ffmpeg 可用');

  const dir = await mkdtemp(path.join(os.tmpdir(), 'agentlink-thumb-'));
  try {
    const reg = await http('POST', '/api/auth/register', {
      body: { username: 'alice', display_name: '爱丽丝', password: 'large-pass-123' },
    });
    if (reg.status !== 201) throw new Error(`注册失败: ${reg.text}`);
    const alice = reg.body;

    const reg2 = await http('POST', '/api/auth/register', {
      body: { username: 'bob', display_name: '鲍勃', password: 'large-pass-123' },
    });
    if (reg2.status !== 201) throw new Error(`注册失败: ${reg.text}`);
    const bob = reg2.body;

    const ws = new WsClient(wsUrl);
    await ws.connect();
    await ws.request('auth', { token: alice.access_token });
    const conv = (await ws.request('conv.create', { kind: 'group', title: '视频群' })).data.conv;

    section('1. 上传真视频，服务端抽帧');
    const videoPath = await makeTestVideo(dir);
    const videoBytes = await readFile(videoPath);
    const form = new FormData();
    form.append('file', new Blob([videoBytes], { type: 'video/mp4' }), 'clip.mp4');
    const up = await fetch(`${baseUrl}/api/attachments`, {
      method: 'POST',
      headers: { authorization: `Bearer ${alice.access_token}` },
      body: form,
    });
    eq(up.status, 201, '视频上传成功');
    const upBody = await up.json();
    eq(upBody.mime, 'video/mp4', 'mime 认成 video/mp4');
    gt(upBody.size, 0, `视频大小 ${upBody.size} 字节`);

    section('2. 缩略图端点返回合法 JPEG');
    const thumbRes = await fetch(`${baseUrl}/api/attachments/${upBody.attachment_id}/thumbnail`, {
      headers: { authorization: `Bearer ${alice.access_token}` },
    });
    eq(thumbRes.status, 200, '缩略图可取');
    eq(thumbRes.headers.get('content-type'), 'image/jpeg', 'content-type 是 image/jpeg');

    const thumbBytes = Buffer.from(await thumbRes.arrayBuffer());
    gt(thumbBytes.length, 0, `缩略图非空（${thumbBytes.length} 字节）`);
    // JPEG SOI 魔数 FFD8
    eq(thumbBytes[0], 0xff, 'JPEG 魔数第 1 字节是 0xFF');
    eq(thumbBytes[1], 0xd8, 'JPEG 魔数第 2 字节是 0xD8');
    eq(thumbBytes[thumbBytes.length - 2], 0xff, 'JPEG 尾标记 0xFF 存在');
    eq(thumbBytes[thumbBytes.length - 1], 0xd9, 'JPEG 尾标记 0xD9 存在');

    section('3. 缩略图能被解码，尺寸被缩到最长边 480 以内');
    // ffprobe 从**文件**读（不接管道）：execFile 没有 stdin，
    // 只有 execFileSync 支持 input 选项。所以先落个临时文件。
    const thumbPath = path.join(dir, 'thumb.jpg');
    await writeFile(thumbPath, thumbBytes);
    const probe = await execFileAsync('ffprobe', [
      '-v',
      'error',
      '-select_streams',
      'v:0',
      '-show_entries',
      'stream=width,height',
      '-of',
      'csv=p=0',
      '-i',
      thumbPath,
    ], { timeout: 15_000 }).catch((e) => ({ stdout: '', stderr: String(e) }));
    const dims = String(probe.stdout).trim().split(',').map((x) => Number(x));
    const [tw, th] = dims;
    ok(
      Number.isFinite(tw) && Number.isFinite(th) && tw > 0 && th > 0,
      `ffprobe 能解出缩略图尺寸（${probe.stdout.trim() || '无'}）`,
    );
    lte(Math.max(tw, th), 480, `缩略图最长边 ≤ 480（实际 ${Math.max(tw, th)}）`);

    section('4. 缩略图比视频本体小得多');
    ok(
      thumbBytes.length < videoBytes.length / 4,
      `缩略图 ${thumbBytes.length} B << 视频 ${videoBytes.length} B（至少小 4 倍）`,
    );
    // 缩略图是**单帧 JPEG**，体积与视频时长无关 —— 这是"客户端不用下整个视频"的关键
    lte(thumbBytes.length, 200 * 1024, `缩略图不超过 200 KB（实际 ${thumbBytes.length} B）`);

    section('5. 权限：非群成员拿不到缩略图');
    const bobRes = await fetch(`${baseUrl}/api/attachments/${upBody.attachment_id}/thumbnail`, {
      headers: { authorization: `Bearer ${bob.access_token}` },
    });
    eq(bobRes.status, 403, '非成员 → 403（与本体下载一致）');

    section('6. 不带 token → 401');
    const anon = await fetch(`${baseUrl}/api/attachments/${upBody.attachment_id}/thumbnail`);
    eq(anon.status, 401, '匿名 → 401');

    section('7. 非视频附件没有缩略图 → 404');
    const binForm = new FormData();
    binForm.append('file', new Blob([Buffer.from('hello world')], { type: 'text/plain' }), 'note.txt');
    const binUp = await fetch(`${baseUrl}/api/attachments`, {
      method: 'POST',
      headers: { authorization: `Bearer ${alice.access_token}` },
      body: binForm,
    });
    eq(binUp.status, 201, '文本文件上传成功');
    const binBody = await binUp.json();
    const binThumb = await fetch(`${baseUrl}/api/attachments/${binBody.attachment_id}/thumbnail`, {
      headers: { authorization: `Bearer ${alice.access_token}` },
    });
    eq(binThumb.status, 404, '文本文件没有缩略图 → 404');

    section('8. 同一个视频重复上传（去重）仍然有缩略图');
    const form2 = new FormData();
    form2.append('file', new Blob([videoBytes], { type: 'video/mp4' }), 'clip.mp4');
    const up2 = await fetch(`${baseUrl}/api/attachments`, {
      method: 'POST',
      headers: { authorization: `Bearer ${alice.access_token}` },
      body: form2,
    });
    eq(up2.status, 201, '重复上传成功');
    const up2Body = await up2.json();
    eq(up2Body.deduped, true, '内容寻址命中去重');
    const thumb2 = await fetch(`${baseUrl}/api/attachments/${up2Body.attachment_id}/thumbnail`, {
      headers: { authorization: `Bearer ${alice.access_token}` },
    });
    eq(thumb2.status, 200, '去重后的同一个附件也有缩略图');
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}
