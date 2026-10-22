import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, useSearch } from '@tanstack/react-router';
import type {
  AdminTenantDetailResponse,
  AdminTenantStatementRow,
  AdminTenantStatementsResponse,
} from '@fs-billing/shared';
import {
  GenerationNotes,
  RegenerateButton,
} from '../../../components/admin/statement-parts';
import {
  RegenerateDialog,
  RegenerateNotice,
  type RegenerateOutcome,
  type RegenerateTarget,
} from '../../../components/admin/statement-regenerate';
import { Money } from '../../../components/data-format';
import { QueryError, RefreshError } from '../../../components/query-error';
import { apiQuery } from '../../../lib/admin-api';
import {
  formatStatementMinutes,
  reconcileNote,
  regenerateReasons,
  statementMonthLabel,
} from '../../../lib/statements';
import { cn } from '../../../lib/utils';
import { StatementDetailView } from './statement-detail';

/**
 * 租户账单（租户详情稿 1f/1g、手机 3f/3g）：月账单列表，进行中与话单已删除的月份重新生成置灰并写原因；
 * 点「查看」在本标签页内打开该月详情（地址参数 statementMonth），与流水、话单的日期范围无关。
 */
export function StatementsTab({
  tenant,
}: {
  tenant: AdminTenantDetailResponse;
}) {
  const { statementMonth } = useSearch({ from: '/admin/tenants/$tenantId' });
  return statementMonth ? (
    <StatementDetailView
      key={statementMonth}
      tenant={tenant}
      month={statementMonth}
    />
  ) : (
    <StatementList tenant={tenant} />
  );
}

function StatementList({ tenant }: { tenant: AdminTenantDetailResponse }) {
  const list = useQuery(
    apiQuery('adminTenantStatements', { params: { tenantId: tenant.id } }),
  );
  const [target, setTarget] = useState<RegenerateTarget | null>(null);
  const [outcome, setOutcome] = useState<RegenerateOutcome | null>(null);
  return (
    <div className="flex flex-col gap-3">
      {outcome ? (
        <RegenerateNotice
          outcome={outcome}
          onDismiss={() => setOutcome(null)}
        />
      ) : null}
      <RefreshError title="账单刷新失败，数据可能不是最新" query={list} />
      {list.data ? (
        <Statements tenant={tenant} data={list.data} onRegenerate={setTarget} />
      ) : list.isError ? (
        <QueryError
          title="账单加载失败"
          error={list.error}
          retrying={list.isFetching}
          onRetry={() => void list.refetch()}
        />
      ) : (
        <div
          aria-busy
          aria-label="账单加载中"
          className="h-[160px] animate-pulse rounded-xl bg-skeleton"
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

export function targetOfRow(
  tenant: Pick<AdminTenantDetailResponse, 'id' | 'code'>,
  data: Pick<AdminTenantStatementsResponse, 'currency'>,
  row: AdminTenantStatementRow,
): RegenerateTarget {
  return {
    tenantId: tenant.id,
    tenantCode: tenant.code,
    currency: data.currency,
    month: row.month,
    version: row.version,
    current:
      row.state === 'final' && row.generatedAt
        ? {
            callCharges: row.figures.callCharges,
            callMinutes: row.figures.callMinutes,
            closingBalance: row.figures.closingBalance,
            generatedAt: row.generatedAt,
          }
        : null,
  };
}

const th = 'px-3 py-2.5 text-right font-medium';
const tag =
  'inline-flex h-[22px] items-center gap-1.5 rounded-md border px-2 text-xs font-medium';

function MonthTags({ row }: { row: AdminTenantStatementRow }) {
  return (
    <>
      {row.state === 'in_progress' ? (
        <span className={cn(tag, 'border-border')}>
          <span aria-hidden className="size-1.5 rounded-full bg-pos" />
          本月（进行中）
        </span>
      ) : null}
      {row.state === 'pending' ? (
        <span className={cn(tag, 'border-warn-border bg-warn-soft text-warn')}>
          待生成
        </span>
      ) : null}
      {row.detailsDeleted ? (
        <span className={cn(tag, 'border-off-border bg-off-soft text-off')}>
          话单已删除
        </span>
      ) : null}
    </>
  );
}

function Statements({
  tenant,
  data,
  onRegenerate,
}: {
  tenant: AdminTenantDetailResponse;
  data: AdminTenantStatementsResponse;
  onRegenerate: (target: RegenerateTarget) => void;
}) {
  const money = (amount: string) => ({ currency: data.currency, amount });
  const deleted = data.items.filter((row) => row.detailsDeleted);
  const detailLink = (row: AdminTenantStatementRow, className: string) => (
    <Link
      to="/admin/tenants/$tenantId"
      params={{ tenantId: tenant.id }}
      search={{ tab: 'statements', statementMonth: row.month }}
      aria-label={`查看 ${statementMonthLabel(row.month)}`}
      className={className}
    >
      查看
    </Link>
  );
  const reasonOf = (row: AdminTenantStatementRow) =>
    row.regenerable.reason ? regenerateReasons[row.regenerable.reason] : null;
  return (
    <>
      <div className="hidden overflow-x-auto rounded-[10px] border border-border md:block">
        <table className="w-full border-collapse text-[13px] whitespace-nowrap">
          <thead>
            <tr className="bg-muted text-xs text-muted-foreground">
              <th className="px-4 py-2.5 text-left font-medium">月份</th>
              <th className={th}>期初余额</th>
              <th className={th}>充值</th>
              <th className={th}>赠送</th>
              <th className={th}>调账</th>
              <th className={th}>通话扣费</th>
              <th className={th}>期末余额</th>
              <th className={th}>通话分钟数</th>
              <th className="px-4 py-2.5 text-right font-medium">操作</th>
            </tr>
          </thead>
          <tbody className="tabular-nums">
            {data.items.map((row) => (
              <tr key={row.month} className="border-t border-border">
                <td className="px-4 py-3.5">
                  <span className="flex flex-col gap-1">
                    <span className="flex items-center gap-2">
                      <span className="text-sm font-medium">
                        {statementMonthLabel(row.month)}
                      </span>
                      <MonthTags row={row} />
                    </span>
                    <ReconcileLine row={row} />
                  </span>
                </td>
                <td className="px-3 py-3.5 text-right">
                  <Money
                    value={money(row.figures.openingBalance)}
                    tone="plain"
                  />
                </td>
                <td className="px-3 py-3.5 text-right">
                  <Money value={money(row.figures.recharge)} tone="plain" />
                </td>
                <td className="px-3 py-3.5 text-right">
                  <Money value={money(row.figures.gift)} tone="plain" />
                </td>
                <td className="px-3 py-3.5 text-right">
                  <Money value={money(row.figures.adjustment)} />
                </td>
                <td className="px-3 py-3.5 text-right">
                  <Money value={money(row.figures.callCharges)} tone="plain" />
                </td>
                <td className="px-3 py-3.5 text-right font-semibold">
                  <Money value={money(row.figures.closingBalance)} />
                </td>
                <td className="px-3 py-3.5 text-right">
                  {formatStatementMinutes(row.figures.callMinutes)}分钟
                </td>
                <td className="px-4 py-2.5">
                  <span className="flex items-center justify-end gap-3">
                    <span className="text-xs text-muted-foreground">
                      {reasonOf(row)}
                    </span>
                    {detailLink(row, 'text-primary')}
                    <RegenerateButton
                      allowed={row.regenerable.allowed}
                      reason={row.regenerable.reason}
                      label={`重新生成 ${statementMonthLabel(row.month)}`}
                      onClick={() =>
                        onRegenerate(targetOfRow(tenant, data, row))
                      }
                    />
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="flex flex-col gap-2.5 md:hidden">
        {data.items.map((row) => (
          <div
            key={row.month}
            className="flex flex-col gap-2.5 rounded-xl border border-border p-3.5 tabular-nums"
          >
            <div className="flex items-center justify-between">
              <span className="flex items-center gap-2">
                <span className="text-[15px] font-semibold">
                  {statementMonthLabel(row.month)}
                </span>
                <MonthTags row={row} />
              </span>
              <span className="text-[15px] font-semibold">
                <Money value={money(row.figures.closingBalance)} />
              </span>
            </div>
            <div className="flex justify-between text-xs text-muted-foreground">
              <span>
                通话扣费{' '}
                <Money value={money(row.figures.callCharges)} tone="plain" />
              </span>
              <span>{formatStatementMinutes(row.figures.callMinutes)}分钟</span>
            </div>
            <ReconcileLine row={row} />
            <div className="flex items-center gap-2.5">
              <RegenerateButton
                allowed={row.regenerable.allowed}
                reason={row.regenerable.reason}
                label={`重新生成 ${statementMonthLabel(row.month)}`}
                mobile
                onClick={() => onRegenerate(targetOfRow(tenant, data, row))}
              />
              {detailLink(
                row,
                'flex h-10 items-center rounded-lg border border-input px-4 text-[15px]',
              )}
              <span className="text-xs text-muted-foreground">
                {reasonOf(row)}
              </span>
            </div>
          </div>
        ))}
      </div>
      <p className="m-0 text-xs text-muted-foreground">
        {deleted.length > 0
          ? `${deleted.map((row) => statementMonthLabel(row.month)).join('、')}的话单明细已被删除，账单数据保留，但无法重新生成。`
          : '重新生成会按当前话单重新计算该月账单，用于补推话单后更正；每次操作记入操作日志。'}
      </p>
    </>
  );
}

/** 月份下方的小字：账单已过期 / 账单与流水不一致、已重新生成（决定 27）。 */
function ReconcileLine({ row }: { row: AdminTenantStatementRow }) {
  const mismatch = reconcileNote(row.reconcileStatus);
  if (!mismatch && row.version <= 1) return null;
  return (
    <span className="flex flex-col gap-0.5">
      <GenerationNotes
        reconcileStatus={row.reconcileStatus}
        version={row.version}
        generatedAt={row.generatedAt}
        firstGeneratedAt={row.firstGeneratedAt}
        detailsDeleted={false}
      />
    </span>
  );
}
