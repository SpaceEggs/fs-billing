import { defineConfig, devices } from '@playwright/test';
import { apiEnvironment, apiOrigin, repoRoot, webOrigin } from './e2e/env';

const ci = Boolean(process.env['CI']);

export default defineConfig({
  testDir: 'e2e',
  globalSetup: './e2e/global-setup.ts',
  // 测试共享真实数据库与账户锁定计数，必须串行。
  workers: 1,
  fullyParallel: false,
  forbidOnly: ci,
  retries: 0,
  reporter: ci ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: webOrigin,
    locale: 'zh-CN',
    timezoneId: 'Asia/Shanghai',
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: [
    {
      command: 'pnpm --filter @fs-billing/api start',
      cwd: repoRoot,
      url: `${apiOrigin}/api/health`,
      env: apiEnvironment(),
      // 不复用已在运行的 API：它未必带 apiEnvironment() 的测试覆盖（如认证限流放宽），
      // 用例会遇到 429。3000 端口被占用时 Playwright 直接报错，请先停掉本地 API。
      reuseExistingServer: false,
      timeout: 60_000,
    },
    {
      command: 'pnpm build && pnpm preview',
      url: webOrigin,
      reuseExistingServer: !ci,
      timeout: 120_000,
    },
  ],
});
