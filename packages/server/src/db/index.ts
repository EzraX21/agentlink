import Database from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { mkdirSync } from 'node:fs';
import * as schema from './schema.js';

/**
 * 数据库入口。**所有数据库访问必须收敛在 `src/db/` 内**（数据模型 §8），
 * 不得散落到路由代码里 —— 这是将来换 Postgres 时唯一有蔓延性的改动。
 */

const here = dirname(fileURLToPath(import.meta.url));

/** 迁移目录：源码跑 tsx 时在 `drizzle/`，编译后在 `dist/db/` 的上两级。 */
export function migrationsFolder(): string {
  // src/db/index.ts → ../../drizzle；dist/db/index.js → ../../drizzle
  return resolve(here, '../../drizzle');
}

export type Db = BetterSQLite3Database<typeof schema>;

export interface OpenDbOptions {
  readonly path: string;
  readonly autoMigrate?: boolean;
  readonly logger?: { info: (obj: unknown, msg?: string) => void };
}

export interface OpenedDb {
  readonly db: Db;
  readonly raw: Database.Database;
  close(): void;
}

export function openDatabase(opts: OpenDbOptions): OpenedDb {
  if (opts.path !== ':memory:') {
    mkdirSync(dirname(resolve(opts.path)), { recursive: true });
  }

  const raw = new Database(opts.path);

  // 数据模型 §1：WAL + 外键 + busy_timeout
  raw.pragma('journal_mode = WAL');
  raw.pragma('foreign_keys = ON');
  raw.pragma('busy_timeout = 5000');
  // NORMAL 在 WAL 下是"崩溃可能丢最后几个事务、但库不坏"的安全档。
  raw.pragma('synchronous = NORMAL');

  const db = drizzle(raw, { schema });

  if (opts.autoMigrate !== false) {
    migrate(db, { migrationsFolder: migrationsFolder() });
    opts.logger?.info({ path: opts.path }, 'migrations applied');
  }

  // FTS5 的 'rebuild' 是特殊命令，用 exec 而不是 prepare 执行。
  // 每次启动跑一次很便宜（1 万条量级毫秒级），且能自愈任何索引不一致 ——
  // 比让搜索静静地返回空结果安全得多。
  rebuildFts(raw);

  return {
    db,
    raw,
    close: () => raw.close(),
  };
}

/**
 * 让 FTS5 外部内容表与 messages 表保持一致。
 *
 * `INSERT INTO messages_fts(messages_fts) VALUES('rebuild')` 是 FTS5 的特殊命令，
 * 必须用 exec（cannot be prepared）。代价随消息数线性增长，本规模可接受。
 */
export function rebuildFts(raw: Database.Database): void {
  const hasFts = raw
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='messages_fts'")
    .get();
  if (hasFts === undefined) return;
  try {
    raw.exec("INSERT INTO messages_fts(messages_fts) VALUES('rebuild')");
  } catch {
    // 索引刚创建还没内容时可能报错，不影响正确性（触发器会继续写）
  }
}

export { schema };
export * from './schema.js';
