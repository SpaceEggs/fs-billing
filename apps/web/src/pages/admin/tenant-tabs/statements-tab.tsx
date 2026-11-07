import { Card } from '@/components/ui/card';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { Link, useSearch } from '@tanstack/react-router';
import type {
  AdminTenantDetailResponse,
  AdminTenantStatementRow,
  AdminTenantStatementsResponse,
} from '@fs-billing/shared';
import { Skeleton } from '../../../components/ui/skeleton';
import { Badge } from '../../../components/ui/badge';
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
import { reconcileNote, regenerateReason } from '../../../lib/admin-statements';
import { minutesCount, statementMonthTitle } from '../../../lib/statement';
import { Money } from '../../../components/data-format';
import { useLocale } from '../../../i18n';
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
  const { t } = useTranslation(['tenant']);
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
      <RefreshError title={t('tenant:statements.refreshFailed')} query={list} />
      {list.data ? (
        <Statements tenant={tenant} data={list.data} onRegenerate={setTarget} />
      ) : list.isError ? (
        <QueryError
          title={t('tenant:statements.loadFailed')}
          error={list.error}
          retrying={list.isFetching}
          onRetry={() => void list.refetch()}
        />
      ) : (
        <Skeleton
          aria-busy
          aria-label={t('tenant:statements.loading')}
          className="h-[160px] rounded-xl"
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
  const { t } = useTranslation(['tenant', 'statement']);
  const locale = useLocale();
  const deleted = data.items.filter((row) => row.detailsDeleted);
  return (
    <>
      <SharedStatementList
        currency={data.currency}
        rows={data.items}
        actionLabel={t('statement:list.action')}
        minutesUnit
        renderMonthTag={(row) => (row.detailsDeleted ? <DeletedTag /> : null)}
        renderMonthNote={(row) => <MonthNotes row={row} />}
        renderAction={(row) => {
          const reason = row.regenerable.reason
            ? regenerateReason(row.regenerable.reason, locale)
            : null;
          return (
            <span className="flex items-center justify-end gap-3">
              <span className="text-xs text-muted-foreground">{reason}</span>
              <Link
                to="/admin/tenants/$tenantId"
                params={{ tenantId: tenant.id }}
                search={{ tab: 'statements', statementMonth: row.month }}
                aria-label={t('tenant:statements.viewFor', {
                  month: statementMonthTitle(row.month, locale),
                })}
                className="text-primary"
              >
                {t('tenant:statements.view')}
              </Link>
              <RegenerateButton
                allowed={row.regenerable.allowed}
                reason={row.regenerable.reason}
                label={t('tenant:statements.regenerateFor', {
                  month: statementMonthTitle(row.month, locale),
                })}
                onClick={() => onRegenerate(targetOfRow(tenant, data, row))}
              />
            </span>
          );
        }}
        renderCard={(row) => (
          <CompactCard
            tenant={tenant}
            row={row}
            onRegenerate={() => onRegenerate(targetOfRow(tenant, data, row))}
          />
        )}
      />
      <p className="m-0 text-xs text-muted-foreground">
        {deleted.length > 0
          ? t('tenant:statements.deletedNote', {
              months: deleted
                .map((row) => statementMonthTitle(row.month, locale))
                .join(t('tenant:statements.monthSeparator')),
            })
          : t('tenant:statements.regenerateHint')}
      </p>
    </>
  );
}

function DeletedTag() {
  const { t } = useTranslation(['tenant']);
  return <Badge variant="off">{t('tenant:statements.deletedTag')}</Badge>;
}

/** 月份下方的小字：账单已过期 / 账单与流水不一致、已重新生成（决定 27）。话单已删除的标签在月份同一行。 */
function MonthNotes({ row }: { row: AdminTenantStatementRow }) {
  const mismatch = reconcileNote(row.reconcileStatus);
  if (!mismatch && row.version <= 1) return null;
  return (
    <GenerationNotes
      reconcileStatus={row.reconcileStatus}
      version={row.version}
      generatedAt={row.generatedAt}
      firstGeneratedAt={row.firstGeneratedAt}
      detailsDeleted={false}
    />
  );
}

/**
 * 手机的紧凑卡片（租户详情稿 3f、3g）：月份、状态标签与期末一行，通话扣费与分钟一行，
 * 「重新生成」按钮与不可用原因一行；没有「查看」按钮，稿里也没有，所以月份本身是进入详情的链接。
 */
function CompactCard({
  tenant,
  row,
  onRegenerate,
}: {
  tenant: AdminTenantDetailResponse;
  row: AdminTenantStatementRow;
  onRegenerate: () => void;
}) {
  const { t } = useTranslation(['tenant', 'statement']);
  const locale = useLocale();
  const money = (amount: string) => ({ currency: tenant.currency, amount });
  const reason = row.regenerable.reason
    ? regenerateReason(row.regenerable.reason, locale)
    : null;
  const stateLabel =
    row.state === 'in_progress'
      ? t('tenant:statements.inProgress')
      : row.state === 'pending'
        ? t('statement:state.pending')
        : null;
  return (
    <Card className="gap-0 bg-transparent py-0 text-inherit shadow-none flex flex-col gap-2.5 rounded-xl border border-border p-3.5 tabular-nums">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Link
            to="/admin/tenants/$tenantId"
            params={{ tenantId: tenant.id }}
            search={{ tab: 'statements', statementMonth: row.month }}
            aria-label={t('tenant:statements.viewFor', {
              month: statementMonthTitle(row.month, locale),
            })}
            className="text-[15px] font-semibold no-underline outline-none focus-visible:underline"
          >
            {statementMonthTitle(row.month, locale)}
          </Link>
          {stateLabel ? (
            <span className="inline-flex h-5 items-center rounded-[5px] border border-border px-[7px] text-[11px]">
              {stateLabel}
            </span>
          ) : null}
        </div>
        <span className="text-[15px] font-semibold">
          <Money value={money(row.figures.closingBalance)} />
        </span>
      </div>
      <div className="flex justify-between text-xs text-muted-foreground">
        <span>
          {t('statement:equation.callCharges')}{' '}
          <Money value={money(row.figures.callCharges)} tone="plain" />
        </span>
        <span>
          {minutesCount(row.figures.callMinutes)}
          {t('statement:list.minutesUnit')}
        </span>
      </div>
      <MonthNotes row={row} />
      <div className="flex items-center gap-2.5">
        <RegenerateButton
          allowed={row.regenerable.allowed}
          reason={row.regenerable.reason}
          label={t('tenant:statements.regenerateFor', {
            month: statementMonthTitle(row.month, locale),
          })}
          className="h-11 px-4 text-[15px]"
          onClick={onRegenerate}
        />
        {reason ? (
          <span className="text-xs text-muted-foreground">{reason}</span>
        ) : null}
      </div>
    </Card>
  );
}
