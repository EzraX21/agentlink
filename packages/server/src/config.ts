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
  /**
   * 服主 id（`HOST_OWNER_ID`，可选）。
   *
   * 全权限工具（Host Root 远程终端）只对服主本人开放。这个 id 是部署时**显式**
   * 指定的服主 user id（`u_...`）。没配置时，agent 回退到自己的 `owner_user_id`
   * （谁建的 agent 谁是主人）。
   */
  readonly hostOwnerId: string | null;
  /**
   * 工具告警的收件人（`TOOL_ALERT_USER_IDS`，逗号分隔）。
   *
   * 留空 = 默认全部人类管理员。显式指定用于"让某个非管理员也盯着"。
   * 告警本身是瞬时的，权威记录在 `audit_logs`。
   */
  readonly toolAlertUserIds: readonly string[];
  /**
   * 审计日志保留天数（`AUDIT_RETENTION_DAYS`，默认 180，`0` = 永不删除）。
   *
   * 安全日志的保留期通常比业务数据长，所以单独一个配置而不是复用 events 的 30 天。
   */
  readonly auditRetentionDays: number;
  /**
   * 首次启动自动创建的管理员用户名（默认 `admin`）。
   *
   * 为什么要有：一键启动的容器里没有任何账号，而管理页需要管理员才能进。
   * 让用户先去注册再"碰巧成为第一个管理员"太绕，直接建好并把凭据打在启动日志里。
   */
  readonly bootstrapAdminUsername: string;
  /**
   * 首次启动管理员的密码。不设就**随机生成**（并写进日志与 /data/initial-admin.txt）。
   *
   * 不默认给一个固定密码（如 admin123）是因为：容器一起来端口就暴露，
   * 固定密码等于在用户改密码之前把管理页交给所有人。
   */
  readonly bootstrapAdminPassword: string | null;
  /**
   * 对外访问地址（`PUBLIC_URL`，如 `https://chat.example.com`）。
   *
   * 启动日志里要告诉用户"管理页在哪"。容器内部看不到宿主机的对外地址，
   * 所以要么显式给，要么由服务端枚举本机网卡地址猜一个（可能不准，但比只报
   * 127.0.0.1 有用）。
   */
  readonly publicUrl: string | null;
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

/** 非负整数（0 有特殊含义，如"永不删除"）。 */
function optionalInt0(env: Env, key: string, fallback: number): number {
  const raw = env[key];
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) {
    throw new ConfigError(`环境变量 ${key} 必须是非负整数，收到 "${raw}"。`);
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
    hostOwnerId: env['HOST_OWNER_ID']?.trim() || null,
    toolAlertUserIds: (env['TOOL_ALERT_USER_IDS'] ?? '')
      .split(',')
      .map((o) => o.trim())
      .filter((o) => o !== ''),
    auditRetentionDays: optionalInt0(env, 'AUDIT_RETENTION_DAYS', 180),
    bootstrapAdminUsername: env['BOOTSTRAP_ADMIN_USERNAME']?.trim() || 'admin',
    bootstrapAdminPassword: env['BOOTSTRAP_ADMIN_PASSWORD']?.trim() || null,
    publicUrl: env['PUBLIC_URL']?.trim() || null,
  };
}
