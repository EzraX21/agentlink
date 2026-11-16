import { z } from 'zod';

/**
 * 线上错误对象。`code` 在类型上是 `string` 而不是联合类型：
 * 帧信封层不认识具体错误码，只有 ops 层知道。
 */
export interface WireError {
  code: string;
  message: string;
  details?: unknown;
}

/**
 * 帧信封（协议 §3）。只有三种 kind：req / res / evt。
 *
 * `data` 在信封层不校验——具体结构由 `ops.ts` / `events.ts` 按 `op` / `type` 决定。
 * 这样信封解析永远只有一处，未知 op 也能先解出信封再回 `UNSUPPORTED_OP`。
 */

export const PROTOCOL_VERSION = 1;

/** WS 子协议标识（施工守则 §7）。 */
export const WS_SUBPROTOCOL = 'agentlink.v1';

/** 单帧上限 1 MiB（协议 §1）。超限回 PAYLOAD_TOO_LARGE，不断开连接。 */
export const MAX_FRAME_BYTES = 1024 * 1024;

/** 未认证连接的握手超时（协议 §2）。 */
export const AUTH_TIMEOUT_MS = 5000;

export const ReqFrameSchema = z.object({
  v: z.literal(PROTOCOL_VERSION),
  kind: z.literal('req'),
  id: z.string().min(1).max(128),
  op: z.string().min(1),
  data: z.unknown().optional(),
});
export type ReqFrame = z.infer<typeof ReqFrameSchema>;

export const ResOkFrameSchema = z.object({
  v: z.literal(PROTOCOL_VERSION),
  kind: z.literal('res'),
  id: z.string(),
  ok: z.literal(true),
  data: z.unknown(),
});
export type ResOkFrame = z.infer<typeof ResOkFrameSchema>;

export const ResErrFrameSchema = z.object({
  v: z.literal(PROTOCOL_VERSION),
  kind: z.literal('res'),
  id: z.string(),
  ok: z.literal(false),
  error: z.object({
    code: z.string(),
    message: z.string(),
    details: z.unknown().optional(),
  }),
});
export type ResErrFrame = z.infer<typeof ResErrFrameSchema>;

export const ResFrameSchema = z.discriminatedUnion('ok', [
  ResOkFrameSchema,
  ResErrFrameSchema,
]);
export type ResFrame = z.infer<typeof ResFrameSchema>;

export const EvtFrameSchema = z.object({
  v: z.literal(PROTOCOL_VERSION),
  kind: z.literal('evt'),
  type: z.string(),
  /** 瞬时事件为 null（协议 §4.1）。 */
  seq: z.number().int().nonnegative().nullable(),
  ts: z.number().int().nonnegative(),
  data: z.unknown(),
});
export type EvtFrame = z.infer<typeof EvtFrameSchema>;

export const FrameSchema = z.union([ReqFrameSchema, ResFrameSchema, EvtFrameSchema]);
export type Frame = z.infer<typeof FrameSchema>;

/**
 * 只解析“是不是一个带 v/kind 的信封”，不校验具体内容。
 * 服务端用它来决定回 `UNSUPPORTED_VERSION` 还是 `VALIDATION_FAILED`。
 */
export const EnvelopeSchema = z.object({
  v: z.number().int(),
  kind: z.enum(['req', 'res', 'evt']),
});
export type Envelope = z.infer<typeof EnvelopeSchema>;

export function makeResOk(id: string, data: unknown): ResOkFrame {
  return { v: PROTOCOL_VERSION, kind: 'res', id, ok: true, data };
}

export function makeResErr(id: string, error: WireError): ResErrFrame {
  return { v: PROTOCOL_VERSION, kind: 'res', id, ok: false, error };
}

export function makeEvt(type: string, seq: number | null, ts: number, data: unknown): EvtFrame {
  return { v: PROTOCOL_VERSION, kind: 'evt', type, seq, ts, data };
}

/** 解析客户端发来的 req 帧；失败时给出可回给客户端的错误码。 */
export type ParseReqResult =
  | { ok: true; frame: ReqFrame }
  | { ok: false; id: string; reason: 'version' | 'shape'; got?: number; issues?: string[] };

export function parseReqFrame(raw: unknown): ParseReqResult {
  const env = EnvelopeSchema.safeParse(raw);
  const id =
    typeof raw === 'object' && raw !== null && 'id' in raw && typeof raw.id === 'string'
      ? raw.id
      : '';
  if (!env.success) {
    return { ok: false, id, reason: 'shape' };
  }
  if (env.data.v !== PROTOCOL_VERSION) {
    return { ok: false, id, reason: 'version', got: env.data.v };
  }
  if (env.data.kind !== 'req') {
    return { ok: false, id, reason: 'shape' };
  }
  const parsed = ReqFrameSchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, id, reason: 'shape' };
  }
  return { ok: true, frame: parsed.data };
}
