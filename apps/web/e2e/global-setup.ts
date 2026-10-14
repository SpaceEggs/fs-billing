import { execFileSync } from 'node:child_process';
import { accounts, password } from './accounts';
import { clearLoginFailures } from './db';
import { apiEnvironment, repoRoot } from './env';

/** 初始化种子凭据（幂等，不覆盖已有密码），并清除上次运行遗留的锁定计数。 */
export default async function globalSetup() {
  password();
  execFileSync('pnpm', ['--filter', '@fs-billing/api', 'auth:seed'], {
    cwd: repoRoot,
    env: apiEnvironment(),
    stdio: 'inherit',
  });
  for (const email of Object.values(accounts)) await clearLoginFailures(email);
}
