import type { TenantHealth } from '@fs-billing/shared';
import type { StatusKey } from './status-tag';

/** 租户状态对应的状态标签，后台与门户共用。 */
export const healthStatus = {
  suspended: 'suspended',
  overdraft: 'overdrawn',
  low_balance: 'lowBalance',
  normal: 'normal',
  disabled: 'disabled',
} as const satisfies Record<TenantHealth, StatusKey>;
