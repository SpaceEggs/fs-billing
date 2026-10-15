import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));

const rootEnv = `${repoRoot}.env`;
// 已存在的环境变量优先，与 API 的 --env-file-if-exists 行为一致。
if (existsSync(rootEnv)) process.loadEnvFile(rootEnv);

export const apiOrigin = 'http://127.0.0.1:3000';
export const webOrigin = 'http://127.0.0.1:4173';

export function requireEnv(name: string) {
  const value = process.env[name];
  if (!value)
    throw new Error(
      `${name} is required for Playwright runs (see docs/phase-4-web.md)`,
    );
  return value;
}

/** 启动真实 API 所需的环境；会话签名密钥缺省时每次运行随机生成。 */
export function apiEnvironment() {
  return {
    ...process.env,
    NODE_ENV: 'test',
    // Test-only allowance for e2e credential requests sharing loopback.
    AUTH_RATE_LIMIT_TEST_OVERRIDE_MAX: '10000',
    API_HOST: '127.0.0.1',
    API_PORT: '3000',
    BETTER_AUTH_SECRET:
      process.env['BETTER_AUTH_SECRET'] ?? randomBytes(32).toString('hex'),
    BETTER_AUTH_URL: process.env['BETTER_AUTH_URL'] ?? apiOrigin,
    BETTER_AUTH_TRUSTED_ORIGINS: [
      apiOrigin,
      webOrigin,
      'http://127.0.0.1:5173',
    ].join(','),
  };
}
