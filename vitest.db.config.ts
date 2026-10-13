import { defineConfig } from 'vitest/config';

// 数据库验收测试：需要 PostgreSQL（pnpm db:up），每次在全新的 fs_billing_test 库上运行。
export default defineConfig({
  test: {
    environment: 'node',
    include: ['packages/**/*.db.test.ts', 'apps/**/*.db.test.ts'],
    globalSetup: ['packages/db/test/global-setup.ts'],
    fileParallelism: false,
    testTimeout: 20_000,
    hookTimeout: 60_000,
  },
});
