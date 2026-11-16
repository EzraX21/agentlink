import { AgentLinkError, RATE_LIMITS } from '@agentlink/protocol';

/**
 * 限流（协议 §11）。
 *
 * 令牌桶，按身份（user_id）计，配额是服务端常量、不落库。
 * 超限回 `RATE_LIMITED` + `details.retry_after_ms`，**不得静默丢弃**。
 */

export type RateLimitAction = keyof typeof RATE_LIMITS;

/**
 * 测试专用配额覆盖。
 *
 * 只在 `NODE_ENV=test` 下生效（见 fromEnv）。验收脚本要造 120/200 条消息来验证
 * seq 单调与分页，而协议 §11 的 30 条/60 秒配额是按**身份**计的 —— 这是正确的
 * 生产行为（M5 单独验证它），但不该让规模测试变成"等配额"。
 *
 * 生产环境完全忽略这个变量：配额仍是服务端常量，不落库、不做配置界面（协议 §11）。
 */
export type RateLimitOverrides = Partial<Record<RateLimitAction, number>>;

export function fromEnv(env: NodeJS.ProcessEnv = process.env): RateLimiter {
  if (env['NODE_ENV'] !== 'test') return new RateLimiter();
  const raw = env['RATE_LIMIT_OVERRIDE'];
  if (raw === undefined || raw === '') return new RateLimiter();
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const overrides: RateLimitOverrides = {};
    for (const key of Object.keys(RATE_LIMITS) as RateLimitAction[]) {
      const v = parsed[key];
      if (typeof v === 'number' && Number.isFinite(v) && v > 0) overrides[key] = v;
    }
    return new RateLimiter(overrides);
  } catch {
    return new RateLimiter();
  }
}

interface Bucket {
  /** 当前可用令牌数（浮点，按时间补充）。 */
  tokens: number;
  lastRefillMs: number;
}

export class RateLimiter {
  private readonly buckets = new Map<string, Bucket>();

  constructor(private readonly overrides: RateLimitOverrides = {}) {}

  #cfg(action: RateLimitAction): { limit: number; window_ms: number } {
    const base = RATE_LIMITS[action];
    const limit = this.overrides[action];
    return limit === undefined ? base : { limit, window_ms: base.window_ms };
  }

  /**
   * 消费一个令牌。返回 `null` 表示通过；否则返回需要等待的毫秒数。
   *
   * 用连续补充（不是固定窗口），这样 60 秒内发 31 条必然第 31 条被拒，
   * 而不是在窗口边界上抖动。
   */
  consume(userId: string, action: RateLimitAction, now = Date.now()): number | null {
    const cfg = this.#cfg(action);
    const key = `${action}:${userId}`;
    const ratePerMs = cfg.limit / cfg.window_ms;

    let bucket = this.buckets.get(key);
    if (!bucket) {
      bucket = { tokens: cfg.limit, lastRefillMs: now };
      this.buckets.set(key, bucket);
    } else {
      const elapsed = Math.max(0, now - bucket.lastRefillMs);
      bucket.tokens = Math.min(cfg.limit, bucket.tokens + elapsed * ratePerMs);
      bucket.lastRefillMs = now;
    }

    if (bucket.tokens >= 1) {
      bucket.tokens -= 1;
      return null;
    }

    // 需要等多少个令牌补齐到 1
    const deficit = 1 - bucket.tokens;
    const retryAfterMs = Math.max(1, Math.ceil(deficit / ratePerMs));
    return retryAfterMs;
  }

  /** 消费失败直接抛 RATE_LIMITED。 */
  assert(userId: string, action: RateLimitAction, now = Date.now()): void {
    const retry = this.consume(userId, action, now);
    if (retry !== null) {
      throw new AgentLinkError('RATE_LIMITED', '请求太频繁，稍后再试', {
        retry_after_ms: retry,
      });
    }
  }

  /** 验收用：清空某个用户/动作的桶。 */
  reset(userId?: string, action?: RateLimitAction): void {
    if (userId === undefined) {
      this.buckets.clear();
      return;
    }
    for (const key of [...this.buckets.keys()]) {
      const [a, u] = key.split(':');
      if (u !== userId) continue;
      if (action !== undefined && a !== action) continue;
      this.buckets.delete(key);
    }
  }

  /** 定期清理长期不活跃的桶，避免内存无界增长。 */
  sweep(now = Date.now()): number {
    let removed = 0;
    for (const [key, bucket] of this.buckets) {
      const action = key.split(':')[0] as RateLimitAction;
      const cfg = RATE_LIMITS[action];
      if (!cfg) {
        this.buckets.delete(key);
        removed += 1;
        continue;
      }
      // 满桶且超过一个窗口没动过 → 可以丢
      if (now - bucket.lastRefillMs > cfg.window_ms * 2) {
        this.buckets.delete(key);
        removed += 1;
      }
    }
    return removed;
  }
}
