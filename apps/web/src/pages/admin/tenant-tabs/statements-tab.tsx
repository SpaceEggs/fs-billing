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
import { StatementList as SharedStatementList } from '../../../components/statement/statement-list';
import { QueryError, RefreshError } from '../../../components/query-error';
import { apiQuery } from '../../../lib/admin-api';
import {
  reconcileNote,
  regenerateReasons,
} from '../../../lib/admin-statements';
import { statementMonthTitle } from '../../../lib/statement';
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

function Statements({
  tenant,
  data,
  onRegenerate,
}: {
  tenant: AdminTenantDetailResponse;
  data: AdminTenantStatementsResponse;
  onRegenerate: (target: RegenerateTarget) => void;
}) {
  const deleted = data.items.filter((row) => row.detailsDeleted);
  return (
    <>
      <SharedStatementList
        currency={data.currency}
        rows={data.items}
        actionLabel="操作"
        renderMonthNote={(row) => <MonthNotes row={row} />}
        renderAction={(row, layout) => {
          const reason = row.regenerable.reason
            ? regenerateReasons[row.regenerable.reason]
            : null;
          const card = layout === 'card';
          return (
            <span
              className={cn(
                'flex items-center gap-3',
                card ? 'gap-2.5' : 'justify-end',
              )}
            >
              {card ? null : (
                <span className="text-xs text-muted-foreground">{reason}</span>
              )}
              {card ? (
                <RegenerateButton
                  allowed={row.regenerable.allowed}
                  reason={row.regenerable.reason}
                  label={`重新生成 ${statementMonthTitle(row.month)}`}
                  mobile
                  onClick={() => onRegenerate(targetOfRow(tenant, data, row))}
                />
              ) : null}
              <Link
                to="/admin/tenants/$tenantId"
                params={{ tenantId: tenant.id }}
                search={{ tab: 'statements', statementMonth: row.month }}
                aria-label={`查看 ${statementMonthTitle(row.month)}`}
                className={
                  card
                    ? 'flex h-10 items-center rounded-lg border border-input px-4 text-[15px]'
                    : 'text-primary'
                }
              >
                查看
              </Link>
              {card ? (
                <span className="text-xs text-muted-foreground">{reason}</span>
              ) : (
                <RegenerateButton
                  allowed={row.regenerable.allowed}
                  reason={row.regenerable.reason}
                  label={`重新生成 ${statementMonthTitle(row.month)}`}
                  onClick={() => onRegenerate(targetOfRow(tenant, data, row))}
                />
              )}
            </span>
          );
        }}
      />
      <p className="m-0 text-xs text-muted-foreground">
        {deleted.length > 0
          ? `${deleted.map((row) => statementMonthTitle(row.month)).join('、')}的话单明细已被删除，账单数据保留，但无法重新生成。`
          : '重新生成会按当前话单重新计算该月账单，用于补推话单后更正；每次操作记入操作日志。'}
      </p>
    </>
  );
}

const tag =
  'inline-flex h-[22px] items-center rounded-md border px-2 text-xs font-medium';

/** 月份下方的小字与标签：话单已删除、账单已过期 / 账单与流水不一致、已重新生成（决定 27）。 */
function MonthNotes({ row }: { row: AdminTenantStatementRow }) {
  const mismatch = reconcileNote(row.reconcileStatus);
  if (!mismatch && row.version <= 1 && !row.detailsDeleted) return null;
  return (
    <span className="flex flex-col items-start gap-0.5">
      {row.detailsDeleted ? (
        <span className={cn(tag, 'border-off-border bg-off-soft text-off')}>
          话单已删除
        </span>
      ) : null}
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
