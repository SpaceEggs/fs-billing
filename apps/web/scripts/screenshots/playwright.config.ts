import { defineConfig } from '@playwright/test';
import base from '../../playwright.config';

/** 截图复用 e2e 的真实 API、预览服务器和种子凭据初始化。 */
export default defineConfig({
  ...base,
  testDir: '.',
  testMatch: 'capture.spec.ts',
  globalSetup: '../../e2e/global-setup.ts',
  reporter: 'list',
  timeout: 120_000,
  use: { ...base.use, actionTimeout: 15_000 },
});
