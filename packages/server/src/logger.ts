import type { FastifyServerOptions } from 'fastify';
import type { Config } from './config.js';

/** Fastify 接受的具体 logger 选项类型（去掉 `boolean` 那一支）。 */
type ResolvedLoggerOptions = Exclude<NonNullable<FastifyServerOptions['logger']>, boolean>;

/**
 * 日志配置。
 *
 * 安全要求（施工守则 §8）：token 不得出现在访问日志里。
 * 两处保障：
 *   1. token 只走 WS 帧体 / HTTP body，从不进 URL 查询串（协议 §2.4）；
 *   2. 访问日志只记 method/url/status，不记 header 与 body（见 app.ts）。
 *
 * 这里只返回 Fastify 的 logger 选项，让 Fastify 自己建 pino 实例——
 * 自己 new pino 会改变 FastifyInstance 的 Logger 泛型，路由签名到处对不上。
 */
export function loggerOptions(config: Config): ResolvedLoggerOptions {
  const redact = {
    paths: [
      'req.headers.authorization',
      'req.headers.cookie',
      'token',
      'access_token',
      'refresh_token',
      'password',
      '*.token',
      '*.access_token',
      '*.refresh_token',
      '*.password',
    ],
    censor: '[redacted]',
  };

  if (config.nodeEnv === 'development') {
    return {
      level: config.logLevel,
      redact,
      transport: {
        target: 'pino-pretty',
        options: { translateTime: 'HH:MM:ss.l', ignore: 'pid,hostname' },
      },
    };
  }
  return { level: config.logLevel, redact };
}
