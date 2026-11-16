import type { FastifyReply } from 'fastify';
import { AgentLinkError } from '@agentlink/protocol';

/**
 * HTTP 错误 → 状态码映射（协议 §9 的 code 保持稳定，HTTP 层只做粗映射）。
 *
 * 注意：token 绝不回显，错误消息里也不带 token。
 */
const STATUS: Record<string, number> = {
  AUTH_REQUIRED: 401,
  AUTH_INVALID: 401,
  AUTH_EXPIRED: 401,
  UNSUPPORTED_VERSION: 400,
  UNSUPPORTED_OP: 400,
  PERM_DENIED: 403,
  NOT_FOUND: 404,
  VALIDATION_FAILED: 400,
  RATE_LIMITED: 429,
  PAYLOAD_TOO_LARGE: 413,
  STREAM_CLOSED: 409,
  CONFLICT: 409,
};

export function sendError(reply: FastifyReply, err: unknown): FastifyReply {
  if (err instanceof AgentLinkError) {
    const status = STATUS[err.code] ?? 500;
    const pe = err.toProtocolError();
    return reply.code(status).send({ error: pe });
  }
  reply.log.error({ err }, '未处理的 HTTP 异常');
  return reply.code(500).send({ error: { code: 'CONFLICT', message: '服务端内部错误' } });
}
