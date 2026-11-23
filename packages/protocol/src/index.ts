/**
 * @agentlink/protocol —— 协议唯一真源。
 *
 * 只依赖 zod。不得依赖 Fastify / React / better-sqlite3（施工守则 §4）。
 * 服务端、Web 客户端、Agent SDK 都从这里取帧格式、op、evt 与错误码。
 */

export * from './errors.js';
export * from './models.js';
export * from './frames.js';
export * from './ops.js';
export * from './events.js';

/** 流式节流阈值（协议 §8.3）：先到者触发一次落库。 */
export const STREAM_FLUSH_INTERVAL_MS = 500;
export const STREAM_FLUSH_CHARS = 512;

/** 流式空闲超时（协议 §8.5）：60 秒无 delta 自动 abort。 */
export const STREAM_IDLE_TIMEOUT_MS = 60_000;

/** 僵尸流式消息清理阈值（数据模型 §6.4）：120 秒是崩溃残留兜底，不是业务超时。 */
export const STREAM_ZOMBIE_AGE_MS = 120_000;

/** `events` 保留 30 天（数据模型 §6.3）。 */
export const EVENTS_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
export const EVENTS_CLEANUP_INTERVAL_MS = 10 * 60 * 1000;

/** 限流配额（协议 §11）：服务端常量，不落库。 */
export const RATE_LIMITS = {
  message_send: { limit: 30, window_ms: 60_000 },
  stream_delta: { limit: 200, window_ms: 60_000 },
  search: { limit: 20, window_ms: 60_000 },
  stream_begin: { limit: 5, window_ms: 60_000 },
} as const;

// ---------------------------------------------------------------------------
// agent 工具权限分级（四象限）
// ---------------------------------------------------------------------------

/**
 * 工具分级的**唯一真源**。服务端按它判定，agent 按它展示 —— 不许各写一份。
 *
 *   群聊 + 普通群友 → 空（纯问答）
 *   群聊 + 服主     → sandbox（只读无害）
 *   私聊 + 普通群友 → 空（个人助理，不碰系统）
 *   私聊 + 服主     → hostRoot（全权限）
 */
export const TOOL_SETS = {
  /** 只读、无副作用。群聊里的服主、私聊里的服主都能用。 */
  sandbox: ['whoami', 'pwd', 'uname', 'uptime', 'df', 'free', 'ps', 'ls', 'cat'] as const,
  /** 全权限 shell。**只有私聊 + 服主**能拿到。 */
  hostRoot: ['exec'] as const,
} as const;

export type ToolTier = 'host-root' | 'sandbox' | 'none';

/**
 * 判定某人某会话能用哪些工具。
 *
 * @param convKind 会话类型
 * @param isHost   触发者是不是服主
 */
export function toolTierFor(convKind: 'group' | 'dm', isHost: boolean): ToolTier {
  if (!isHost) return 'none';
  return convKind === 'dm' ? 'host-root' : 'sandbox';
}

/** 某个层级允许的工具名集合。 */
export function toolsForTier(tier: ToolTier): readonly string[] {
  if (tier === 'host-root') return [...TOOL_SETS.sandbox, ...TOOL_SETS.hostRoot];
  if (tier === 'sandbox') return TOOL_SETS.sandbox;
  return [];
}

export function isToolAllowed(tier: ToolTier, tool: string): boolean {
  return toolsForTier(tier).includes(tool);
}
