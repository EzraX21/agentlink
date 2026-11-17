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

/** 上传一个文件。≤ 20 MiB（服务端限制，超了会回 PAYLOAD_TOO_LARGE）。 */
export async function uploadAttachment(file: File): Promise<UploadedAttachment> {
  const form = new FormData();
  form.append('file', file, file.name);

  const res = await fetch('/api/attachments', {
    method: 'POST',
    headers: authHeader(),
    body: form,
  });

  const text = await res.text();
  const json = text === '' ? null : (JSON.parse(text) as unknown);
  if (!res.ok) {
    const err = (json as { error?: { code?: string; message?: string } } | null)?.error;
    if (err?.code === 'PAYLOAD_TOO_LARGE') {
      throw new Error('文件超过 20 MiB，无法上传');
    }
    throw new Error(err?.message ?? `上传失败 (${res.status})`);
  }
  return json as UploadedAttachment;
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

async function fetchBlobUrl(attachmentId: string, filename: string): Promise<string> {
  // 服务端只用 :id 定位文件，:filename 仅用于 URL 可读性
  const path = `/api/attachments/${encodeURIComponent(attachmentId)}/${encodeURIComponent(
    filename || 'file',
  )}`;
  const res = await fetch(path, { headers: authHeader() });
  if (!res.ok) {
    throw new Error(`附件读取失败 (${res.status})`);
  }
  const blob = await res.blob();
  return URL.createObjectURL(blob);
}

/**
 * 取一个附件的 `blob:` URL（引用计数）。
 * 调用方必须在卸载时调 `releaseAttachmentUrl`，否则 blob 会一直占内存。
 */
export function acquireAttachmentUrl(attachmentId: string, filename: string): Promise<string> {
  const existing = cache.get(attachmentId);
  if (existing !== undefined) {
    existing.refs += 1;
    return existing.promise;
  }
  const entry: CacheEntry = {
    url: '',
    refs: 1,
    promise: fetchBlobUrl(attachmentId, filename).then((url) => {
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