/**
 * 附件：上传与带鉴权的读取。
 *
 * ## 为什么不能直接用 <img src="/api/attachments/...">
 *
 * 附件下载要求 `Authorization: Bearer <token>`（施工守则 §8：附件下载要校验身份），
 * 而 `<img>` 标签**无法发送自定义请求头**。三条路都不能走：
 *   - 把 token 放 URL 查询串 → 明确禁止（会进反向代理访问日志，协议 §2.4）
 *   - 改成 Cookie 认证 → 等于新增一套会话机制，超出必要范围
 *   - 放宽下载鉴权 → 直接违反施工守则
 *
 * 所以用 `fetch` 带 header 取回字节，转成 `blob:` URL 交给 `<img>`。
 * 同一个附件只取一次，模块级缓存 + 引用计数，组件卸载时释放。
 */

import { apiUrl } from './endpoint.js';

const TOKEN_KEY = 'agentlink.access_token';

function authHeader(): Record<string, string> {
  const token = localStorage.getItem(TOKEN_KEY);
  return token === null ? {} : { authorization: `Bearer ${token}` };
}

export interface UploadedAttachment {
  attachment_id: string;
  filename: string;
  mime: string;
  size: number;
  sha256: string;
  deduped: boolean;
}

export interface UploadProgress {
  /** 已上传字节。 */
  loaded: number;
  /** 总字节（浏览器未必知道，可能是 0）。 */
  total: number;
  /** 0–100；total 未知时为 null（UI 显示不确定进度）。 */
  percent: number | null;
}

/**
 * 上传一个文件。≤ 20 MiB（服务端限制，超了会回 PAYLOAD_TOO_LARGE）。
 *
 * 用 XHR 而不是 fetch：**fetch 无法报告上传进度**（只有下载流可读），
 * 而"传 20 MiB 文件时一点反馈都没有"是明显的体验缺陷。
 * XHR 的 `upload.onprogress` 能给出已发送字节。
 */
export function uploadAttachment(
  file: File,
  opts: { onProgress?: (p: UploadProgress) => void; signal?: AbortSignal } = {},
): Promise<UploadedAttachment> {
  return new Promise<UploadedAttachment>((resolve, reject) => {
    const form = new FormData();
    form.append('file', file, file.name);

    const xhr = new XMLHttpRequest();
    xhr.open('POST', apiUrl('/api/attachments'));
    const auth = authHeader();
    if (auth.authorization !== undefined) xhr.setRequestHeader('authorization', auth.authorization);
    xhr.responseType = 'text';

    xhr.upload.onprogress = (e: ProgressEvent): void => {
      if (opts.onProgress === undefined) return;
      const total = e.lengthComputable ? e.total : file.size;
      opts.onProgress({
        loaded: e.loaded,
        total,
        percent: total > 0 ? Math.min(100, Math.round((e.loaded / total) * 100)) : null,
      });
    };

    xhr.onerror = () => reject(new Error('上传失败（网络错误）'));
    xhr.onabort = () => reject(new Error('上传已取消'));
    xhr.onload = () => {
      let json: unknown = null;
      try {
        json = xhr.responseText === '' ? null : JSON.parse(xhr.responseText);
      } catch {
        json = null;
      }
      if (xhr.status < 200 || xhr.status >= 300) {
        const err = (json as { error?: { code?: string; message?: string } } | null)?.error;
        if (err?.code === 'PAYLOAD_TOO_LARGE') {
          reject(new Error('文件超过 20 MiB，无法上传'));
          return;
        }
        reject(new Error(err?.message ?? `上传失败 (${xhr.status})`));
        return;
      }
      resolve(json as UploadedAttachment);
    };

    if (opts.signal !== undefined) {
      opts.signal.addEventListener('abort', () => xhr.abort(), { once: true });
    }

    xhr.send(form);
  });
}

// ---------------------------------------------------------------------------
// 带鉴权的字节读取 + blob 缓存
// ---------------------------------------------------------------------------

interface CacheEntry {
  url: string;
  refs: number;
  promise: Promise<string>;
}

const cache = new Map<string, CacheEntry>();

function attachmentPath(attachmentId: string, filename: string): string {
  // 服务端只用 :id 定位文件，:filename 仅用于 URL 可读性
  return `/api/attachments/${encodeURIComponent(attachmentId)}/${encodeURIComponent(
    filename || 'file',
  )}`;
}

/** 带鉴权取回附件字节。用 XHR 是因为 fetch 无法报告**下载**进度。 */
function fetchAttachmentBlob(
  attachmentId: string,
  filename: string,
  onProgress?: (percent: number | null) => void,
  signal?: AbortSignal,
): Promise<Blob> {
  return new Promise<Blob>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('GET', apiUrl(attachmentPath(attachmentId, filename)));
    const auth = authHeader();
    if (auth.authorization !== undefined) xhr.setRequestHeader('authorization', auth.authorization);
    xhr.responseType = 'blob';

    xhr.onprogress = (e: ProgressEvent): void => {
      if (onProgress === undefined) return;
      onProgress(
        e.lengthComputable && e.total > 0 ? Math.min(100, Math.round((e.loaded / e.total) * 100)) : null,
      );
    };
    xhr.onerror = () => reject(new Error('附件读取失败（网络错误）'));
    xhr.onabort = () => reject(new Error('下载已取消'));
    xhr.onload = () => {
      if (xhr.status < 200 || xhr.status >= 300) {
        reject(new Error(`附件读取失败 (${xhr.status})`));
        return;
      }
      onProgress?.(100);
      resolve(xhr.response as Blob);
    };

    if (signal !== undefined) signal.addEventListener('abort', () => xhr.abort(), { once: true });
    xhr.send();
  });
}

/**
 * 下载附件并触发浏览器保存（用于文件卡片）。
 *
 * 不用 `<a href="/api/attachments/...">` 的原因：附件要 `Authorization` 头，
 * 而普通链接带不了（同 `ImageBlockView` 的说明）。所以先带鉴权取字节，
 * 再用临时 `<a download>` 交给浏览器保存。
 */
export async function downloadAttachment(
  attachmentId: string,
  filename: string,
  opts: { onProgress?: (percent: number | null) => void; signal?: AbortSignal } = {},
): Promise<void> {
  const blob = await fetchAttachmentBlob(attachmentId, filename, opts.onProgress, opts.signal);
  const url = URL.createObjectURL(blob);
  try {
    const a = document.createElement('a');
    a.href = url;
    a.download = filename || 'file';
    document.body.appendChild(a);
    a.click();
    a.remove();
  } finally {
    // 交给浏览器读取需要一点时间，延迟回收
    window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
  }
}

/**
 * 取一个附件的 `blob:` URL（引用计数）。
 * 调用方必须在卸载时调 `releaseAttachmentUrl`，否则 blob 会一直占内存。
 */
export function acquireAttachmentUrl(
  attachmentId: string,
  filename: string,
  onProgress?: (percent: number | null) => void,
): Promise<string> {
  const existing = cache.get(attachmentId);
  if (existing !== undefined) {
    existing.refs += 1;
    return existing.promise;
  }
  const entry: CacheEntry = {
    url: '',
    refs: 1,
    // 命中缓存时没有进度可报（已经下载完了），直接给 100 更诚实
    promise: fetchAttachmentBlob(attachmentId, filename, onProgress).then((blob) => {
      const url = URL.createObjectURL(blob);
      entry.url = url;
      return url;
    }),
  };
  cache.set(attachmentId, entry);
  // 失败时不要留坏缓存，否则重试永远失败
  entry.promise.catch(() => {
    cache.delete(attachmentId);
  });
  return entry.promise;
}

export function releaseAttachmentUrl(attachmentId: string): void {
  const entry = cache.get(attachmentId);
  if (entry === undefined) return;
  entry.refs -= 1;
  if (entry.refs > 0) return;
  cache.delete(attachmentId);
  if (entry.url !== '') URL.revokeObjectURL(entry.url);
}

// ---------------------------------------------------------------------------
// 视频缩略图
// ---------------------------------------------------------------------------

/**
 * 缩略图的 URL（不缓存成 blob）。
 *
 * 与本体不同：缩略图是**服务端生成的小 JPEG**，几十 KB，
 * 直接让 `<img src>` 去请求就行 —— 但仍要带鉴权头，而 `<img>` 带不了自定义头。
 *
 * 所以走 blob：先用 fetch 取字节，再给 `<img>`。用 fetch 而不是 XHR 是因为
 * 缩略图很小，不值得为进度上报开 XHR。
 */
export async function fetchAttachmentThumbnail(attachmentId: string): Promise<string | null> {
  const res = await fetch(apiUrl(`/api/attachments/${encodeURIComponent(attachmentId)}/thumbnail`), {
    headers: authHeader(),
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`缩略图读取失败 (${res.status})`);
  const blob = await res.blob();
  return URL.createObjectURL(blob);
}

/** 让人读的大小：1.2 MB / 340 KB / 12 B。 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
  if (bytes < 1024 * 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} MB`;
  }
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

/** 是不是可以直接当图片显示（用于决定用 <img> 还是文件卡片）。 */
export function isImageMime(mime: string): boolean {
  return /^image\/(png|jpe?g|gif|webp|avif|bmp|svg\+xml)$/i.test(mime);
}

/** 从文件名猜 MIME（服务端也会猜，这里用于"上传前"决定用 image 还是 file 块）。 */
export function guessMimeFromName(name: string): string {
  const ext = name.toLowerCase().split('.').pop() ?? '';
  const map: Record<string, string> = {
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    webp: 'image/webp',
    avif: 'image/avif',
    bmp: 'image/bmp',
    svg: 'image/svg+xml',
  };
  return map[ext] ?? 'application/octet-stream';
}