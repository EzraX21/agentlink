import { defineConfig } from 'vitest/config';

/**
 * 只跑 `src/` 下的测试。
 *
 * 之前 `dist/` 里也有编译后的 `*.test.js`（tsc 把测试一起编了），vitest 默认把
 * 两份都收进来 —— 每个用例被跑了两遍，而且 dist 那份是**旧代码**：
 * 改了测试还可能"一条过一条挂"，非常误导。
 */
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    exclude: ['dist/**', 'node_modules/**'],
  },
});
