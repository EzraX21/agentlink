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
}

type Env = Record<string, string | undefined>;

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
  };
}
