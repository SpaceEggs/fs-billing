import { useState } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Link, useNavigate, useSearch } from '@tanstack/react-router';
import type {
  AdminStatementListRow,
  AdminStatementsResponse,
  Currency,
  Identity,
} from '@fs-billing/shared';
import { Skeleton } from '../../components/ui/skeleton';
import {
  GenerationNotes,
  RegenerateButton,
} from '../../components/admin/statement-parts';
import {
  RegenerateDialog,
  RegenerateNotice,
  type RegenerateOutcome,
  type RegenerateTarget,
} from '../../components/admin/statement-regenerate';
import { AppShell, PageBody } from '../../components/app-shell';
import { DateTime, Money } from '../../components/data-format';
import { MonthField } from '../../components/month-field';
import { QueryError, RefreshError } from '../../components/query-error';
import { SheetPanel } from '../../components/sheet-panel';
import { apiQuery } from '../../lib/admin-api';
import { formatDateTime } from '../../lib/format';
import { previousBeijingMonth } from '../../lib/admin-statements';
import { statementMonthTitle } from '../../lib/statement';
import { cn } from '../../lib/utils';

type Group = AdminStatementsResponse['groups'][number];

/** 能选的最早月份：生成任务最多回溯 24 个月，更早没有账单。 */
const earliestMonth = '2020-01';

/** 一行对应的重新生成对话框目标；还没有账单行（未生成）时没有当前数字。 */
function targetOf(row: AdminStatementListRow, currency: Currency) {
  const current =
    row.figures && row.generatedAt
      ? {
          callCharges: row.figures.callCharges,
          callMinutes: row.figures.callMinutes,
          closingBalance: row.figures.closingBalance,
          generatedAt: row.generatedAt,
        }
      : null;
  return {
    tenantId: row.tenant.id,
    tenantCode: row.tenant.code,
    currency,
    month: row.month,
    version: row.version,
    current,
  } satisfies RegenerateTarget;
}

function viewSearch(row: AdminStatementListRow) {
  return { tab: 'statements', statementMonth: row.month } as const;
}

function useStatementsMonth() {
  const search = useSearch({ from: '/admin/statements' });
  const navigate = useNavigate({ from: '/admin/statements' });
  const latest = previousBeijingMonth(new Date());
  const month =
    search.month && search.month <= latest && search.month >= earliestMonth
      ? search.month
      : latest;
  const setMonth = (next: string) =>
    void navigate({
      search: next === latest ? {} : { month: next },
      replace: true,
    });
  return { month, latest, setMonth };
}

/** 账单（运营稿第三批 5a 至 5c）：按月份列出所有租户的账单，CNY 与 USD 分组，重新生成。 */
export function AdminStatementsPage({ identity }: { identity: Identity }) {
  const { month, latest, setMonth } = useStatementsMonth();
  const list = useQuery({
    ...apiQuery('adminStatements', { query: { month } }),
    placeholderData: keepPreviousData,
  });
  const [target, setTarget] = useState<RegenerateTarget | null>(null);
  const [outcome, setOutcome] = useState<RegenerateOutcome | null>(null);
  const field = (className?: string, showLabel = false) => (
    <MonthField
      label="月份"
      showLabel={showLabel}
      value={month}
      min={earliestMonth}
      max={latest}
      onChange={setMonth}
      {...(className ? { className } : {})}
    />
  );
  return (
    <AppShell identity={identity} title="账单" crumb="账单" activeNav="账单">
      <PageBody
        title="账单"
        meta="每月 1 日凌晨生成上月账单 · CNY 与 USD 分开合计"
        actions={field(undefined, true)}
      >
        <div className="md:hidden">{field('w-full')}</div>
        {outcome ? (
          <RegenerateNotice
            outcome={outcome}
            onDismiss={() => setOutcome(null)}
          />
        ) : null}
        <RefreshError title="账单刷新失败，数据可能不是最新" query={list} />
        {list.data ? (
          <Groups
            data={list.data}
            fetching={list.isPlaceholderData}
            onRegenerate={setTarget}
          />
        ) : list.isError ? (
          <QueryError
            title="账单加载失败"
            error={list.error}
            retrying={list.isFetching}
            onRetry={() => void list.refetch()}
          />
        ) : (
          <Skeleton
            aria-busy
            aria-label="账单加载中"
            className="h-[160px] rounded-xl"
          />
        )}
        <p className="m-0 text-xs text-muted-foreground max-md:hidden">
          「重新生成」按当前话单重新计算该月账单，用于补推话单后更正；话单已删除的月份不可用。每次重新生成记入操作日志。
        </p>
        <p className="m-0 text-xs text-muted-foreground md:hidden">
          点 ⋯ 查看或重新生成
        </p>
      </PageBody>
      <RegenerateDialog
        target={target}
        onClose={() => setTarget(null)}
        onDone={(done) => {
          setTarget(null);
          setOutcome(done);
        }}
      />
    </AppShell>
  );
}

function Groups({
  data,
  fetching,
  onRegenerate,
}: {
  data: AdminStatementsResponse;
  /** 正在换月份：先显示上一个月份的数据时标记为忙碌。 */
  fetching: boolean;
  onRegenerate: (target: RegenerateTarget) => void;
}) {
  if (data.groups.length === 0)
    return (
      <div
        aria-busy={fetching}
        className="flex flex-col items-center gap-2 rounded-xl border border-border px-4 py-12 text-center"
      >
        <span className="text-[15px] font-semibold">
          {statementMonthTitle(data.month)}没有账单
        </span>
        <span className="text-[13px] text-muted-foreground">
          租户从开户月起才有账单
        </span>
      </div>
    );
  return (
    <div
      aria-busy={fetching}
      className={cn('flex flex-col gap-5', fetching && 'opacity-60')}
    >
      {data.groups.map((group) => (
        <GroupSection
          key={group.currency}
          group={group}
          onRegenerate={onRegenerate}
        />
      ))}
    </div>
  );
}

const th = 'px-3 py-2.5 text-right font-medium';

function GroupSection({
  group,
  onRegenerate,
}: {
  group: Group;
  onRegenerate: (target: RegenerateTarget) => void;
}) {
  const { currency } = group;
  const unissued = group.items.filter((row) => row.figures === null).length;
  const [menu, setMenu] = useState<AdminStatementListRow | null>(null);
  const money = (amount: string) => ({ currency, amount });
  return (
    <section aria-label={`${currency} 账单`} className="flex flex-col gap-2">
      <div className="flex items-baseline justify-between gap-2 max-md:px-0.5 max-md:pt-2">
        <div className="flex flex-wrap items-baseline gap-x-2">
          <h2 className="m-0 text-[15px] font-semibold">{currency}</h2>
          <span aria-hidden className="text-[15px] font-semibold md:hidden">
            ·
          </span>
          <span className="text-[13px] text-muted-foreground max-md:text-[15px] max-md:font-semibold max-md:text-foreground">
            {`${group.tenantCount} 个租户${unissued > 0 ? ` · ${unissued} 个未生成，不计入合计` : ''}`}
          </span>
        </div>
        <span className="text-xs whitespace-nowrap text-muted-foreground tabular-nums md:hidden">
          扣费合计{' '}
          <Money
            value={money(group.totals.callCharges)}
            tone="plain"
            className="font-semibold text-foreground"
          />
        </span>
      </div>
      <div className="hidden overflow-x-auto rounded-[10px] border border-border md:block">
        <table className="w-full border-collapse text-[13px] whitespace-nowrap">
          <thead>
            <tr className="bg-muted text-xs text-muted-foreground">
              <th className="px-4 py-2.5 text-left font-medium">租户</th>
              <th className="px-3 py-2.5 text-left font-medium">币种</th>
              <th className={th}>期初余额</th>
              <th className={th}>充值</th>
              <th className={th}>赠送</th>
              <th className={th}>调账</th>
              <th className={th}>通话扣费</th>
              <th className={th}>期末余额</th>
              <th className="px-3 py-2.5 text-left font-medium">生成时间</th>
              <th className="px-4 py-2.5 text-right font-medium">操作</th>
            </tr>
          </thead>
          <tbody className="tabular-nums">
            {group.items.map((row) => (
              <tr key={row.tenant.id} className="border-t border-border">
                <td className="px-4 py-[11px]">
                  <span className="flex flex-col gap-0.5">
                    <span className="text-sm font-medium">
                      {row.tenant.name}
                    </span>
                    <span className="font-mono text-xs text-muted-foreground">
                      {row.tenant.code}
                    </span>
                  </span>
                </td>
                <td className="px-3 py-[11px]">{currency}</td>
                {row.figures ? (
                  <>
                    <td className="px-3 py-[11px] text-right">
                      <Money value={money(row.figures.openingBalance)} />
                    </td>
                    <td className="px-3 py-[11px] text-right">
                      <Money value={money(row.figures.recharge)} tone="plain" />
                    </td>
                    <td className="px-3 py-[11px] text-right">
                      <Money value={money(row.figures.gift)} tone="plain" />
                    </td>
                    <td className="px-3 py-[11px] text-right">
                      <Money value={money(row.figures.adjustment)} />
                    </td>
                    <td className="px-3 py-[11px] text-right">
                      <Money
                        value={money(row.figures.callCharges)}
                        tone="plain"
                      />
                    </td>
                    <td className="px-3 py-[11px] text-right font-semibold">
                      <Money value={money(row.figures.closingBalance)} />
                    </td>
                  </>
                ) : (
                  <td
                    colSpan={6}
                    className="px-3 py-[11px] text-center text-muted-foreground"
                  >
                    未生成
                  </td>
                )}
                <td className="px-3 py-[11px]">
                  <span className="flex flex-col gap-0.5">
                    {row.generatedAt ? (
                      <DateTime value={row.generatedAt} />
                    ) : (
                      '—'
                    )}
                    <GenerationNotes {...notesOf(row)} />
                  </span>
                </td>
                <td className="px-4 py-2">
                  <span className="flex items-center justify-end gap-3">
                    <Link
                      to="/admin/tenants/$tenantId"
                      params={{ tenantId: row.tenant.id }}
                      search={viewSearch(row)}
                      aria-label={`查看 ${row.tenant.code} ${statementMonthTitle(row.month)}`}
                      className="text-primary"
                    >
                      查看
                    </Link>
                    <RegenerateButton
                      allowed={row.regenerable.allowed}
                      reason={row.regenerable.reason}
                      label={`重新生成 ${row.tenant.code} ${statementMonthTitle(row.month)}`}
                      onClick={() => onRegenerate(targetOf(row, currency))}
                    />
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="border-t border-border bg-muted font-semibold tabular-nums">
              <td className="px-4 py-[11px]" colSpan={2}>
                {currency} 合计
              </td>
              <td className="px-3 py-[11px] text-right">
                <Money
                  value={money(group.totals.openingBalance)}
                  tone="plain"
                />
              </td>
              <td className="px-3 py-[11px] text-right">
                <Money value={money(group.totals.recharge)} tone="plain" />
              </td>
              <td className="px-3 py-[11px] text-right">
                <Money value={money(group.totals.gift)} tone="plain" />
              </td>
              <td className="px-3 py-[11px] text-right">
                <Money value={money(group.totals.adjustment)} tone="plain" />
              </td>
              <td className="px-3 py-[11px] text-right">
                <Money value={money(group.totals.callCharges)} tone="plain" />
              </td>
              <td className="px-3 py-[11px] text-right">
                <Money
                  value={money(group.totals.closingBalance)}
                  tone="plain"
                />
              </td>
              <td colSpan={2} />
            </tr>
          </tfoot>
        </table>
      </div>
      <div className="flex flex-col gap-2 md:hidden">
        {group.items.map((row) => (
          <div
            key={row.tenant.id}
            className="flex items-center gap-2.5 rounded-[10px] border border-border py-3 pr-1 pl-3.5 tabular-nums"
          >
            <div className="flex min-w-0 flex-1 flex-col gap-1">
              <div className="flex justify-between gap-2">
                <span className="truncate text-[15px] font-medium">
                  {row.tenant.name}
                </span>
                <span className="text-[15px] font-semibold">
                  {row.figures ? (
                    <Money value={money(row.figures.closingBalance)} />
                  ) : (
                    <span className="text-muted-foreground">未生成</span>
                  )}
                </span>
              </div>
              <div className="flex justify-between text-xs text-muted-foreground">
                <span>
                  {row.tenant.code}
                  {row.figures ? (
                    <>
                      {' '}
                      · 扣费{' '}
                      <Money
                        value={money(row.figures.callCharges)}
                        tone="plain"
                      />
                    </>
                  ) : null}
                </span>
                {row.figures ? <span>期末</span> : null}
              </div>
              <span className="flex flex-col gap-0.5">
                <GenerationNotes {...notesOf(row)} />
              </span>
            </div>
            <button
              type="button"
              aria-label={`${row.tenant.code} 的操作`}
              aria-haspopup="dialog"
              onClick={() => setMenu(row)}
              className="flex h-11 w-8 items-center justify-center text-muted-foreground"
            >
              ⋯
            </button>
          </div>
        ))}
      </div>
      <SheetPanel
        side="bottom"
        title={menu ? `${menu.tenant.code} 的操作` : '操作'}
        open={menu !== null}
        onOpenChange={(open) => open || setMenu(null)}
      >
        {menu ? (
          <>
            <span className="pb-1 text-[15px] font-semibold">
              {menu.tenant.code} {statementMonthTitle(menu.month)}
              {menu.generatedAt
                ? ` · 生成于 ${formatDateTime(menu.generatedAt)}`
                : ''}
            </span>
            <Link
              to="/admin/tenants/$tenantId"
              params={{ tenantId: menu.tenant.id }}
              search={viewSearch(menu)}
              className="flex h-12 items-center border-b border-border text-base"
            >
              查看
            </Link>
            <button
              type="button"
              disabled={!menu.regenerable.allowed}
              onClick={() => {
                const row = menu;
                setMenu(null);
                onRegenerate(targetOf(row, currency));
              }}
              className="flex h-12 items-center text-base text-primary disabled:text-muted-foreground"
            >
              重新生成
              {menu.regenerable.reason === 'details_deleted'
                ? '（话单已删除，不可用）'
                : ''}
            </button>
          </>
        ) : null}
      </SheetPanel>
    </section>
  );
}

function notesOf(row: AdminStatementListRow) {
  return {
    reconcileStatus: row.reconcileStatus,
    version: row.version,
    generatedAt: row.generatedAt,
    firstGeneratedAt: row.firstGeneratedAt,
    detailsDeleted: row.detailsDeleted,
  };
}
