import { execFileSync } from 'node:child_process';
import { accounts, password } from './accounts';
import {
  assertSeededMonth,
  clearLoginFailures,
  waitPastMonthOpeningSecond,
} from './db';
import { apiEnvironment, repoRoot } from './env';

/** 初始化种子凭据（幂等，不覆盖已有密码），并清除上次运行遗留的锁定计数。 */
export default async function globalSetup() {
  password();
  // 先等、再核对 pnpm db:seed 写下的月份。auth:seed 会再播种，不能放在核对前面，否则跨月的库会被悄悄补上当月组。
  await waitPastMonthOpeningSecond();
  await assertSeededMonth();
  execFileSync('pnpm', ['--filter', '@fs-billing/api', 'auth:seed'], {
    cwd: repoRoot,
    env: apiEnvironment(),
    stdio: 'inherit',
  });
  for (const email of Object.values(accounts)) await clearLoginFailures(email);
}
