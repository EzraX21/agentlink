/**
 * 错误码（协议 §9）。`code` 是稳定字符串，客户端可据此分支；
 * `message` 只是给人看的中文描述，可以随便改。
 */
export const ERROR_CODES = [
  'AUTH_REQUIRED',
  'AUTH_INVALID',
  'AUTH_EXPIRED',
  'UNSUPPORTED_VERSION',
  'UNSUPPORTED_OP',
  'PERM_DENIED',
  'NOT_FOUND',
  'VALIDATION_FAILED',
  'RATE_LIMITED',
  'PAYLOAD_TOO_LARGE',
  'STREAM_CLOSED',
  'CONFLICT',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

/** 每个错误码附带的结构化 details。客户端不得依赖未在此定义的字段。 */
export interface ErrorDetailsMap {
  AUTH_REQUIRED: undefined;
  AUTH_INVALID: undefined;
  AUTH_EXPIRED: undefined;
  UNSUPPORTED_VERSION: { supported: readonly number[]; got: number };
  UNSUPPORTED_OP: { op: string };
  /** `action` 是内部动作名（如 `member.kick`）；`reason` 目前只会是 `muted`。 */
  PERM_DENIED: { action?: string; reason?: 'muted' };
  NOT_FOUND: { what: 'conv' | 'message' | 'user' | 'attachment' };
  /** `issues` 是 Zod 的扁平错误数组。 */
  VALIDATION_FAILED: { issues: ValidationIssue[] };
  RATE_LIMITED: { retry_after_ms: number };
  PAYLOAD_TOO_LARGE: { limit_bytes: number };
  STREAM_CLOSED: { message_id: string };
  CONFLICT: { reason: string };
}

export interface ValidationIssue {
  path: string;
  message: string;
}

export interface ProtocolError<C extends ErrorCode = ErrorCode> {
  code: C;
  message: string;
  details?: ErrorDetailsMap[C];
}

/** 服务端内部抛出的协议错误。路由层统一转成 `res.ok=false`。 */
export class AgentLinkError<C extends ErrorCode = ErrorCode> extends Error {
  readonly code: C;
  readonly details: ErrorDetailsMap[C] | undefined;

  constructor(code: C, message: string, details?: ErrorDetailsMap[C]) {
    super(message);
    this.name = 'AgentLinkError';
    this.code = code;
    this.details = details;
  }

  toProtocolError(): ProtocolError<C> {
    return this.details === undefined
      ? { code: this.code, message: this.message }
      : { code: this.code, message: this.message, details: this.details };
  }
}
