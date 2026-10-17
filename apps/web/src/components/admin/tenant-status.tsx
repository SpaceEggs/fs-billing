import type { TenantHealth } from '@fs-billing/shared';
import { StatusTag, statusTags, type StatusKey } from '../status-tag';

export const healthStatus = {
  suspended: 'suspended',
  overdraft: 'overdrawn',
  low_balance: 'lowBalance',
  normal: 'normal',
  disabled: 'disabled',
} as const satisfies Record<TenantHealth, StatusKey>;

export const healthOptions = (Object.keys(healthStatus) as TenantHealth[]).map(
  (health) => ({
    value: health,
    label: statusTags[healthStatus[health]].label,
  }),
);

/**
 * 状态标签；存量租户缺少余额提醒设置时另加标记（详情会返回服务内部错误），
 * 不隐藏该租户。
 */
export function TenantStatus({
  health,
  settingsConfigured,
  className,
}: {
  health: TenantHealth;
  settingsConfigured: boolean;
  className?: string;
}) {
  return (
    <span className="inline-flex flex-wrap items-center gap-1.5">
      <StatusTag status={healthStatus[health]} className={className} />
      {settingsConfigured ? null : (
        <StatusTag status="settingsMissing" className={className} />
      )}
    </span>
  );
}
