import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: [
      'apps/**/*.test.ts',
      'packages/**/*.test.ts',
      'tests/**/*.test.ts',
    ],
    // 数据库验收测试需要 PostgreSQL，由 pnpm test:db 运行。
    exclude: ['**/node_modules/**', '**/*.db.test.ts'],
    clearMocks: true,
    coverage: {
      provider: 'v8',
      include: ['packages/rating/src/**/*.ts'],
      exclude: ['**/*.test.ts'],
      reporter: ['text', 'json-summary'],
      thresholds: { lines: 95 },
    },
  },
});
