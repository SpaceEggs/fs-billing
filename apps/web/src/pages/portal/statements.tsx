import { useQuery } from '@tanstack/react-query';
import type { Identity } from '@fs-billing/shared';
import { AppShell } from '../../components/app-shell';
import { DateTime } from '../../components/data-format';
import { QueryError, RefreshError } from '../../components/query-error';
import { StatementList } from '../../components/statement/statement-list';
import { apiQuery } from '../../lib/admin-api';
import { isStatementsEmpty, statementHref } from '../../lib/statement';

/** 空状态里标着「空状态插图」的斜纹占位框（与首页的空状态一致，不写占位说明文字）。 */
function EmptyStatements() {
  return (
    <section
      aria-label="还没有账单"
      className="flex flex-col items-center gap-2.5 rounded-xl border border-dashed border-border px-4 py-12 text-center md:border-solid md:py-16"
    >
      <div
        aria-hidden
        className="h-[68px] w-24 rounded-lg border border-border bg-[repeating-linear-gradient(135deg,var(--muted)_0_6px,transparent_6px_12px)] md:h-20 md:w-28"
      />
      <span className="text-[15px] font-semibold md:text-base">还没有账单</span>
      <span className="max-w-[420px] text-[13px] leading-relaxed text-muted-foreground md:text-sm">
        <span className="md:hidden">
          本月账单会实时显示在这里；每月 1 日凌晨生成上月正式账单。
        </span>
        <span className="hidden md:inline">
          账户开通后，本月账单会实时显示在这里；每月 1 日凌晨生成上月正式账单。
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
      title="月账单"
      crumb={crumb}
      activeNav="月账单"
      narrowTopbar
    >
      <div className="flex flex-col gap-5 p-4 md:p-7">
        <div className="flex items-baseline gap-3 max-md:sr-only">
          <h1 className="m-0 text-2xl font-semibold tracking-[-0.01em]">
            月账单
          </h1>
          {data ? (
            <span className="text-[13px] text-muted-foreground max-xl:hidden">
              {data.currency}
              {empty ? null : (
                <span className="hidden xl:inline">
                  {' · 按北京时间自然月统计'}
                </span>
              )}
            </span>
          ) : null}
        </div>
        <RefreshError
          title="月账单刷新失败，数据可能不是最新"
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
                  本月数据实时更新，截至 <DateTime value={data.asOf} />
                  ；每月 1 日凌晨生成上月正式账单。「充值」包含所有入账充值。
                </span>
                <span className="hidden md:max-xl:inline">
                  点击查看充值、赠送、调账及通话分钟数
                </span>
              </p>
            </>
          )
        ) : statements.isError ? (
          <QueryError
            title="月账单加载失败"
            error={statements.error}
            retrying={statements.isFetching}
            onRetry={() => void statements.refetch()}
          />
        ) : (
          <div
            aria-busy
            aria-label="月账单加载中"
            className="h-[240px] animate-pulse rounded-xl bg-skeleton"
          />
        )}
      </div>
    </AppShell>
  );
}
