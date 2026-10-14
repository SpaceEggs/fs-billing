import { requireEnv } from './env';

export const password = () => requireEnv('SEED_AUTH_PASSWORD');

/** 种子账号（packages/db/src/seed.ts）。 */
export const accounts = {
  customer: 'abc001@example.com',
  usdCustomer: 'glb009@example.com',
  disabledCustomer: 'cdt018@example.com',
  lockTarget: 'hzx014@example.com',
  admin: 'wangmin@example.com',
  secondAdmin: 'lijun@example.com',
} as const;
