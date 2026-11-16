import { createHash } from 'node:crypto';
import { mkdir, writeFile, readFile, stat, unlink } from 'node:fs/promises';
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

/**
 * 附件（实现计划 M7）。
 *
 * 硬性要求：
 *   - 上传 ≤ 20 MiB，超限 413
 *   - 按 sha256 **内容寻址**落盘：同一文件传两次，磁盘只存一份
 *   - 下载要鉴权 + **群成员校验**（施工守则 §8：附件下载校验群成员身份）
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
  ) {}

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
    if (input.data.byteLength > MAX_ATTACHMENT_BYTES) {
      throw new AgentLinkError('PAYLOAD_TOO_LARGE', '文件超过 20 MiB', {
        limit_bytes: MAX_ATTACHMENT_BYTES,
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
