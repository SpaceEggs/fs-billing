import { useQuery } from '@tanstack/react-query';
import type { AdminStatus } from '@fs-billing/shared';
import { DateTime } from '../../../components/data-format';
import { QueryError } from '../../../components/query-error';
import { apiQuery } from '../../../lib/admin-api';
import { cn } from '../../../lib/utils';

const accountStatus = {
  active: { label: '启用', className: 'border-ok-border bg-ok-soft text-ok' },
  disabled: {
    label: '已停用',
    className: 'border-off-border bg-off-soft text-off',
  },
} as const satisfies Record<AdminStatus, { label: string; className: string }>;

/** 门户账号（设计稿第三批 1j/1k）：第一版每个租户一个账号；账号操作随后续交付。 */
export function PortalTab({
  tenantId,
  tenantDisabled,
}: {
  tenantId: string;
  tenantDisabled: boolean;
}) {
  const accounts = useQuery(
    apiQuery('adminPortalAccounts', { params: { tenantId } }),
  );
  if (accounts.isError)
    return (
      <QueryError
        title="门户账号加载失败"
        error={accounts.error}
        retrying={accounts.isFetching}
        onRetry={() => void accounts.refetch()}
      />
    );
  if (!accounts.data)
    return (
      <div
        aria-busy
        aria-label="门户账号加载中"
        className="h-[180px] max-w-[760px] animate-pulse rounded-xl bg-skeleton"
      />
    );
  const account = accounts.data.items[0];
  return (
    <div className="flex max-w-[760px] flex-col gap-3.5">
      {tenantDisabled ? (
        <div
          role="note"
          className="rounded-lg border border-off-border bg-off-soft px-3.5 py-2.5 text-[13px] leading-normal"
        >
          <span className="font-semibold">租户已停用</span>
          ，客户暂时无法登录客户门户。门户账号本身的状态不受影响，租户启用后即可恢复登录。
        </div>
      ) : null}
      {account?.status === 'disabled' ? (
        <div
          role="note"
          className="rounded-lg border border-off-border bg-off-soft px-3.5 py-2.5 text-[13px] leading-normal"
        >
          <span className="font-semibold">门户账号已停用</span>
          ，客户无法登录客户门户。呼叫与计费不受影响。
        </div>
      ) : null}
      <section
        aria-label="客户门户账号"
        className="rounded-xl border border-border"
      >
        <div className="flex flex-col gap-1 border-b border-border px-5 py-4">
          <span className="text-[15px] font-semibold">客户门户账号</span>
          <span className="text-xs text-muted-foreground">
            第一版每个租户一个门户账号
          </span>
        </div>
        {account ? (
          <dl className="m-0 grid grid-cols-[112px_1fr] px-5 pt-1 pb-2 text-sm tabular-nums md:grid-cols-[140px_1fr]">
            <dt className="border-b border-border py-3 text-muted-foreground">
              登录邮箱
            </dt>
            <dd className="m-0 border-b border-border py-3 break-all">
              {account.email}
            </dd>
            <dt className="border-b border-border py-3 text-muted-foreground">
              状态
            </dt>
            <dd className="m-0 border-b border-border py-2.5">
              <span
                className={cn(
                  'inline-flex h-[22px] items-center rounded-md border px-2 text-xs font-medium',
                  accountStatus[account.status].className,
                )}
              >
                {accountStatus[account.status].label}
              </span>
            </dd>
            <dt className="border-b border-border py-3 text-muted-foreground">
              最后登录时间
            </dt>
            <dd className="m-0 border-b border-border py-3">
              {account.lastLoginAt ? (
                <DateTime value={account.lastLoginAt} />
              ) : (
                <span className="text-muted-foreground">从未登录</span>
              )}
            </dd>
            <dt className="py-3 text-muted-foreground">开通时间</dt>
            <dd className="m-0 py-3">
              <DateTime value={account.createdAt} />
            </dd>
          </dl>
        ) : (
          <div className="flex flex-col items-center gap-2 px-5 py-12 text-center">
            <span className="text-[15px] font-semibold">尚未开通门户账号</span>
            <span className="text-[13px] text-muted-foreground">
              开通后客户可登录客户门户查看余额、流水和话单
            </span>
          </div>
        )}
      </section>
    </div>
  );
}
