import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import Decimal from 'decimal.js';
import type {
  AdminTenantDetailResponse,
  AdminTenantStatementResponse,
} from '@fs-billing/shared';
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
import {
  reconcileNote,
  regenerateReasons,
} from '../../../lib/admin-statements';
import {
  fillDays,
  nextMonthFirstDay,
  statementMonthRange,
  statementMonthTitle,
  statementPeriodLabel,
} from '../../../lib/statement';

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
        ‹ 返回账单列表
      </Link>
      {outcome ? (
        <RegenerateNotice
          outcome={outcome}
          onDismiss={() => setOutcome(null)}
          className="print:hidden"
        />
      ) : null}
      <RefreshError title="账单刷新失败，数据可能不是最新" query={detail} />
      {detail.data ? (
        <Detail
          tenant={tenant}
          statement={detail.data}
          onRegenerate={setTarget}
        />
      ) : detail.isError ? (
        <QueryError
          title="账单加载失败"
          error={detail.error}
          retrying={detail.isFetching}
          onRetry={() => void detail.refetch()}
        />
      ) : (
        <div
          aria-busy
          aria-label="账单加载中"
          className="h-[240px] animate-pulse rounded-xl bg-skeleton"
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
) {
  switch (reconcile.status) {
    case 'unchecked':
      return '尚未核对';
    case 'ok':
      return '已核对，与流水一致';
    case 'stale':
    case 'inconsistent':
      return reconcileNote(reconcile.status);
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
      <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between md:gap-6">
        <div className="flex flex-col gap-2">
          <div className="flex items-center gap-2.5">
            <h2 className="m-0 text-[22px] font-semibold tracking-[-0.01em]">
              {statementMonthTitle(month)}
            </h2>
            <StatementStateTag state={state} size="lg" />
          </div>
          <div className="flex flex-wrap gap-x-3.5 gap-y-1 text-[13px] text-muted-foreground tabular-nums">
            <span className="text-foreground">{statement.tenant.name}</span>
            <span className="font-mono">{statement.tenant.code}</span>
            <span>币种 {currency}</span>
            <span>{statementPeriodLabel(period, state)}</span>
          </div>
        </div>
        <div className="flex flex-col gap-2 md:items-end">
          <div className="flex flex-col gap-2 md:flex-row print:hidden">
            {exportButton('导出 CSV（汇总）', summaryExport)}
            {exportButton(
              '导出 CSV（该月话单明细）',
              cdrExport,
              statement.detailsDeleted,
              statement.detailsDeleted ? '该月话单明细已删除' : undefined,
            )}
            <Button
              variant="outline"
              className="max-md:h-11 max-md:w-full"
              onClick={() => window.print()}
            >
              打印
            </Button>
            <RegenerateButton
              allowed={statement.regenerable.allowed}
              reason={reason}
              label={`重新生成 ${statementMonthTitle(month)}`}
              className="h-9 max-md:h-11 max-md:w-full"
              onClick={() => onRegenerate(target)}
            />
          </div>
          <span className="text-xs text-muted-foreground">
            {statement.asOf
              ? `数据截至 ${formatDateTime(statement.asOf)} · 实时计算`
              : statement.generatedAt
                ? `账单生成于 ${formatDateTime(statement.generatedAt)}`
                : null}
          </span>
          {reason ? (
            <span className="text-xs text-muted-foreground print:hidden">
              {regenerateReasons[reason]}
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
        <div className="flex flex-col gap-0.5 rounded-[10px] border border-off-border bg-off-soft px-4 py-3 text-sm md:flex-row md:items-center md:gap-2.5">
          <span className="font-semibold">该月话单明细已删除</span>
          <span className="text-muted-foreground">
            账单汇总不受影响，但无法再导出该月话单明细，也无法重新生成账单。
          </span>
        </div>
      ) : null}
      {state === 'in_progress' ? (
        <p className="m-0 text-[13px] text-muted-foreground">
          本月尚未结束，以下数据截至今日并实时更新；{nextMonthFirstDay(month)}{' '}
          凌晨生成正式账单。
        </p>
      ) : null}
      {state === 'pending' ? (
        <p className="m-0 text-[13px] text-muted-foreground">
          该月账单尚未生成，以下数据由当前流水和话单实时计算；点「重新生成」可补建正式账单。
        </p>
      ) : null}
      <AdminFacts statement={statement} />
      <StatementEquation currency={currency} figures={figures} />
      <div className="grid items-start gap-5 md:grid-cols-2 md:gap-6">
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
  const { reconcile, currency } = statement;
  const gap = new Decimal(statement.breakdownGap);
  if (!reconcile && gap.isZero()) return null;
  const diff = reconcile?.diff ?? null;
  return (
    <dl
      aria-label="账单信息"
      className="m-0 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 rounded-xl border border-border px-4 py-3 text-[13px] tabular-nums md:grid-cols-[auto_1fr_auto_1fr] print:hidden"
    >
      {reconcile ? (
        <>
          <dt className="text-muted-foreground">版本</dt>
          <dd className="m-0">
            v{statement.version}
            {statement.firstGeneratedAt &&
            statement.firstGeneratedAt !== statement.generatedAt
              ? `（首次生成 ${formatDateTime(statement.firstGeneratedAt)}）`
              : ''}
          </dd>
          <dt className="text-muted-foreground">生成人</dt>
          <dd className="m-0">
            {statement.generatedBy?.name ?? '系统（定时任务）'}
          </dd>
          <dt className="text-muted-foreground">核对</dt>
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
              {reconcileText(reconcile)}
            </span>
            {diff ? (
              <>
                ，流水合计与期末相差{' '}
                <Money value={{ currency, amount: diff }} exact />
              </>
            ) : null}
            {reconcile.reconciledAt
              ? ` · 核对于 ${formatDateTime(reconcile.reconciledAt)}`
              : ''}
          </dd>
        </>
      ) : null}
      {gap.isZero() ? null : (
        <>
          <dt className="text-muted-foreground">话单差额</dt>
          <dd className="m-0 md:col-span-3">
            话单明细与通话扣费相差{' '}
            <Money value={{ currency, amount: statement.breakdownGap }} exact />
            （通话扣费减各国家费用合计）
          </dd>
        </>
      )}
    </dl>
  );
}
