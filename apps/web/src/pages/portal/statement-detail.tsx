import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import type { Identity, PortalStatementResponse } from '@fs-billing/shared';
import { AppShell, mobileBarButtonClass } from '../../components/app-shell';
import {
  CdrExportError,
  CdrExportButton,
  useCdrExport,
} from '../../components/cdr/cdr-export';
import { DateTime } from '../../components/data-format';
import { QueryError, RefreshError } from '../../components/query-error';
import { StatementCountries } from '../../components/statement/country-table';
import { StatementDays } from '../../components/statement/day-table';
import { StatementEquation } from '../../components/statement/statement-equation';
import { StatementStateTag } from '../../components/statement/state-tag';
import { Button, buttonVariants } from '../../components/ui/button';
import { ModalDialog } from '../../components/ui/dialog';
import { apiQuery } from '../../lib/admin-api';
import { callDownload } from '../../lib/api';
import {
  fillDays,
  nextMonthFirstDay,
  statementMonthRange,
  statementMonthTitle,
  statementPeriodLabel,
} from '../../lib/statement';
import { cn } from '../../lib/utils';

const detailsDeletedTitle = '该月话单明细已删除';

function StatementMeta({ statement }: { statement: PortalStatementResponse }) {
  if (statement.state === 'final' && statement.generatedAt)
    return (
      <>
        账单生成于 <DateTime value={statement.generatedAt} />
      </>
    );
  if (!statement.asOf) return null;
  return (
    <>
      数据截至 <DateTime value={statement.asOf} />
      {statement.state === 'in_progress' ? ' · 实时更新' : ' · 正式账单待生成'}
    </>
  );
}

/** 进行中、待生成月份和话单明细已删除的提示（设计稿 2a、3a）。 */
function StatementNotices({
  statement,
}: {
  statement: PortalStatementResponse;
}) {
  return (
    <>
      {statement.detailsDeleted ? (
        <div
          role="status"
          className="flex flex-col gap-0.5 rounded-[10px] border border-input bg-muted px-3.5 py-3 text-sm md:flex-row md:items-center md:gap-2.5 md:px-4"
        >
          <span
            aria-hidden
            className="hidden size-5 shrink-0 items-center justify-center rounded-full border-[1.5px] border-muted-foreground text-xs font-bold text-muted-foreground md:flex"
          >
            i
          </span>
          <span className="font-semibold">{detailsDeletedTitle}</span>
          <span className="text-[13px] text-muted-foreground md:text-sm">
            <span className="md:hidden">
              账单汇总不受影响，但无法再导出话单明细。
            </span>
            <span className="hidden md:inline">
              账单汇总不受影响，但无法再导出该月话单明细。
            </span>
          </span>
        </div>
      ) : null}
      {statement.state === 'in_progress' ? (
        <p className="m-0 text-[13px] text-muted-foreground">
          本月尚未结束，以下数据截至今日并实时更新；
          {nextMonthFirstDay(statement.month)} 凌晨生成正式账单。
        </p>
      ) : null}
      {statement.state === 'pending' ? (
        <p className="m-0 text-[13px] text-muted-foreground">
          该月已结束，正式账单尚未生成；以下数据为实时计算。
        </p>
      ) : null}
    </>
  );
}

/** 手机顶栏 ⋯：打印（导出按钮在页面底部，稿 2b）。 */
function MobileMenu() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        aria-label="更多操作"
        aria-haspopup="dialog"
        onClick={() => setOpen(true)}
        className={mobileBarButtonClass}
      >
        ⋯
      </button>
      <ModalDialog open={open} onOpenChange={setOpen} title="更多操作">
        <Button
          variant="ghost"
          className="h-12 justify-start px-0 text-base font-normal"
          onClick={() => {
            setOpen(false);
            // 等对话框关闭、焦点归还之后再打印，否则对话框会进入打印页面。
            setTimeout(() => window.print(), 0);
          }}
        >
          打印
        </Button>
      </ModalDialog>
    </>
  );
}

function StatementDetailContent({
  statement,
  tenant,
  refreshError,
}: {
  statement: PortalStatementResponse;
  tenant: { code: string; name: string };
  refreshError: React.ReactNode;
}) {
  const { month, currency, figures } = statement;
  const params = { month };
  const summary = useCdrExport(
    () => callDownload('portalStatementExport', { params, body: {} }),
    month,
  );
  const details = useCdrExport(
    () =>
      callDownload('portalCdrsExport', { body: statementMonthRange(month) }),
    month,
  );
  const exporting = summary.isPending || details.isPending;
  const failure = summary.isError
    ? { error: summary.error, retry: () => summary.mutate() }
    : details.isError
      ? { error: details.error, retry: () => details.mutate() }
      : null;
  const today =
    statement.state === 'in_progress' ? statement.period.to : undefined;
  const days = fillDays(statement.period, statement.days);
  const title = statementMonthTitle(month);
  return (
    <div className="flex flex-col gap-4 p-4 md:gap-6 md:p-7">
      <div className="flex flex-col gap-1.5 md:flex-row md:items-start md:justify-between md:gap-6">
        <div className="flex flex-col gap-1.5 md:gap-2">
          <div className="flex items-center gap-2.5">
            <h1 className="m-0 text-[26px] font-semibold tracking-[-0.01em] max-md:sr-only">
              {title}
            </h1>
            <StatementStateTag
              state={statement.state}
              size="lg"
              className="max-md:hidden"
            />
          </div>
          <div className="flex flex-wrap gap-x-3.5 gap-y-1 text-[13px] text-muted-foreground tabular-nums">
            <span className="text-foreground">{tenant.name}</span>
            <span className="hidden font-mono md:inline">{tenant.code}</span>
            <span>
              <span className="hidden md:inline">币种 </span>
              {currency}
            </span>
            <span className="hidden md:inline">
              {statementPeriodLabel(statement.period, statement.state)}
            </span>
          </div>
          <StatementStateTag
            state={statement.state}
            className="self-start md:hidden"
          />
          <span className="text-xs text-muted-foreground md:hidden">
            <StatementMeta statement={statement} />
          </span>
        </div>
        <div className="hidden flex-col items-end gap-2 md:flex">
          <div className="flex gap-2 print:hidden">
            <CdrExportButton
              label="导出 CSV（汇总）"
              exporting={summary.isPending}
              disabled={details.isPending}
              onExport={() => summary.mutate()}
            />
            <span
              {...(statement.detailsDeleted
                ? { title: detailsDeletedTitle }
                : {})}
            >
              <CdrExportButton
                label="导出 CSV（该月话单明细）"
                exporting={details.isPending}
                disabled={statement.detailsDeleted || summary.isPending}
                onExport={() => details.mutate()}
              />
            </span>
            <Button variant="outline" onClick={() => window.print()}>
              打印
            </Button>
          </div>
          <span className="text-xs text-muted-foreground">
            <StatementMeta statement={statement} />
          </span>
        </div>
      </div>
      {refreshError}
      {failure ? (
        <div className="print:hidden">
          <CdrExportError
            error={failure.error}
            retrying={exporting}
            onRetry={failure.retry}
          />
        </div>
      ) : null}
      <StatementNotices statement={statement} />
      <StatementEquation currency={currency} figures={figures} />
      <div className="grid items-start gap-4 md:grid-cols-2 md:gap-6">
        <StatementCountries
          currency={currency}
          countries={statement.countries}
          figures={figures}
        />
        <StatementDays
          currency={currency}
          days={days}
          figures={figures}
          today={today}
        />
      </div>
      <div className="flex flex-col gap-2 md:hidden print:hidden">
        <Button
          variant="outline"
          size="lg"
          disabled={summary.isPending || details.isPending}
          onClick={() => summary.mutate()}
        >
          {summary.isPending ? '正在导出…' : '导出 CSV（汇总）'}
        </Button>
        <Button
          variant="outline"
          size="lg"
          disabled={
            statement.detailsDeleted || summary.isPending || details.isPending
          }
          onClick={() => details.mutate()}
        >
          {details.isPending ? '正在导出…' : '导出 CSV（该月话单明细）'}
        </Button>
        {statement.detailsDeleted ? (
          <span className="text-center text-xs text-muted-foreground">
            {detailsDeletedTitle}
          </span>
        ) : null}
      </div>
    </div>
  );
}

/**
 * 月账单详情（设计稿客户门户第二批 2a 至 2d，话单明细已删除 3a、3b）：汇总算式、按国家、按日、
 * 导出汇总与话单明细 CSV、打印。路径里的月份不是租户选择器，租户来自会话。
 */
export function PortalStatementDetailPage({
  identity,
  month,
}: {
  identity: Identity;
  month: string;
}) {
  const statement = useQuery(
    apiQuery('portalStatement', { params: { month } }),
  );
  const data = statement.data;
  const title = statementMonthTitle(month);
  const tenant = identity.kind === 'customer' ? identity.tenant : null;
  return (
    <AppShell
      identity={identity}
      title={title}
      crumb={
        <>
          <Link
            to="/portal/statements"
            className="underline underline-offset-[3px]"
          >
            月账单
          </Link>{' '}
          / {title}
        </>
      }
      activeNav="月账单"
      centerTitle
      mobileNav={
        <Link
          to="/portal/statements"
          aria-label="返回月账单"
          className={mobileBarButtonClass}
        >
          ‹
        </Link>
      }
      mobileActions={data ? <MobileMenu /> : null}
    >
      {data && tenant ? (
        <StatementDetailContent
          statement={data}
          tenant={tenant}
          refreshError={
            <RefreshError
              title="月账单刷新失败，数据可能不是最新"
              query={statement}
            />
          }
        />
      ) : statement.isError ? (
        <div className="flex flex-col gap-4 p-4 md:p-7">
          <h1 className="m-0 text-2xl font-semibold max-md:sr-only">{title}</h1>
          <QueryError
            title="月账单加载失败"
            error={statement.error}
            retrying={statement.isFetching}
            onRetry={() => void statement.refetch()}
          />
          <Link
            to="/portal/statements"
            className={cn(buttonVariants({ variant: 'outline' }), 'self-start')}
          >
            返回月账单
          </Link>
        </div>
      ) : (
        <div className="p-4 md:p-7">
          <div
            aria-busy
            aria-label="月账单加载中"
            className="h-[320px] animate-pulse rounded-xl bg-skeleton"
          />
        </div>
      )}
    </AppShell>
  );
}
