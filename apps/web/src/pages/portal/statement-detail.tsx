import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useTranslation } from 'react-i18next';
import {
  translate,
  type Identity,
  type PortalStatementResponse,
} from '@fs-billing/shared';
import { ChevronLeftIcon, EllipsisIcon } from 'lucide-react';
import { Skeleton } from '../../components/ui/skeleton';
import { AppShell } from '../../components/app-shell';
import { MobileBarButton } from '../../components/mobile-bar-button';
import {
  CdrExportError,
  CdrExportButton,
  useCdrExport,
} from '../../components/cdr/cdr-export';
import { QueryError, RefreshError } from '../../components/query-error';
import { StatementCountries } from '../../components/statement/country-table';
import { StatementDays } from '../../components/statement/day-table';
import { StatementEquation } from '../../components/statement/statement-equation';
import { StatementStateTag } from '../../components/statement/state-tag';
import { Button, buttonVariants } from '../../components/ui/button';
import { ModalDialog } from '../../components/modal-dialog';
import { useLocale } from '../../i18n';
import { apiQuery } from '../../lib/admin-api';
import { callDownload } from '../../lib/api';
import { formatDateTime, formatDay } from '../../lib/format';
import {
  fillDays,
  nextMonthFirstDay,
  statementMonthRange,
  statementMonthTitle,
  statementPeriodLabel,
} from '../../lib/statement';
import { cn } from '../../lib/utils';

function StatementMeta({ statement }: { statement: PortalStatementResponse }) {
  const { t } = useTranslation(['portal']);
  const locale = useLocale();
  if (statement.state === 'final' && statement.generatedAt)
    return (
      <>
        {t('portal:statementDetail.generatedAt', {
          time: formatDateTime(statement.generatedAt, locale),
        })}
      </>
    );
  if (!statement.asOf) return null;
  return (
    <>
      {t('portal:statementDetail.asOf', {
        time: formatDateTime(statement.asOf, locale),
      })}
      {statement.state === 'in_progress'
        ? t('portal:statementDetail.liveSuffix')
        : t('portal:statementDetail.pendingSuffix')}
    </>
  );
}

/** 进行中、待生成月份和话单明细已删除的提示（设计稿 2a、3a）。 */
function StatementNotices({
  statement,
}: {
  statement: PortalStatementResponse;
}) {
  const { t } = useTranslation(['portal']);
  const locale = useLocale();
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
          <span className="font-semibold">
            {t('portal:statementDetail.detailsDeleted')}
          </span>
          <span className="text-[13px] text-muted-foreground md:text-sm">
            <span className="md:hidden">
              {t('portal:statementDetail.detailsDeletedBodyMobile')}
            </span>
            <span className="hidden md:inline">
              {t('portal:statementDetail.detailsDeletedBody')}
            </span>
          </span>
        </div>
      ) : null}
      {statement.state === 'in_progress' ? (
        <p className="m-0 text-[13px] text-muted-foreground">
          {t('portal:statementDetail.inProgressNote', {
            date: formatDay(nextMonthFirstDay(statement.month), locale),
          })}
        </p>
      ) : null}
      {statement.state === 'pending' ? (
        <p className="m-0 text-[13px] text-muted-foreground">
          {t('portal:statementDetail.pendingNote')}
        </p>
      ) : null}
    </>
  );
}

/** 手机顶栏 ⋯：打印（导出按钮在页面底部，稿 2b）。 */
function MobileMenu() {
  const { t } = useTranslation(['portal']);
  const [open, setOpen] = useState(false);
  return (
    <>
      <MobileBarButton
        aria-label={t('portal:statementDetail.moreActions')}
        aria-haspopup="dialog"
        onClick={() => setOpen(true)}
      >
        <EllipsisIcon aria-hidden />
      </MobileBarButton>
      <ModalDialog
        open={open}
        onOpenChange={setOpen}
        title={t('portal:statementDetail.moreActions')}
      >
        <Button
          variant="ghost"
          className="h-12 justify-start px-0 text-base font-normal"
          onClick={() => {
            setOpen(false);
            // 等对话框关闭、焦点归还之后再打印，否则对话框会进入打印页面。
            setTimeout(() => window.print(), 0);
          }}
        >
          {t('portal:statementDetail.print')}
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
  const { t } = useTranslation(['portal']);
  const locale = useLocale();
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
  const title = statementMonthTitle(month, locale);
  return (
    <div className="flex flex-col gap-4 p-4 md:gap-6 md:p-7">
      <div className="flex flex-col gap-1.5 md:gap-6 xl:flex-row xl:items-start xl:justify-between">
        <div className="flex flex-col gap-1.5 md:gap-2">
          <div className="flex items-center gap-2.5">
            <h1 className="m-0 whitespace-nowrap text-[26px] font-semibold tracking-[-0.01em] max-md:sr-only">
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
              <span className="hidden md:inline">
                {t('portal:statementDetail.currency')}{' '}
              </span>
              {currency}
            </span>
            <span className="hidden md:inline">
              {statementPeriodLabel(statement.period, statement.state, locale)}
              {locale === 'en'
                ? ` · ${t('portal:statementDetail.timezone')}`
                : null}
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
        <div className="hidden flex-col gap-2 md:flex xl:items-end">
          <div className="flex flex-wrap gap-2 print:hidden">
            <CdrExportButton
              label={t('portal:statementDetail.exportSummary')}
              exporting={summary.isPending}
              disabled={details.isPending}
              onExport={() => summary.mutate()}
            />
            <span
              {...(statement.detailsDeleted
                ? { title: t('portal:statementDetail.detailsDeleted') }
                : {})}
            >
              <CdrExportButton
                label={t('portal:statementDetail.exportDetails')}
                exporting={details.isPending}
                disabled={statement.detailsDeleted || summary.isPending}
                onExport={() => details.mutate()}
              />
            </span>
            <Button variant="outline" onClick={() => window.print()}>
              {t('portal:statementDetail.print')}
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
      <div className="grid items-start gap-4 md:gap-6 xl:grid-cols-2">
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
          {summary.isPending
            ? t('portal:statementDetail.exporting')
            : t('portal:statementDetail.exportSummary')}
        </Button>
        <Button
          variant="outline"
          size="lg"
          disabled={
            statement.detailsDeleted || summary.isPending || details.isPending
          }
          onClick={() => details.mutate()}
        >
          {details.isPending
            ? t('portal:statementDetail.exporting')
            : t('portal:statementDetail.exportDetails')}
        </Button>
        {statement.detailsDeleted ? (
          <span className="text-center text-xs text-muted-foreground">
            {t('portal:statementDetail.detailsDeleted')}
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
  const { t } = useTranslation(['portal']);
  const locale = useLocale();
  const statement = useQuery(
    apiQuery('portalStatement', { params: { month } }),
  );
  const data = statement.data;
  const title = statementMonthTitle(month, locale);
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
            {t('portal:statements.title')}
          </Link>{' '}
          / {title}
        </>
      }
      activeNav={translate('zh', 'shell:nav.statements')}
      centerTitle
      mobileNav={
        <MobileBarButton asChild>
          <Link
            to="/portal/statements"
            aria-label={t('portal:statementDetail.back')}
          >
            <ChevronLeftIcon aria-hidden />
          </Link>
        </MobileBarButton>
      }
      mobileActions={data ? <MobileMenu /> : null}
    >
      {data && tenant ? (
        <StatementDetailContent
          statement={data}
          tenant={tenant}
          refreshError={
            <RefreshError
              title={t('portal:statements.refreshFailed')}
              query={statement}
            />
          }
        />
      ) : statement.isError ? (
        <div className="flex flex-col gap-4 p-4 md:p-7">
          <h1 className="m-0 text-2xl font-semibold max-md:sr-only">{title}</h1>
          <QueryError
            title={t('portal:statements.loadFailed')}
            error={statement.error}
            retrying={statement.isFetching}
            onRetry={() => void statement.refetch()}
          />
          <Link
            to="/portal/statements"
            className={cn(buttonVariants({ variant: 'outline' }), 'self-start')}
          >
            {t('portal:statementDetail.back')}
          </Link>
        </div>
      ) : (
        <div className="p-4 md:p-7">
          <Skeleton
            aria-busy
            aria-label={t('portal:statements.loading')}
            className="h-[320px] rounded-xl"
          />
        </div>
      )}
    </AppShell>
  );
}
