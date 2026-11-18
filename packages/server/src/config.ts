/**
 * 配置一律走环境变量（需求确认书 §6）。
 * 缺失即报错退出，**不许**静默用默认值（实现计划 M0 硬性要求）。
 */

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

export interface Config {
  readonly nodeEnv: 'development' | 'production' | 'test';
  readonly host: string;
  readonly port: number;
  readonly jwtSecret: string;
  readonly agentTokenPepper: string;
  readonly databasePath: string;
  readonly uploadsDir: string;
  readonly publicDir: string | null;
  readonly accessTokenTtl: string;
  readonly refreshTokenTtl: string;
  readonly logLevel: string;
  /** M11：本地 ESM 钩子模块路径。 */
  readonly hooksModule: string | null;
  /** 是否给已存在的库自动跑迁移（默认 true，单进程部署）。 */
  readonly autoMigrate: boolean;
  /**
   * 单个附件的字节上限。`0` 表示**不限制**。
   *
   * 默认 20 MiB（与需求确认书一致）。想放开就设
   * `MAX_ATTACHMENT_BYTES=0`（不限制）或一个更大的值。
   * 注意：不限制时磁盘就是上限 —— 请配合前置代理的请求体限制使用。
   */
  readonly maxAttachmentBytes: number;
  /**
   * 前后端分离部署时允许的跨域来源（逗号分隔）。
   *
   * 同源托管（服务端带 `PUBLIC_DIR`）时留空即可 —— 不需要任何 CORS 头。
   * 分离部署（客户端在 CDN / 另一个域名）时必须显式列出来源，
   * **不允许**用 `*`：请求带 `Authorization`，通配符会把 token 暴露给任何站点。
   */
  readonly corsOrigins: readonly string[];
}

type Env = Record<string, string | undefined>;

/** 默认 20 MiB；`0` 或负数视为不限制。支持 `20MiB` / `104857600` 两种写法。 */
const DEFAULT_MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;

export function parseByteLimit(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === '') return DEFAULT_MAX_ATTACHMENT_BYTES;
  const text = raw.trim().toLowerCase();
  const m = /^(\d+(?:\.\d+)?)\s*(b|kb|kib|mb|mib|gb|gib)?$/.exec(text);
  if (m === null) return DEFAULT_MAX_ATTACHMENT_BYTES;
  const value = Number(m[1]);
  if (!Number.isFinite(value)) return DEFAULT_MAX_ATTACHMENT_BYTES;
  const unit = m[2] ?? 'b';
  const mul: Record<string, number> = {
    b: 1,
    kb: 1000,
    kib: 1024,
    mb: 1000 * 1000,
    mib: 1024 * 1024,
    gb: 1000 * 1000 * 1000,
    gib: 1024 * 1024 * 1024,
  };
  const bytes = Math.round(value * (mul[unit] ?? 1));
  return bytes <= 0 ? 0 : bytes;
}

function required(env: Env, key: string, hint: string): string {
  const raw = env[key];
  if (raw === undefined || raw.trim() === '') {
    throw new ConfigError(
      `缺少必需的环境变量 ${key}。${hint}\n` +
        `本地开发：cp packages/server/.env.example packages/server/.env 并填好。`,
    );
  }
  return raw;
}

function optionalInt(env: Env, key: string, fallback: number): number {
  const raw = env[key];
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0 || n > 65535) {
    throw new ConfigError(`环境变量 ${key} 必须是 0-65535 的整数，收到 "${raw}"。`);
  }
  return n;
}

function bool(env: Env, key: string, fallback: boolean): boolean {
  const raw = env[key];
  if (raw === undefined || raw.trim() === '') return fallback;
  return raw === '1' || raw.toLowerCase() === 'true';
}

export function loadConfig(env: Env = process.env): Config {
  const nodeEnvRaw = env['NODE_ENV'] ?? 'development';
  if (nodeEnvRaw !== 'development' && nodeEnvRaw !== 'production' && nodeEnvRaw !== 'test') {
    throw new ConfigError(`NODE_ENV 只能是 development | production | test，收到 "${nodeEnvRaw}"。`);
  }

  const jwtSecret = required(env, 'JWT_SECRET', '用于签发人类 access/refresh token。至少 32 字节随机串。');
  if (jwtSecret.length < 32) {
    throw new ConfigError(
      `JWT_SECRET 至少 32 个字符（当前 ${jwtSecret.length}）。生成方法：openssl rand -hex 32`,
    );
  }

  const agentTokenPepper = required(
    env,
    'AGENT_TOKEN_PEPPER',
    '用于 agent token 的 hash 加盐。至少 16 字节随机串。',
  );
  if (agentTokenPepper.length < 16) {
    throw new ConfigError(
      `AGENT_TOKEN_PEPPER 至少 16 个字符（当前 ${agentTokenPepper.length}）。生成方法：openssl rand -hex 16`,
    );
  }

  const publicDirRaw = env['PUBLIC_DIR'];

  return {
    nodeEnv: nodeEnvRaw,
    host: env['HOST'] ?? '0.0.0.0',
    port: optionalInt(env, 'PORT', 3000),
    jwtSecret,
    agentTokenPepper,
    databasePath: env['DATABASE_PATH'] ?? './data/agentlink.db',
    uploadsDir: env['UPLOADS_DIR'] ?? './data/uploads',
    publicDir: publicDirRaw === undefined || publicDirRaw === '' ? null : publicDirRaw,
    accessTokenTtl: env['ACCESS_TOKEN_TTL'] ?? '15m',
    refreshTokenTtl: env['REFRESH_TOKEN_TTL'] ?? '30d',
    logLevel: env['LOG_LEVEL'] ?? (nodeEnvRaw === 'test' ? 'silent' : 'info'),
    hooksModule: env['HOOKS_MODULE'] ?? null,
    autoMigrate: bool(env, 'AUTO_MIGRATE', true),
    maxAttachmentBytes: parseByteLimit(env['MAX_ATTACHMENT_BYTES']),
    corsOrigins: (env['CORS_ORIGINS'] ?? '')
      .split(',')
      .map((o) => o.trim())
      .filter((o) => o !== ''),
  };
}
