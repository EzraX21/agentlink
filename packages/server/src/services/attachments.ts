import { createHash } from 'node:crypto';
import { mkdir, writeFile, readFile, rename, rm, stat, unlink } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { AgentLinkError, type Content } from '@agentlink/protocol';
import type { Db } from '../db/index.js';
import {
  findAttachment,
  findAttachmentBySha,
  insertAttachment,
  isMember,
  listConvsReferencingAttachment,
} from '../db/queries.js';
import type { AttachmentRow } from '../db/schema.js';
import { newAttachmentId, nowMs } from '../ids.js';
import { generateVideoThumbnail, isVideoFile, thumbnailAbsPath } from './thumbnails.js';

/**
 * 附件（实现计划 M7）。
 *
 * 硬性要求：
 *   - 上传 ≤ 20 MiB，超限 413
 *   - 按 sha256 **内容寻址**落盘：同一文件传两次，磁盘只存一份
 *   - 下载要鉴权 + **群成员校验**（施工守则 §8：附件下载校验群成员身份）
 */

/**
 * 默认上限 20 MiB（需求确认书）。真正生效的值来自 config.maxAttachmentBytes，
 * 这个常量只作为默认值与文档锚点保留。
 * `0` 表示不限制（此时磁盘就是上限）。
 */
export const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;

export interface StoredAttachment {
  readonly attachmentId: string;
  readonly filename: string;
  readonly mime: string;
  readonly size: number;
  readonly sha256: string;
  /** 是否命中了已有内容（去重）。 */
  readonly deduped: boolean;
}

/** sha256 内容寻址路径：`ab/cd/abcdef...`（两级分片，避免单目录下文件过多）。 */
function contentPath(sha256: string): string {
  return join(sha256.slice(0, 2), sha256.slice(2, 4), sha256);
}

export function safeFilename(name: string): string {
  // 只留 basename，去掉路径分隔符与控制字符
  const base = name.split(/[\\/]/).pop() ?? 'file';
  const cleaned = base.replace(/[\u0000-\u001f<>:"|?*]/g, '_').trim();
  return cleaned === '' || cleaned === '.' || cleaned === '..' ? 'file' : cleaned.slice(0, 255);
}

export function guessMime(filename: string, declared: string | undefined): string {
  if (declared !== undefined && declared !== '' && declared !== 'application/octet-stream') {
    return declared.slice(0, 120);
  }
  const ext = filename.toLowerCase().split('.').pop() ?? '';
  const map: Record<string, string> = {
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    webp: 'image/webp',
    svg: 'image/svg+xml',
    txt: 'text/plain',
    md: 'text/markdown',
    json: 'application/json',
    pdf: 'application/pdf',
    zip: 'application/zip',
  };
  return map[ext] ?? 'application/octet-stream';
}

export class AttachmentService {
  constructor(
    private readonly db: Db,
    private readonly uploadsDir: string,
    /** 0 = 不限制。默认 20 MiB。 */
    private readonly maxBytes: number = MAX_ATTACHMENT_BYTES,
  ) {}

  /** 上限的对外可读描述（错误信息里用）。 */
  private get limitLabel(): string {
    if (this.maxBytes <= 0) return '不限';
    const mb = this.maxBytes / (1024 * 1024);
    return mb >= 1 ? `${Number(mb.toFixed(1))} MiB` : `${this.maxBytes} B`;
  }

  async store(input: {
    uploaderId: string;
    filename: string;
    mime: string | undefined;
    data: Buffer;
  }): Promise<StoredAttachment> {
    if (input.data.byteLength === 0) {
      throw new AgentLinkError('VALIDATION_FAILED', '文件内容为空', {
        issues: [{ path: 'file', message: '空文件' }],
      });
    }
    if (this.maxBytes > 0 && input.data.byteLength > this.maxBytes) {
      throw new AgentLinkError('PAYLOAD_TOO_LARGE', `文件超过 ${this.limitLabel}`, {
        limit_bytes: this.maxBytes,
      });
    }

    const sha256 = createHash('sha256').update(input.data).digest('hex');
    const filename = safeFilename(input.filename);
    const mime = guessMime(filename, input.mime);
    const relPath = contentPath(sha256);
    const absPath = resolve(this.uploadsDir, relPath);

    // 内容寻址去重：同一 sha256 已经在盘上就不再写（M7 验收 4）
    const existingFile = await stat(absPath).catch(() => null);
    let deduped = false;
    if (existingFile === null) {
      await mkdir(dirname(absPath), { recursive: true });
      await writeFile(absPath, input.data, { mode: 0o640 });
    } else {
      deduped = true;
    }

    // 数据库层面：同 sha256 已有记录时复用该 id（避免同一份内容对应多个 id）
    const existingRow = findAttachmentBySha(this.db, sha256);
    if (existingRow) {
      return {
        attachmentId: existingRow.id,
        filename: existingRow.filename,
        mime: existingRow.mime,
        size: existingRow.size,
        sha256,
        deduped: true,
      };
    }

    const id = newAttachmentId();
    insertAttachment(this.db, {
      id,
      tenantId: 'default',
      uploaderId: input.uploaderId,
      filename,
      mime,
      size: input.data.byteLength,
      sha256,
      path: relPath,
      createdAt: nowMs(),
    });

    return {
      attachmentId: id,
      filename,
      mime,
      size: input.data.byteLength,
      sha256,
      deduped,
    };
  }

  /**
   * 下载：需要 (1) 鉴权通过的 user，且 (2) 该 user 与附件的某个引用消息同群。
   *
   * 附件本身不带 conv_id —— 它可能被多条消息引用。这里按"上传者或任一引用该
   * 附件的消息所在群的成员"判定，规则最简单且不漏：只要你在**任一引用它的群**里
   * 就能下载。
   */
  /**
   * 流式存储：边写临时文件边算 sha256，落地后再按内容寻址搬到最终位置。
   *
   * 为什么需要它：`store()` 接收的是完整 Buffer，几百 MiB 的文件会直接把
   * 进程内存打爆。上限放开之后（`MAX_ATTACHMENT_BYTES=0`）这条路径是必须的。
   */
  async storeStream(input: {
    uploaderId: string;
    filename: string;
    mime: string | undefined;
    stream: AsyncIterable<Buffer>;
    /**
     * 上传流是否被**截断**（multipart 的 fileSize 限制触发时会把流截断而不是抛错）。
     * 必须在落库前检查 —— 否则超限文件会被静默存成半截并返回 201，
     * 这比报错危险得多（用户以为传上去了）。
     */
    truncated?: () => boolean;
  }): Promise<StoredAttachment> {
    const filename = safeFilename(input.filename);
    const mime = guessMime(filename, input.mime);
    const tmpDir = resolve(this.uploadsDir, 'tmp');
    await mkdir(tmpDir, { recursive: true });
    const tmpPath = resolve(tmpDir, `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`);

    const hash = createHash('sha256');
    let total = 0;
    const out = createWriteStream(tmpPath);
    try {
      for await (const chunk of input.stream) {
        total += chunk.byteLength;
        if (this.maxBytes > 0 && total > this.maxBytes) {
          throw new AgentLinkError('PAYLOAD_TOO_LARGE', `文件超过 ${this.limitLabel}`, {
            limit_bytes: this.maxBytes,
          });
        }
        hash.update(chunk);
        if (!out.write(chunk)) {
          await new Promise<void>((res) => out.once('drain', () => res()));
        }
      }
      await new Promise<void>((res, rej) => out.end((err?: Error | null) => (err ? rej(err) : res())));

      if (input.truncated?.() === true) {
        throw new AgentLinkError('PAYLOAD_TOO_LARGE', `文件超过 ${this.limitLabel}`, {
          limit_bytes: this.maxBytes,
        });
      }
    } catch (err) {
      out.destroy();
      await rm(tmpPath, { force: true }).catch(() => undefined);
      throw err;
    }

    if (total === 0) {
      await rm(tmpPath, { force: true }).catch(() => undefined);
      throw new AgentLinkError('VALIDATION_FAILED', '文件内容为空', {
        issues: [{ path: 'file', message: '空文件' }],
      });
    }

    const sha256 = hash.digest('hex');
    const relPath = contentPath(sha256);
    const absPath = resolve(this.uploadsDir, relPath);
    await mkdir(dirname(absPath), { recursive: true });

    const existing = await stat(absPath).catch(() => null);
    if (existing !== null) {
      await rm(tmpPath, { force: true }).catch(() => undefined);
      return this.#record({ sha256, filename, mime, size: total, uploaderId: input.uploaderId, relPath });
    }
    await rename(tmpPath, absPath);
    const stored = this.#record({
      sha256,
      filename,
      mime,
      size: total,
      uploaderId: input.uploaderId,
      relPath,
    });
    // 视频抽一帧做缩略图（失败不影响上传 —— 见 services/thumbnails.ts）
    await this.#maybeThumbnail(stored, absPath);
    return stored;
  }

  /**
   * 视频附件顺带抽一帧存成 JPEG，客户端列表里显示缩略图而不是黑框。
   *
   * 任何失败都吞掉：缩略图是**锦上添花**，不能让它把一次成功的上传变成 500。
   */
  async #maybeThumbnail(stored: StoredAttachment, absPath: string): Promise<void> {
    if (!isVideoFile(stored.mime, stored.filename)) return;
    try {
      await generateVideoThumbnail({
        sourcePath: absPath,
        destPath: thumbnailAbsPath(this.uploadsDir, stored.sha256),
      });
    } catch {
      // 忽略：没有缩略图而已
    }
  }

  /** 落一条 attachments 记录（同 sha256 复用已有 id，避免一份内容多个 id）。 */
  #record(input: {
    sha256: string;
    filename: string;
    mime: string;
    size: number;
    uploaderId: string;
    relPath: string;
  }): StoredAttachment {
    const existingRow = findAttachmentBySha(this.db, input.sha256);
    if (existingRow) {
      return {
        attachmentId: existingRow.id,
        filename: existingRow.filename,
        mime: existingRow.mime,
        size: existingRow.size,
        sha256: input.sha256,
        deduped: true,
      };
    }
    const id = newAttachmentId();
    insertAttachment(this.db, {
      id,
      tenantId: 'default',
      uploaderId: input.uploaderId,
      filename: input.filename,
      mime: input.mime,
      size: input.size,
      sha256: input.sha256,
      path: input.relPath,
      createdAt: nowMs(),
    });
    return {
      attachmentId: id,
      filename: input.filename,
      mime: input.mime,
      size: input.size,
      sha256: input.sha256,
      deduped: false,
    };
  }

  async load(input: {
    attachmentId: string;
    userId: string;
  }): Promise<{ row: AttachmentRow; data: Buffer }> {
    const row = findAttachment(this.db, input.attachmentId);
    if (!row) {
      throw new AgentLinkError('NOT_FOUND', '附件不存在', { what: 'attachment' });
    }

    const allowed = this.#canAccess(row, input.userId);
    if (!allowed) {
      throw new AgentLinkError('PERM_DENIED', '你不是该附件所在会话的成员');
    }

    const absPath = resolve(this.uploadsDir, row.path);
    const data = await readFile(absPath).catch(() => null);
    if (data === null) {
      throw new AgentLinkError('NOT_FOUND', '附件文件已丢失', { what: 'attachment' });
    }
    return { row, data };
  }

  #canAccess(row: AttachmentRow, userId: string): boolean {
    // 上传者本人始终可以访问
    if (row.uploaderId === userId) return true;

    // 否则：只要你在**任一引用该附件的消息所在群**里就算有权。
    // 附件本身不带 conv_id（可能被多条消息引用），这样判定最简单且不漏。
    const rows = listConvsReferencingAttachment(this.db, row.id);
    for (const r of rows) {
      if (isMember(this.db, r.convId, userId)) return true;
    }
    return false;
  }

  async remove(attachmentId: string): Promise<void> {
    const row = findAttachment(this.db, attachmentId);
    if (!row) return;
    const absPath = resolve(this.uploadsDir, row.path);
    await unlink(absPath).catch(() => undefined);
  }

  /**
   * 取缩略图字节。没有缩略图（不是视频 / 没装 ffmpeg / 抽帧失败）时返回 null。
   *
   * 权限判定与本体下载**完全一致**（同一个 `#canAccess`）——
   * 否则知道 attachment_id 就能拿到别人群里的视频画面。
   */
  async loadThumbnail(input: {
    attachmentId: string;
    userId: string;
  }): Promise<{ data: Buffer; mime: string } | null> {
    const row = findAttachment(this.db, input.attachmentId);
    if (row === undefined) return null;
    if (!this.#canAccess(row, input.userId)) {
      throw new AgentLinkError('PERM_DENIED', '你不是该附件所在会话的成员');
    }
    const absPath = thumbnailAbsPath(this.uploadsDir, row.sha256);
    const data = await readFile(absPath).catch(() => null);
    if (data === null) return null;
    return { data, mime: 'image/jpeg' };
  }

  /** 消息 content 里引用附件时，校验其存在性与可见性（发消息前的校验）。 */
  assertContentAttachments(content: Content, userId: string): void {
    for (const block of content) {
      if (block.type === 'text') continue;
      const row = findAttachment(this.db, block.attachment_id);
      if (!row) {
        throw new AgentLinkError('NOT_FOUND', `附件 ${block.attachment_id} 不存在`, {
          what: 'attachment',
        });
      }
      if (!this.#canAccess(row, userId)) {
        throw new AgentLinkError('PERM_DENIED', '你没有权限引用这个附件');
      }
    }
  }
}

/** 给下载路由用：把存储行转成 HTTP 响应头。 */
export function attachmentHeaders(row: AttachmentRow): Record<string, string> {
  return {
    'content-type': row.mime,
    'content-length': String(row.size),
    'content-disposition': `inline; filename*=UTF-8''${encodeURIComponent(row.filename)}`,
    'x-content-type-options': 'nosniff',
    'cache-control': 'private, max-age=3600',
  };
}
