import { cn } from '@/lib/utils';
import { Card } from '@/components/ui/card';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import Decimal from 'decimal.js';
import {
  translate,
  type AdminTenantDetailResponse,
  type AdminTenantStatementResponse,
  type Locale,
} from '@fs-billing/shared';
import { Skeleton } from '../../../components/ui/skeleton';
import { Alert } from '../../../components/ui/alert';
import {
  RegenerateDialog,
  RegenerateNotice,
  type RegenerateOutcome,
  type RegenerateTarget,
} from '../../../components/admin/statement-regenerate';
import { RegenerateButton } from '../../../components/admin/statement-parts';
import {
  CdrExportButton,
  CdrExportError,
  useCdrExport,
} from '../../../components/cdr/cdr-export';
import { Money } from '../../../components/data-format';
import { QueryError, RefreshError } from '../../../components/query-error';
import { StatementCountries } from '../../../components/statement/country-table';
import { StatementDays } from '../../../components/statement/day-table';
import { StatementEquation } from '../../../components/statement/statement-equation';
import { StatementStateTag } from '../../../components/statement/state-tag';
import { Button } from '../../../components/ui/button';
import { apiQuery } from '../../../lib/admin-api';
import { callDownload } from '../../../lib/api';
import { cdrListQuery } from '../../../lib/cdr-search';
import { formatDateTime } from '../../../lib/format';
import { reconcileNote, regenerateReason } from '../../../lib/admin-statements';
import {
  fillDays,
  nextMonthFirstDay,
  statementMonthRange,
  statementMonthTitle,
  statementPeriodLabel,
} from '../../../lib/statement';
import { useLocale } from '../../../i18n';

/**
 * 某个月的账单详情（与门户同一套汇总、国家表、日表，另有版本、生成人、核对状态与话单差额）：
 * 导出汇总 CSV、导出该月话单明细 CSV、打印、重新生成。
 */
export function StatementDetailView({
  tenant,
  month,
}: {
  tenant: AdminTenantDetailResponse;
  month: string;
}) {
  const { t } = useTranslation(['tenant']);
  const detail = useQuery(
    apiQuery('adminTenantStatement', {
      params: { tenantId: tenant.id, month },
    }),
  );
  const [target, setTarget] = useState<RegenerateTarget | null>(null);
  const [outcome, setOutcome] = useState<RegenerateOutcome | null>(null);
  return (
    <div className="flex flex-col gap-4">
      <Link
        to="/admin/tenants/$tenantId"
        params={{ tenantId: tenant.id }}
        search={{ tab: 'statements' }}
        className="self-start text-sm text-primary print:hidden"
      >
        {t('tenant:statementDetail.back')}
      </Link>
      {outcome ? (
        <RegenerateNotice
          outcome={outcome}
          onDismiss={() => setOutcome(null)}
          className="print:hidden"
        />
      ) : null}
      <RefreshError
        title={t('tenant:statementDetail.refreshFailed')}
        query={detail}
      />
      {detail.data ? (
        <Detail
          tenant={tenant}
          statement={detail.data}
          onRegenerate={setTarget}
        />
      ) : detail.isError ? (
        <QueryError
          title={t('tenant:statementDetail.loadFailed')}
          error={detail.error}
          retrying={detail.isFetching}
          onRetry={() => void detail.refetch()}
        />
      ) : (
        <Skeleton
          aria-busy
          aria-label={t('tenant:statementDetail.loading')}
          className="h-[240px] rounded-xl"
        />
      )}
      <RegenerateDialog
        target={target}
        onClose={() => setTarget(null)}
        onDone={(done) => {
          setTarget(null);
          setOutcome(done);
        }}
      />
    </div>
  );
}

function reconcileText(
  reconcile: NonNullable<AdminTenantStatementResponse['reconcile']>,
  locale: Locale,
) {
  switch (reconcile.status) {
    case 'unchecked':
      return translate(locale, 'tenant:statementDetail.unchecked');
    case 'ok':
      return translate(locale, 'tenant:statementDetail.checked');
    case 'stale':
    case 'inconsistent':
      return reconcileNote(reconcile.status, locale);
  }
}

function Detail({
  tenant,
  statement,
  onRegenerate,
}: {
  tenant: AdminTenantDetailResponse;
  statement: AdminTenantStatementResponse;
  onRegenerate: (target: RegenerateTarget) => void;
}) {
  const { currency, month, state, period, figures } = statement;
  const { t } = useTranslation(['tenant', 'statement']);
  const locale = useLocale();
  const tenantId = tenant.id;
  const summaryExport = useCdrExport(
    () =>
      callDownload('adminTenantStatementExport', {
        params: { tenantId, month },
        body: {},
      }),
    `summary:${month}`,
  );
  // 明细 CSV 复用话单导出：该月 1 日到月末（进行中月份到今天），只含已接通话单。
  const detailQuery = cdrListQuery(
    { from: statementMonthRange(month).from, to: period.to },
    {},
  );
  const cdrExport = useCdrExport(
    () =>
      callDownload('adminTenantCdrsExport', {
        params: { tenantId },
        body: detailQuery,
      }),
    `cdrs:${month}`,
  );
  const days = fillDays(period, statement.days);
  const target: RegenerateTarget = {
    tenantId,
    tenantCode: tenant.code,
    currency,
    month,
    version: statement.version,
    current:
      state === 'final' && statement.generatedAt
        ? {
            callCharges: figures.callCharges,
            callMinutes: figures.callMinutes,
            closingBalance: figures.closingBalance,
            generatedAt: statement.generatedAt,
          }
        : null,
  };
  const reason = statement.regenerable.reason;
  const exportButton = (
    label: string,
    exporter: typeof summaryExport,
    disabled = false,
    title?: string,
  ) => (
    <CdrExportButton
      label={label}
      exporting={exporter.isPending}
      disabled={disabled}
      onExport={() => exporter.mutate()}
      {...(title ? { title } : {})}
      className="max-md:h-11 max-md:w-full"
    />
  );
  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-3 md:gap-6 xl:flex-row xl:items-start xl:justify-between">
        <div className="flex flex-col gap-2">
          <div className="flex items-center gap-2.5">
            <h2 className="m-0 whitespace-nowrap text-[22px] font-semibold tracking-[-0.01em]">
              {statementMonthTitle(month, locale)}
            </h2>
            <StatementStateTag state={state} size="lg" />
          </div>
          <div className="flex flex-wrap gap-x-3.5 gap-y-1 text-[13px] text-muted-foreground tabular-nums">
            <span className="text-foreground">{statement.tenant.name}</span>
            <span className="font-mono">{statement.tenant.code}</span>
            <span>{t('tenant:statementDetail.currency', { currency })}</span>
            <span>{statementPeriodLabel(period, state, locale)}</span>
          </div>
        </div>
        <div className="flex flex-col gap-2 xl:items-end">
          <div className="flex flex-col gap-2 md:flex-row md:flex-wrap print:hidden">
            {exportButton(
              t('tenant:statementDetail.exportSummary'),
              summaryExport,
            )}
            {exportButton(
              t('tenant:statementDetail.exportDetails'),
              cdrExport,
              statement.detailsDeleted,
              statement.detailsDeleted
                ? t('tenant:statementDetail.detailsDeletedTitle')
                : undefined,
            )}
            <Button
              variant="outline"
              className="max-md:h-11 max-md:w-full"
              onClick={() => window.print()}
            >
              {t('tenant:statementDetail.print')}
            </Button>
            <RegenerateButton
              allowed={statement.regenerable.allowed}
              reason={reason}
              label={t('tenant:statements.regenerateFor', {
                month: statementMonthTitle(month, locale),
              })}
              className="h-9 max-md:h-11 max-md:w-full"
              onClick={() => onRegenerate(target)}
            />
          </div>
          <span className="text-xs text-muted-foreground">
            {statement.asOf
              ? t('tenant:statementDetail.asOf', {
                  time: formatDateTime(statement.asOf, locale),
                })
              : statement.generatedAt
                ? t('tenant:statementDetail.generatedAt', {
                    time: formatDateTime(statement.generatedAt, locale),
                  })
                : null}
          </span>
          {reason ? (
            <span className="text-xs text-muted-foreground print:hidden">
              {regenerateReason(reason, locale)}
            </span>
          ) : null}
        </div>
      </div>
      <div className="print:hidden">
        <CdrExportError
          error={summaryExport.error ?? cdrExport.error}
          retrying={summaryExport.isPending || cdrExport.isPending}
          onRetry={() =>
            summaryExport.isError ? summaryExport.mutate() : cdrExport.mutate()
          }
        />
      </div>
      {statement.detailsDeleted ? (
        <Alert
          variant="muted"
          className="rounded-[10px] px-4 py-3 text-sm md:flex-row md:items-center md:gap-2.5"
        >
          <span className="font-semibold">
            {t('tenant:statementDetail.detailsDeletedTitle')}
          </span>
          <span className="text-muted-foreground">
            {t('tenant:statementDetail.detailsDeletedBody')}
          </span>
        </Alert>
      ) : null}
      {state === 'in_progress' ? (
        <p className="m-0 text-[13px] text-muted-foreground">
          {t('tenant:statementDetail.inProgressNote', {
            date: nextMonthFirstDay(month),
          })}
        </p>
      ) : null}
      {state === 'pending' ? (
        <p className="m-0 text-[13px] text-muted-foreground">
          {t('tenant:statementDetail.pendingNote')}
        </p>
      ) : null}
      <AdminFacts statement={statement} />
      <StatementEquation currency={currency} figures={figures} />
      <div className="grid items-start gap-5 md:gap-6 xl:grid-cols-2">
        <StatementCountries
          currency={currency}
          countries={statement.countries}
          figures={figures}
        />
        <StatementDays
          currency={currency}
          days={days}
          figures={figures}
          today={state === 'in_progress' ? period.to : undefined}
        />
      </div>
    </div>
  );
}

/** 管理员信息块：版本、生成人、核对状态，以及话单明细与通话扣费不等时的差额一行。 */
function AdminFacts({
  statement,
}: {
  statement: AdminTenantStatementResponse;
}) {
  const { t } = useTranslation(['tenant']);
  const locale = useLocale();
  const { reconcile, currency } = statement;
  const gap = new Decimal(statement.breakdownGap);
  if (!reconcile && gap.isZero()) return null;
  const diff = reconcile?.diff ?? null;
  return (
    <Card
      asChild
      className={cn(
        'block gap-0 bg-transparent py-0 text-inherit shadow-none',
        'm-0 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 rounded-xl border border-border px-4 py-3 text-[13px] tabular-nums md:grid-cols-[auto_1fr_auto_1fr] print:hidden',
      )}
    >
      <dl aria-label={t('tenant:statementDetail.factsAria')}>
        {reconcile ? (
          <>
            <dt className="text-muted-foreground">
              {t('tenant:statementDetail.version')}
            </dt>
            <dd className="m-0">
              v{statement.version}
              {statement.firstGeneratedAt &&
              statement.firstGeneratedAt !== statement.generatedAt
                ? t('tenant:statementDetail.firstGenerated', {
                    time: formatDateTime(statement.firstGeneratedAt, locale),
                  })
                : ''}
            </dd>
            <dt className="text-muted-foreground">
              {t('tenant:statementDetail.generatedBy')}
            </dt>
            <dd className="m-0">
              {statement.generatedBy?.name ??
                t('tenant:statementDetail.system')}
            </dd>
            <dt className="text-muted-foreground">
              {t('tenant:statementDetail.reconcile')}
            </dt>
            <dd className="m-0 md:col-span-3">
              <span
                className={
                  reconcile.status === 'inconsistent'
                    ? 'font-medium text-neg'
                    : reconcile.status === 'stale'
                      ? 'font-medium text-warn'
                      : undefined
                }
              >
                {reconcileText(reconcile, locale)}
              </span>
              {diff ? (
                <>
                  {t('tenant:statementDetail.reconcileDiffPrefix')}
                  <Money value={{ currency, amount: diff }} exact />
                </>
              ) : null}
              {reconcile.reconciledAt
                ? t('tenant:statementDetail.reconciledAt', {
                    time: formatDateTime(reconcile.reconciledAt, locale),
                  })
                : ''}
            </dd>
          </>
        ) : null}
        {gap.isZero() ? null : (
          <>
            <dt className="text-muted-foreground">
              {t('tenant:statementDetail.breakdownGap')}
            </dt>
            <dd className="m-0 md:col-span-3">
              {t('tenant:statementDetail.breakdownGapPrefix')}
              <Money
                value={{ currency, amount: statement.breakdownGap }}
                exact
              />
              {t('tenant:statementDetail.breakdownGapSuffix')}
            </dd>
          </>
        )}
      </dl>
    </Card>
  );
}
