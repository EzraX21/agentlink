import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import multipart from '@fastify/multipart';
import { AgentLinkError } from '@agentlink/protocol';
import type { AppServices } from '../services/index.js';
import { AttachmentService, MAX_ATTACHMENT_BYTES, attachmentHeaders } from '../services/attachments.js';
import { requireUser } from './auth.js';
import { sendError } from './errors.js';

/**
 * 附件 HTTP 面（实现计划 M7）。
 *
 *   POST /api/attachments             multipart，≤ 20 MiB，sha256 内容寻址
 *   GET  /api/attachments/:id/:name   需鉴权 + 群成员校验
 */
export async function attachmentRoutes(
  app: FastifyInstance,
  services: AppServices,
): Promise<void> {
  // 上限来自配置：默认 20 MiB，`MAX_ATTACHMENT_BYTES=0` 表示不限制
  const maxBytes = services.config.maxAttachmentBytes;

  /**
   * Fastify 自身的 bodyLimit（默认 **1 MiB**）会先把请求体截断 ——
   * 表现是"上传成功但文件只有 1 MiB"，比 multipart 的 fileSize 限制更隐蔽
   * （后者会走到我们的 413 分支）。这里给上传路由单独放开：
   * 有上限时留一点余量给 multipart 边界，不限时就给一个足够大的值。
   */
  const uploadBodyLimit = maxBytes > 0 ? maxBytes + 1024 * 1024 : 2 ** 31;
  const svc = new AttachmentService(services.dbc.db, services.config.uploadsDir, maxBytes);

  await app.register(multipart, {
    // 不限制时不要传 fileSize（传 Infinity 会被 fastify 当成非法值）
    limits: maxBytes > 0 ? { fileSize: maxBytes, files: 1 } : { files: 1 },
    throwFileSizeLimit: false,
  });

  /**
   * 上传处理：人类（`/api/attachments`）与外部 agent（`/api/agent/attachments`）
   * 共用同一段逻辑 —— 同样的 20 MiB 上限、同样的 sha256 内容寻址、
   * 同样的"上传者是普通用户/agent"身份。
   *
   * 分开两个路径只是为了 API 语义清楚（外部 agent 的入口都挂在 /api/agent 下），
   * 实现上不该有两份。
   */
  const handleUpload = async (req: FastifyRequest, reply: FastifyReply): Promise<unknown> => {
    try {
      const who = await requireUser(services, req.headers);

      const file = await req.file();
      if (!file) {
        throw new AgentLinkError('VALIDATION_FAILED', '请求里没有文件字段', {
          issues: [{ path: 'file', message: '缺少 file 字段' }],
        });
      }

      // 流式落盘：边写边算 sha256，不把整个文件读进内存 ——
      // 上限放开之后（MAX_ATTACHMENT_BYTES=0）这一步是必须的，否则几百 MiB
      // 的文件会直接把进程内存打爆。
      const stored = await svc.storeStream({
        uploaderId: who.userId,
        filename: file.filename,
        mime: file.mimetype,
        stream: file.file as AsyncIterable<Buffer>,
        truncated: () => file.file.truncated,
      });

      return reply.code(201).send({
        attachment_id: stored.attachmentId,
        filename: stored.filename,
        mime: stored.mime,
        size: stored.size,
        sha256: stored.sha256,
        deduped: stored.deduped,
      });
    } catch (err) {
      // multipart 的限流错误也走统一映射
      if (
        typeof err === 'object' &&
        err !== null &&
        'code' in err &&
        (err as { code: string }).code === 'FST_REQ_FILE_TOO_LARGE'
      ) {
        return reply.code(413).send({
          error: {
            code: 'PAYLOAD_TOO_LARGE',
            message: maxBytes > 0 ? `文件超过 ${Math.round(maxBytes / (1024 * 1024))} MiB` : '文件过大',
            details: { limit_bytes: maxBytes },
          },
        });
      }
      return sendError(reply, err);
    }
  };

  app.post('/api/attachments', { bodyLimit: uploadBodyLimit }, handleUpload);
  // 外部 agent 的上传入口（同一个处理函数，只是路径挂在 /api/agent 下）
  app.post('/api/agent/attachments', { bodyLimit: uploadBodyLimit }, handleUpload);

  app.get<{ Params: { id: string; filename: string } }>(
    '/api/attachments/:id/:filename',
    async (req, reply) => {
      try {
        const who = await requireUser(services, req.headers);
        const { row, data } = await svc.load({
          attachmentId: req.params.id,
          userId: who.userId,
        });

        // 群体校验失败会抛 PERM_DENIED（403），由 sendError 映射
        const headers = attachmentHeaders(row);
        return reply
          .code(200)
          .headers(headers)
          .send(data);
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );

  app.get('/api/attachments/:id', async (req, reply) => {
    try {
      const who = await requireUser(services, req.headers);
      const id = (req.params as { id: string }).id;
      const { row } = await svc.load({ attachmentId: id, userId: who.userId });
      return reply.send({
        attachment_id: row.id,
        filename: row.filename,
        mime: row.mime,
        size: row.size,
        sha256: row.sha256,
        created_at: row.createdAt,
      });
    } catch (err) {
      return sendError(reply, err);
    }
  });

  /**
   * 视频缩略图。
   *
   * 没有缩略图时回 **404**（而不是 200 + 空体）：客户端据此退回视频卡片，
   * 不会把 0 字节当成一张坏图渲染。
   *
   * 权限与本体下载一致 —— 知道 attachment_id 不该能看别人群里的画面。
   */
  app.get<{ Params: { id: string } }>('/api/attachments/:id/thumbnail', async (req, reply) => {
    try {
      const who = await requireUser(services, req.headers);
      const id = req.params.id;
      const thumb = await svc.loadThumbnail({ attachmentId: id, userId: who.userId });
      if (thumb === null) {
        return reply.code(404).send({
          error: { code: 'NOT_FOUND', message: '该附件没有缩略图', details: { what: 'thumbnail' } },
        });
      }
      return reply
        .code(200)
        .headers({
          'content-type': thumb.mime,
          'content-length': String(thumb.data.byteLength),
          'cache-control': 'private, max-age=3600',
          'x-content-type-options': 'nosniff',
        })
        .send(thumb.data);
    } catch (err) {
      return sendError(reply, err);
    }
  });
}