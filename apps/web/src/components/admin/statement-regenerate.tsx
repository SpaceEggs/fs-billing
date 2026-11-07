import { useTranslation } from 'react-i18next';
import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { TriangleAlertIcon } from 'lucide-react';
import type {
  AdminStatementRegenerateResponse,
  Currency,
} from '@fs-billing/shared';
import { useApiMutation } from '../../lib/admin-api';
import { apiProblem } from '../../lib/api-problem';
import { formatDateTime } from '../../lib/format';
import { statementMonthTitle } from '../../lib/statement';
import { cn } from '../../lib/utils';
import { useLocale } from '../../i18n';
import { formatMinutes } from '../cdr/cdr-format';
import { Money } from '../data-format';
import { Alert, AlertDescription, AlertTitle } from '../ui/alert';
import { Button } from '../ui/button';
import { ModalDialog } from '../modal-dialog';
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
  const { t } = useTranslation(['admin']);
  const locale = useLocale();
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
    ? t('admin:statement.regenerateDialog.title', {
        code: target.tenantCode,
        month: statementMonthTitle(target.month, locale),
      })
    : t('admin:statement.regenerateDialog.titlePlain');
  const money = (amount: string) =>
    target ? { currency: target.currency, amount } : null;
  return (
    <ModalDialog
      open={target !== null}
      {...(regenerate.isPending
        ? {}
        : { onOpenChange: (open) => open || close() })}
      title={title}
      description={t('admin:statement.regenerateDialog.description')}
      plainOnDesktop
      className="md:w-[500px]"
    >
      <div className="flex flex-col gap-1.5">
        <h2 className="m-0 text-[17px] font-semibold">{title}</h2>
        <span className="text-sm leading-relaxed text-muted-foreground">
          {target?.current
            ? t('admin:statement.regenerateDialog.bodyCurrent')
            : t('admin:statement.regenerateDialog.bodyMissing')}
        </span>
      </div>
      {target?.current ? (
        <dl className="m-0 grid grid-cols-[120px_1fr] border-t border-border text-sm tabular-nums">
          <Row label={t('admin:statement.regenerateDialog.callCharges')}>
            <Money value={money(target.current.callCharges)!} tone="plain" /> ·{' '}
            {formatMinutes(target.current.callMinutes, locale)}
          </Row>
          <Row label={t('admin:statement.regenerateDialog.closingBalance')}>
            <Money value={money(target.current.closingBalance)!} />
          </Row>
          <Row label={t('admin:statement.regenerateDialog.generatedAt')}>
            {formatDateTime(target.current.generatedAt, locale)}
          </Row>
        </dl>
      ) : null}
      <div className="rounded-lg border border-brand-border bg-brand-soft px-3 py-2.5 text-[13px] leading-normal">
        {t('admin:statement.regenerateDialog.portalNote')}
      </div>
      {regenerate.error ? (
        <ProblemAlert
          error={regenerate.error}
          networkMessage={t('admin:statement.regenerateDialog.network')}
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
          {conflicted
            ? t('admin:statement.regenerateDialog.close')
            : t('admin:statement.regenerateDialog.cancel')}
        </Button>
        <Button
          className="h-12 md:h-9"
          disabled={regenerate.isPending || conflicted}
          onClick={() => void confirm()}
        >
          {regenerate.isPending
            ? t('admin:statement.regenerateDialog.regenerating')
            : t('admin:statement.regenerateDialog.regenerate')}
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
  const { t } = useTranslation(['admin']);
  const locale = useLocale();
  const { result, tenantCode, tenantId, currency } = outcome;
  const month = statementMonthTitle(result.month, locale);
  const money = (amount: string) => ({ currency, amount });
  const summary = result.created ? (
    <>
      {t('admin:statement.regenerateDialog.created', {
        code: tenantCode,
        month,
        version: result.after.version,
      })}
    </>
  ) : result.changed && result.before ? (
    <>
      {t('admin:statement.regenerateDialog.changedIntro', {
        code: tenantCode,
        month,
        version: result.after.version,
      })}
      {t('admin:statement.regenerateDialog.changedCallCharges')}{' '}
      <Money value={money(result.before.callCharges)} tone="plain" /> →{' '}
      <Money value={money(result.after.callCharges)} tone="plain" />
      {t('admin:statement.regenerateDialog.changedSeparator')}
      {t('admin:statement.regenerateDialog.changedClosingBalance')}{' '}
      <Money value={money(result.before.closingBalance)} tone="plain" /> →{' '}
      <Money value={money(result.after.closingBalance)} tone="plain" />
      {t('admin:statement.regenerateDialog.changedSuffix')}
    </>
  ) : (
    <>
      {t('admin:statement.regenerateDialog.unchanged', {
        code: tenantCode,
        month,
        version: result.after.version,
      })}
    </>
  );
  return (
    <div className={cn('flex flex-col gap-2', className)}>
      <Alert
        variant={result.changed || result.created ? 'success' : 'muted'}
        role="status"
        className={cn(
          'flex-row items-start justify-between gap-3 px-3.5',
          !(result.changed || result.created) && 'text-muted-foreground',
        )}
      >
        <span>{summary}</span>
        <Button
          variant="link"
          className="h-auto shrink-0 p-0 text-[13px] font-normal text-current"
          onClick={onDismiss}
        >
          {t('admin:statement.regenerateDialog.know')}
        </Button>
      </Alert>
      {result.staleFollowingMonths.length > 0 ? (
        <Alert variant="warning" role="alert">
          <TriangleAlertIcon aria-hidden />
          <AlertTitle>
            {t('admin:statement.regenerateDialog.staleTitle')}
          </AlertTitle>
          <AlertDescription className="block">
            {t('admin:statement.regenerateDialog.stalePrefix', {
              code: tenantCode,
            })}
            {result.staleFollowingMonths.map((stale, index) => (
              <span key={stale}>
                {index > 0
                  ? t('admin:statement.regenerateDialog.monthSeparator')
                  : ''}
                <Link
                  to="/admin/tenants/$tenantId"
                  params={{ tenantId }}
                  search={{ tab: 'statements', statementMonth: stale }}
                  className="underline"
                >
                  {statementMonthTitle(stale, locale)}
                </Link>
              </span>
            ))}
            {t('admin:statement.regenerateDialog.staleSuffix')}
          </AlertDescription>
        </Alert>
      ) : null}
    </div>
  );
}
