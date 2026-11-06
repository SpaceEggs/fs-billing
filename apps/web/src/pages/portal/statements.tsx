import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { translate, type Identity } from '@fs-billing/shared';
import { Skeleton } from '../../components/ui/skeleton';
import { AppShell } from '../../components/app-shell';
import { QueryError, RefreshError } from '../../components/query-error';
import { StatementList } from '../../components/statement/statement-list';
import { apiQuery } from '../../lib/admin-api';
import { formatDateTime } from '../../lib/format';
import { isStatementsEmpty, statementHref } from '../../lib/statement';

/** 空状态里标着「空状态插图」的斜纹占位框（与首页的空状态一致，不写占位说明文字）。 */
function EmptyStatements() {
  const { t } = useTranslation(['portal']);
  return (
    <section
      aria-label={t('portal:statements.empty.label')}
      className="flex flex-col items-center gap-2.5 rounded-xl border border-dashed border-border px-4 py-12 text-center md:border-solid md:py-16"
    >
      <div
        aria-hidden
        className="h-[68px] w-24 rounded-lg border border-border bg-[repeating-linear-gradient(135deg,var(--muted)_0_6px,transparent_6px_12px)] md:h-20 md:w-28"
      />
      <span className="text-[15px] font-semibold md:text-base">
        {t('portal:statements.empty.title')}
      </span>
      <span className="max-w-[420px] text-[13px] leading-relaxed text-muted-foreground md:text-sm">
        <span className="md:hidden">
          {t('portal:statements.empty.bodyMobile')}
        </span>
        <span className="hidden md:inline">
          {t('portal:statements.empty.body')}
        </span>
      </span>
    </section>
  );
}

/**
 * 月账单列表（设计稿客户门户第二批 1a 至 1c，空状态 4a、4b）：按月份降序，第一行是进行中的本月（实时）。
 * 没有任何账单、本月也没有流水和通话时显示「还没有账单」（决定 22）。
 */
export function PortalStatementsPage({ identity }: { identity: Identity }) {
  const { t } = useTranslation(['portal']);
  const statements = useQuery(apiQuery('portalStatements'));
  const data = statements.data;
  const empty = data ? isStatementsEmpty(data.items) : false;
  const crumb =
    identity.kind === 'customer'
      ? `${identity.tenant.code} · ${identity.tenant.name}`
      : '';
  return (
    <AppShell
      identity={identity}
      title={t('portal:statements.title')}
      crumb={crumb}
      activeNav={translate('zh', 'shell:nav.statements')}
      narrowTopbar
    >
      <div className="flex flex-col gap-5 p-4 md:p-7">
        <div className="flex items-baseline gap-3 max-md:sr-only">
          <h1 className="m-0 text-2xl font-semibold tracking-[-0.01em]">
            {t('portal:statements.title')}
          </h1>
          {data ? (
            <span className="text-[13px] text-muted-foreground max-xl:hidden">
              {data.currency}
              {empty ? null : (
                <span className="hidden xl:inline">
                  {t('portal:statements.byMonth')}
                </span>
              )}
            </span>
          ) : null}
        </div>
        <RefreshError
          title={t('portal:statements.refreshFailed')}
          query={statements}
        />
        {data ? (
          empty ? (
            <EmptyStatements />
          ) : (
            <>
              <StatementList
                currency={data.currency}
                rows={data.items}
                hrefFor={(row) => statementHref(row.month)}
              />
              <p className="m-0 text-xs leading-relaxed text-muted-foreground">
                <span className="md:max-xl:hidden">
                  {t('portal:statements.liveNote', {
                    time: formatDateTime(data.asOf),
                  })}
                </span>
                <span className="hidden md:max-xl:inline">
                  {t('portal:statements.liveNoteCompact')}
                </span>
              </p>
            </>
          )
        ) : statements.isError ? (
          <QueryError
            title={t('portal:statements.loadFailed')}
            error={statements.error}
            retrying={statements.isFetching}
            onRetry={() => void statements.refetch()}
          />
        ) : (
          <Skeleton
            aria-busy
            aria-label={t('portal:statements.loading')}
            className="h-[240px] rounded-xl"
          />
        )}
      </div>
    </AppShell>
  );
}
