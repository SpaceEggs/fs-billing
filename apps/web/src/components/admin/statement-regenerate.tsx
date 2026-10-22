import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import type {
  AdminStatementRegenerateResponse,
  Currency,
} from '@fs-billing/shared';
import { useApiMutation } from '../../lib/admin-api';
import { apiProblem } from '../../lib/api-problem';
import { formatDateTime } from '../../lib/format';
import { statementMonthTitle } from '../../lib/statement';
import { cn } from '../../lib/utils';
import { formatMinutes } from '../cdr/cdr-format';
import { Money } from '../data-format';
import { Alert } from '../ui/alert';
import { Button } from '../ui/button';
import { ModalDialog } from '../ui/dialog';
import { ProblemAlert } from './problem-alert';

/** 对话框打开时看到的账单；`current` 为 null 表示该月还没有账单行（版本 0，等同补建）。 */
export type RegenerateTarget = {
  tenantId: string;
  tenantCode: string;
  currency: Currency;
  month: string;
  version: number;
  current: {
    callCharges: string;
    callMinutes: string;
    closingBalance: string;
    generatedAt: string;
  } | null;
};

export type RegenerateOutcome = {
  tenantId: string;
  tenantCode: string;
  currency: Currency;
  result: AdminStatementRegenerateResponse;
};

/** 重新生成会改变这些查询的内容：后台账单页、租户账单列表与详情。 */
export function refreshStatements(queryClient: QueryClient) {
  return queryClient.invalidateQueries({
    predicate: ({ queryKey }) =>
      queryKey[0] === 'api' &&
      (queryKey[1] === 'adminStatements' ||
        queryKey[1] === 'adminTenantStatements' ||
        queryKey[1] === 'adminTenantStatement'),
  });
}

/**
 * 重新生成确认（运营稿 5b、租户详情稿 2b/3m）：展示当前通话扣费、期末余额与生成时间，
 * 请求带打开时看到的版本 `expectedVersion`。409（版本已变、话单已删除、月份未结束）说明数据已过时：
 * 立即刷新页面数据，本对话框不再允许提交，关闭后按最新状态重新操作。
 */
export function RegenerateDialog({
  target,
  onClose,
  onDone,
}: {
  target: RegenerateTarget | null;
  onClose: () => void;
  onDone: (outcome: RegenerateOutcome) => void;
}) {
  const queryClient = useQueryClient();
  const regenerate = useApiMutation('adminTenantStatementRegenerate', {
    invalidate: (client) => refreshStatements(client),
  });
  const conflicted =
    regenerate.error !== null &&
    apiProblem(regenerate.error).kind === 'conflict';
  const close = () => {
    regenerate.reset();
    onClose();
  };

  async function confirm() {
    if (!target) return;
    try {
      const result = await regenerate.mutateAsync({
        params: { tenantId: target.tenantId, month: target.month },
        body: { expectedVersion: target.version },
      });
      regenerate.reset();
      onDone({
        tenantId: target.tenantId,
        tenantCode: target.tenantCode,
        currency: target.currency,
        result,
      });
    } catch (error) {
      // 冲突说明页面上的版本或状态已过时，先刷新，让按钮反映最新状态。
      if (apiProblem(error).kind === 'conflict')
        void refreshStatements(queryClient);
    }
  }

  const title = target
    ? `重新生成 ${target.tenantCode} ${statementMonthTitle(target.month)} 账单？`
    : '重新生成账单';
  const money = (amount: string) =>
    target ? { currency: target.currency, amount } : null;
  return (
    <ModalDialog
      open={target !== null}
      {...(regenerate.isPending
        ? {}
        : { onOpenChange: (open) => open || close() })}
      title={title}
      description="按当前话单重新计算该月账单"
      plainOnDesktop
      className="md:w-[500px]"
    >
      <div className="flex flex-col gap-1.5">
        <h2 className="m-0 text-[17px] font-semibold">{title}</h2>
        <span className="text-sm leading-relaxed text-muted-foreground">
          {target?.current
            ? '将按当前话单重新计算该月账单，用于补推话单后更正。'
            : '该月账单尚未生成，将按当前话单与流水生成，等同补建。'}
        </span>
      </div>
      {target?.current ? (
        <dl className="m-0 grid grid-cols-[120px_1fr] border-t border-border text-sm tabular-nums">
          <Row label="当前通话扣费">
            <Money value={money(target.current.callCharges)!} tone="plain" /> ·{' '}
            {formatMinutes(target.current.callMinutes)}
          </Row>
          <Row label="当前期末余额">
            <Money value={money(target.current.closingBalance)!} />
          </Row>
          <Row label="生成于">{formatDateTime(target.current.generatedAt)}</Row>
        </dl>
      ) : null}
      <div className="rounded-lg border border-brand-border bg-brand-soft px-3 py-2.5 text-[13px] leading-normal">
        重新生成后客户门户的月账单同步更新；操作人和前后差异记入操作日志。
      </div>
      {regenerate.error ? (
        <ProblemAlert
          error={regenerate.error}
          networkMessage="无法确认是否已重新生成，请刷新后查看账单版本再操作。"
          onRefresh={() => {
            void refreshStatements(queryClient);
            close();
          }}
        />
      ) : null}
      <div className="flex flex-col-reverse gap-2 md:flex-row md:justify-end">
        <Button
          variant="outline"
          className="h-12 md:h-9"
          disabled={regenerate.isPending}
          onClick={close}
        >
          {conflicted ? '关闭' : '取消'}
        </Button>
        <Button
          className="h-12 md:h-9"
          disabled={regenerate.isPending || conflicted}
          onClick={() => void confirm()}
        >
          {regenerate.isPending ? '正在重新生成…' : '重新生成'}
        </Button>
      </div>
    </ModalDialog>
  );
}

function Row({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <>
      <dt className="border-b border-border py-2.5 text-muted-foreground">
        {label}
      </dt>
      <dd className="m-0 border-b border-border py-2.5">{children}</dd>
    </>
  );
}

/** 一次重新生成的结果与过期的后续月份（决定 28：只处理所选月份，不级联，管理员按顺序逐个处理）。 */
export function RegenerateNotice({
  outcome,
  onDismiss,
  className,
}: {
  outcome: RegenerateOutcome;
  onDismiss: () => void;
  className?: string;
}) {
  const { result, tenantCode, tenantId, currency } = outcome;
  const month = statementMonthTitle(result.month);
  const money = (amount: string) => ({ currency, amount });
  const summary = result.created ? (
    <>
      已生成 {tenantCode} {month} 账单（版本 {result.after.version}
      ），已记入操作日志。
    </>
  ) : result.changed && result.before ? (
    <>
      已重新生成 {tenantCode} {month} 账单（版本 {result.after.version}
      ）：通话扣费{' '}
      <Money value={money(result.before.callCharges)} tone="plain" /> →{' '}
      <Money value={money(result.after.callCharges)} tone="plain" />
      ，期末余额{' '}
      <Money value={money(result.before.closingBalance)} tone="plain" /> →{' '}
      <Money value={money(result.after.closingBalance)} tone="plain" />
      ，已记入操作日志。
    </>
  ) : (
    <>
      {tenantCode} {month} 账单与当前话单一致，没有变化（版本{' '}
      {result.after.version} 不变），已记入操作日志。
    </>
  );
  return (
    <div className={cn('flex flex-col gap-2', className)}>
      <div
        role="status"
        className={cn(
          'flex items-start justify-between gap-3 rounded-lg border px-3.5 py-2.5 text-[13px]',
          result.changed || result.created
            ? 'border-ok-border bg-ok-soft text-ok'
            : 'border-border bg-muted text-muted-foreground',
        )}
      >
        <span>{summary}</span>
        <button
          type="button"
          onClick={onDismiss}
          className="shrink-0 underline-offset-2 hover:underline"
        >
          知道了
        </button>
      </div>
      {result.staleFollowingMonths.length > 0 ? (
        <Alert tone="warn" title="后续月份的账单已过期">
          {tenantCode} 的{' '}
          {result.staleFollowingMonths.map((stale, index) => (
            <span key={stale}>
              {index > 0 ? '、' : ''}
              <Link
                to="/admin/tenants/$tenantId"
                params={{ tenantId }}
                search={{ tab: 'statements', statementMonth: stale }}
                className="underline"
              >
                {statementMonthTitle(stale)}
              </Link>
            </span>
          ))}{' '}
          账单的期初余额已与账本不符。重新生成只处理所选月份，请按月份顺序逐个重新生成。
        </Alert>
      ) : null}
    </div>
  );
}
