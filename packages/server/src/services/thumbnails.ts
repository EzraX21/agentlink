import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, stat, unlink } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

const execFileAsync = promisify(execFile);

/**
 * 视频缩略图（客户端体验项）。
 *
 * ## 为什么放服务端
 *
 * 客户端要显示缩略图，就得先拿到视频的第一帧。两种做法：
 *   - 客户端下载整个视频再抽帧 → 群里贴 20 段视频，进群就把 200 MB 拉一遍
 *   - 服务端在上传时抽一帧存成 JPEG → 客户端只拉几十 KB 的图
 *
 * 显然是后者。
 *
 * ## 为什么 ffmpeg 缺失时不报错
 *
 * ffmpeg 是**可选依赖**：镜像里没装就当"这个部署不提供缩略图"，
 * 客户端退回视频卡片（原来的样子）。不能因为缺一个可选工具就让整个上传失败。
 * 所以 `generateThumbnail` 失败一律吞掉，调用方拿不到缩略图而已。
 */

/** 缩略图最长边（像素）。 */
const THUMB_MAX_EDGE = 480;

/** 缩略图 JPEG 质量。 */
const THUMB_QUALITY = 4; // ffmpeg 的 -q:v 范围 2(最好)–31(最差)，4 足够清晰

/** 视频文件名后缀 → mime。与客户端的判定保持一致。 */
const VIDEO_EXTENSIONS = new Set([
  'mp4',
  'm4v',
  'webm',
  'mov',
  'ogv',
  'mkv',
  'avi',
  'mpeg',
  'mpg',
  '3gp',
]);

/** 是不是视频（按 mime 优先，其次按扩展名）。 */
export function isVideoFile(mime: string | undefined, filename: string | undefined): boolean {
  if (mime !== undefined && mime !== '') {
    if (mime.startsWith('video/')) return true;
  }
  if (filename === undefined || filename === '') return false;
  const ext = filename.toLowerCase().split('.').pop() ?? '';
  return VIDEO_EXTENSIONS.has(ext);
}

/** 缩略图的相对存储路径（按 sha256 分片，与附件本体同一套寻址方式）。 */
export function thumbnailRelPath(sha256: string): string {
  return joinPosix('thumbs', sha256.slice(0, 2), sha256.slice(2, 4), `${sha256}.jpg`);
}

function joinPosix(...parts: string[]): string {
  return parts.join('/');
}

let ffmpegAvailable: boolean | null = null;

/** ffmpeg 是否可用（结果缓存，避免每次上传都探一次盘）。 */
export async function hasFfmpeg(): Promise<boolean> {
  if (ffmpegAvailable !== null) return ffmpegAvailable;
  try {
    await execFileAsync('ffmpeg', ['-version'], { timeout: 5000 });
    ffmpegAvailable = true;
  } catch {
    ffmpegAvailable = false;
  }
  return ffmpegAvailable;
}

/**
 * 从视频里抽一帧存成 JPEG。
 *
 * 返回 true 表示缩略图已生成；false 表示**不影响主流程**的失败
 * （没有 ffmpeg、视频损坏、抽帧超时）。
 */
export async function generateVideoThumbnail(input: {
  /** 视频本体的绝对路径。 */
  sourcePath: string;
  /** 缩略图的绝对路径。 */
  destPath: string;
  /** 超时（毫秒）。 */
  timeoutMs?: number;
}): Promise<boolean> {
  if (!(await hasFfmpeg())) return false;

  await mkdir(dirname(input.destPath), { recursive: true });

  // `-ss 1` 放在 `-i` 之前：先跳再解码，快很多。
  // 1 秒处通常已经过了片头黑场；万一视频不到 1 秒，ffmpeg 会失败，
  // 那就退到第 0 帧。
  const attempts: string[][] = [
    ['-ss', '1', '-i', input.sourcePath],
    ['-ss', '0', '-i', input.sourcePath],
  ];

  for (const seek of attempts) {
    try {
      await execFileAsync(
        'ffmpeg',
        [
          ...seek,
          '-frames:v',
          '1',
          // 缩放到最长边 THUMB_MAX_EDGE，且保持原比例（-1 表示按比例算另一边）
          '-vf',
          `scale='if(gt(iw,ih),${THUMB_MAX_EDGE},-2)':'if(gt(iw,ih),-2,${THUMB_MAX_EDGE})'`,
          '-q:v',
          String(THUMB_QUALITY),
          '-y',
          input.destPath,
        ],
        { timeout: input.timeoutMs ?? 30_000 },
      );
      const st = await stat(input.destPath).catch(() => null);
      if (st !== null && st.size > 0) return true;
    } catch {
      // 试下一个 seek 位置
    }
  }

  await unlink(input.destPath).catch(() => undefined);
  return false;
}

/** 缩略图的绝对路径。 */
export function thumbnailAbsPath(uploadsDir: string, sha256: string): string {
  return resolve(uploadsDir, thumbnailRelPath(sha256));
}
