import { defineConfig } from 'drizzle-kit';

/**
 * `pnpm --filter @agentlink/server db:generate` 生成 SQL 迁移（数据模型 §7）。
 * 迁移文件只增不改。
 */
export default defineConfig({
  dialect: 'sqlite',
  schema: './src/db/schema.ts',
  out: './drizzle',
  strict: true,
  verbose: true,
});
