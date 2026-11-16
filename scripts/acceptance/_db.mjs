#!/usr/bin/env node
/**
 * 直接开库做断言用（M2/M3/M4/M8 需要看表里的真实行数与 seq）。
 * 走 server 包自己的 better-sqlite3 实例，保证与运行期是同一个版本。
 */
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const serverPkg = path.resolve(here, '../../packages/server/package.json');
const requireFromServer = createRequire(serverPkg);

/** @param {string} dbPath */
export function openDb(dbPath) {
  const Database = requireFromServer('better-sqlite3');
  const db = new Database(dbPath, { readonly: false, fileMustExist: true });
  db.pragma('busy_timeout = 5000');
  return db;
}

export function count(db, sql, ...params) {
  const row = db.prepare(sql).get(...params);
  return row ? Number(Object.values(row)[0]) : 0;
}
