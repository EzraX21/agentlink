import {
  AgentLinkError,
  OPS,
  isKnownOp,
  type OpName,
  type OpReq,
  type SubscriptionFilters,
} from '@agentlink/protocol';
import type { Config } from '../config.js';
import type { Db } from '../db/index.js';
import type { Hub, ClientState } from '../hub.js';
import type { Connection } from '../ws/gateway.js';
import type { AuthService } from '../auth/service.js';
import type { AppServices } from '../services/index.js';

/**
 * op 分发（协议 §5）。
 *
 * 每个 op 的入参先过 `@agentlink/protocol` 的 schema，再交给处理函数。
 * 解析失败统一回 `VALIDATION_FAILED` + `details.issues`（协议 §9）。
 */

export interface OpContext {
  readonly conn: Connection;
  readonly state: ClientState;
  readonly services: AppServices;
  readonly config: Config;
  readonly db: Db;
  readonly hub: Hub;
  readonly auth: AuthService;
  /** 原始 data，未校验。 */
  readonly rawData: unknown;
}

export type Handler = (ctx: OpContext) => Promise<unknown> | unknown;

export type HandlerMap = Map<string, Handler>;

/** 用协议 schema 校验 data，失败抛 VALIDATION_FAILED（协议 §9）。 */
export function validateData<N extends OpName>(op: N, rawData: unknown): OpReq<N> {
  const parsed = OPS[op].req.safeParse(rawData ?? {});
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => ({
      path: i.path.map(String).join('.'),
      message: i.message,
    }));
    throw new AgentLinkError('VALIDATION_FAILED', `${op} 参数不合法`, { issues });
  }
  return parsed.data as OpReq<N>;
}

export { isKnownOp, OPS };

/** 默认订阅（不调用 subscribe.set）：全部可见会话 + 全部事件类型（协议 §5.6）。 */
export const DEFAULT_FILTERS: SubscriptionFilters = {};

export function makeHandlers(): HandlerMap {
  const map: HandlerMap = new Map();
  for (const op of Object.keys(OPS)) {
    map.set(op, notImplemented(op));
  }
  return map;
}

function notImplemented(op: string): Handler {
  return () => {
    throw new AgentLinkError('UNSUPPORTED_OP', `${op} 尚未实现`, { op });
  };
}

export function registerHandler(map: HandlerMap, op: OpName, handler: Handler): void {
  map.set(op, handler);
}
