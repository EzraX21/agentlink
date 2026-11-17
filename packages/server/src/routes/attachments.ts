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
  const svc = new AttachmentService(services.dbc.db, services.config.uploadsDir);

  await app.register(multipart, {
    limits: {
      fileSize: MAX_ATTACHMENT_BYTES,
      files: 1,
      // 字段用默认限制即可
    },
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

      const chunks: Buffer[] = [];
      let total = 0;
      for await (const chunk of file.file) {
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
        total += buf.byteLength;
        if (total > MAX_ATTACHMENT_BYTES) {
          // 协议一致：超限用 PAYLOAD_TOO_LARGE，HTTP 层映射到 413
          throw new AgentLinkError('PAYLOAD_TOO_LARGE', '文件超过 20 MiB', {
            limit_bytes: MAX_ATTACHMENT_BYTES,
          });
        }
        chunks.push(buf);
      }

      // multipart 自带的大小限制触发时，流会被截断并置 truncated
      if (file.file.truncated) {
        throw new AgentLinkError('PAYLOAD_TOO_LARGE', '文件超过 20 MiB', {
          limit_bytes: MAX_ATTACHMENT_BYTES,
        });
      }

      const stored = await svc.store({
        uploaderId: who.userId,
        filename: file.filename,
        mime: file.mimetype,
        data: Buffer.concat(chunks),
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
            message: '文件超过 20 MiB',
            details: { limit_bytes: MAX_ATTACHMENT_BYTES },
          },
        });
      }
      return sendError(reply, err);
    }
  };

  app.post('/api/attachments', handleUpload);
  // 外部 agent 的上传入口（同一个处理函数，只是路径挂在 /api/agent 下）
  app.post('/api/agent/attachments', handleUpload);

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
}