import { hash, verify } from '@node-rs/argon2';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * 口令与 token 的哈希。
 *
 * - 人类口令：argon2id（施工守则 §8：不是 sha256）
 * - agent token：sha256(secret + pepper)（数据模型 §5：长随机串，sha256 足够）
 */

/**
 * argon2id 参数（OWASP 推荐下限）：19 MiB 内存、2 次迭代、单线程。
 * `@node-rs/argon2` 的默认算法就是 argon2id，不写 algorithm 字段是为了避开
 * 该包用 ambient const enum 导出枚举（与 verbatimModuleSyntax 冲突）。
 */
const ARGON2_OPTS = {
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
} as const;

export async function hashPassword(plain: string): Promise<string> {
  return hash(plain, ARGON2_OPTS);
}

export async function verifyPassword(hashString: string, plain: string): Promise<boolean> {
  try {
    return await verify(hashString, plain);
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Agent token（数据模型 §5）
// 格式：`ag_<user_id>_<secret>`
// ---------------------------------------------------------------------------

const AGENT_TOKEN_PREFIX = 'ag_';
const AGENT_SECRET_BYTES = 32;

export interface ParsedAgentToken {
  readonly userId: string;
  readonly secret: string;
}

export function generateAgentSecret(): string {
  // 32 字节 CSPRNG，base64url 去掉 padding，只留 [A-Za-z0-9_-]
  return randomBytes(AGENT_SECRET_BYTES).toString('base64url');
}

export function buildAgentToken(userId: string, secret: string): string {
  return `${AGENT_TOKEN_PREFIX}${userId}_${secret}`;
}

export function parseAgentToken(token: string): ParsedAgentToken | null {
  if (!token.startsWith(AGENT_TOKEN_PREFIX)) return null;
  const rest = token.slice(AGENT_TOKEN_PREFIX.length);
  // user_id 形如 u_<26 位 ULID>，不含下划线以外的分隔符
  const sep = rest.indexOf('_', 2);
  if (sep < 0) return null;
  const userId = rest.slice(0, sep);
  const secret = rest.slice(sep + 1);
  if (userId.length < 3 || secret.length < 16) return null;
  return { userId, secret };
}

export function hashAgentSecret(secret: string, pepper: string): string {
  return createHash('sha256').update(`${secret}${pepper}`).digest('hex');
}

/** 常数时间比较两个 hex 哈希。 */
export function safeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  return timingSafeEqual(bufA, bufB);
}
