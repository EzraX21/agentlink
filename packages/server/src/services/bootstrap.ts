import { randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Config } from '../config.js';
import type { Db } from '../db/index.js';
import { adminStats, insertAudit, insertUser } from '../db/queries.js';
import { hashPassword } from '../auth/crypto.js';
import { newId, nowMs } from '../ids.js';

/**
 * 首次启动的自动初始化：建管理员账号 + 把凭据留在数据目录里。
 *
 * ## 为什么需要
 *
 * 一键启动的容器里一个账号都没有，而管理页要管理员才能进。让用户先去
 * `http://host` 上"注册一个，正好是第一个所以成了管理员"——这个隐含规则
 * 没人知道，日志里也不说，体验很差。
 *
 * 所以：库里没有人类账号时，直接建一个管理员，把用户名/密码打进启动日志，
 * 并写一份到数据目录（`initial-admin.txt`，权限 0600），方便事后查看。
 *
 * ## 为什么密码是随机的
 *
 * 容器一起来端口就通了，如果默认密码是 `admin`/`admin123` 这类，
 * 等于在用户看到日志之前把管理页交给任何能访问端口的人。
 * 随机生成 + 只出现在本机日志/文件里，风险小得多。
 *
 * 用户可以用 `BOOTSTRAP_ADMIN_PASSWORD` 指定（自动化部署/CI 用）。
 */

export interface BootstrapResult {
  /** 这次启动是否新建了管理员。 */
  created: boolean;
  /** 新建时的用户名与明文密码（后续启动为 null）。 */
  username: string | null;
  password: string | null;
  /** 凭据文件路径（写成功时才有）。 */
  credentialsPath: string | null;
}

/**
 * 生成好念又够随机的密码：去掉容易混淆的 0/O/1/l/I。
 *
 * **保证四类字符各至少一个**（小写/大写/数字）。只从统一字母表里抽的话，
 * 16 位里一个数字都没有的概率约 1/17 —— 那样这个密码就过不了
 * "必须含数字"这类常见策略，用户还得自己再改一次（验收里真的遇到过）。
 */
function generatePassword(length = 16): string {
  const lower = 'abcdefghijkmnopqrstuvwxyz';
  const upper = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  const digits = '23456789';
  const all = lower + upper + digits;

  // 先各取一个，保证类别齐全；剩下的从全表抽
  const pick = (set: string): string => set[randomBytes(1)[0]! % set.length]!;
  const chars = [pick(lower), pick(upper), pick(digits)];
  while (chars.length < length) chars.push(pick(all));

  // 洗牌：不然前三位的类别是固定的（小-大-数），可预测
  for (let i = chars.length - 1; i > 0; i -= 1) {
    // 用 2 字节降低取模偏差
    const r = ((randomBytes(2)[0]! << 8) | randomBytes(1)[0]!) % (i + 1);
    [chars[i], chars[r]] = [chars[r]!, chars[i]!];
  }
  return chars.join('');
}

/**
 * 库里还有没有人类账号。
 *
 * 只看 `kind='human'`：agent 不算"已经有人用了"，
 * 否则一个只有 agent 的库里永远不会建管理员。
 */
function hasHumanUser(db: Db): boolean {
  return adminStats(db).humans > 0;
}

export async function bootstrapAdmin(db: Db, config: Config): Promise<BootstrapResult> {
  if (hasHumanUser(db)) {
    return { created: false, username: null, password: null, credentialsPath: null };
  }

  const username = config.bootstrapAdminUsername;
  const password = config.bootstrapAdminPassword ?? generatePassword();
  const id = newId('u');

  insertUser(db, {
    id,
    tenantId: 'default',
    kind: 'human',
    username,
    displayName: '管理员',
    passwordHash: await hashPassword(password),
    isAdmin: 1,
    createdAt: nowMs(),
  });

  // 记一条审计：事后能追"这个账号是什么时候由谁建的"（这里是系统建的）
  insertAudit(db, {
    id: newId('e'),
    tenantId: 'default',
    actorId: id,
    action: 'admin.bootstrap',
    targetType: 'user',
    targetId: id,
    detail: JSON.stringify({ username, generated_password: config.bootstrapAdminPassword === null }),
    createdAt: nowMs(),
  });

  // 凭据留档：用户错过启动日志时可以 `docker exec cat` 查
  let credentialsPath: string | null = null;
  try {
    const dir = dirname(config.databasePath);
    mkdirSync(dir, { recursive: true });
    credentialsPath = join(dir, 'initial-admin.txt');
    writeFileSync(
      credentialsPath,
      [
        'AgentLink 初始管理员凭据',
        '',
        `用户名：${username}`,
        `密码：  ${password}`,
        '',
        '登录后请在管理页里改掉这个密码（引导向导第一步就是它）。',
        '删掉本文件不会影响账号，只是以后查不到这串密码了。',
        '',
      ].join('\n'),
      { mode: 0o600 },
    );
  } catch {
    // 写不了文件不该挡住启动：凭据还在日志里
    credentialsPath = null;
  }

  return { created: true, username, password, credentialsPath };
}
