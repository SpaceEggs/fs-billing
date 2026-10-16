import { useId, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { AdminReceivable } from '@fs-billing/shared';
import { invalidateTenant, useApiMutation } from '../../lib/admin-api';
import {
  formatDateTime,
  formatExactMoney,
  formatMoney,
} from '../../lib/format';
import {
  adjustmentScanLimit,
  adjustmentsSince,
  reversalCandidates,
  validateReason,
  voidReceivableFailure,
  type ListRefresh,
  type ReceivableActionFailure,
} from '../../lib/receivables';
import { QueryError } from '../query-error';
import { Button } from '../ui/button';
import { ModalDialog } from '../ui/dialog';
import { ActionOutcome, ReasonField } from './receivable-action';

function Candidates({
  receivable,
  selected,
  error,
  disabled,
  onSelect,
  onAdjust,
}: {
  receivable: AdminReceivable;
  selected: string | null;
  error: string | undefined;
  disabled: boolean;
  onSelect: (id: string) => void;
  onAdjust: () => void;
}) {
  const id = useId();
  const ledger = useQuery(adjustmentsSince(receivable));
  const currency = receivable.tenant.currency;
  if (ledger.isPending)
    return (
      <p aria-busy className="m-0 text-[13px] text-muted-foreground">
        正在查找冲正调账…
      </p>
    );
  if (ledger.isError)
    return (
      <QueryError
        title="调账流水加载失败"
        error={ledger.error}
        retrying={ledger.isFetching}
        onRetry={() => void ledger.refetch()}
      />
    );
  const candidates = reversalCandidates(receivable, ledger.data);
  const reversal = formatExactMoney({
    currency,
    amount: `-${receivable.amount}`,
  });
  if (candidates.length === 0)
    return (
      <div className="flex flex-col gap-2 rounded-lg border border-border px-3.5 py-3 text-[13px]">
        <span className="font-semibold">没有可用的冲正调账</span>
        <span className="leading-relaxed text-muted-foreground">
          须先对该租户做一笔 {reversal}{' '}
          的调账（晚于赊账），再回来作废。调账不会自动关闭应收。
          {ledger.data.truncated
            ? `只检查了赊账之后最近 ${adjustmentScanLimit} 条调账。`
            : null}
        </span>
        <Button
          variant="outline"
          size="sm"
          className="self-start"
          disabled={disabled}
          onClick={onAdjust}
        >
          去调账 {reversal}
        </Button>
      </div>
    );
  return (
    <div className="flex flex-col gap-1.5 text-sm font-medium">
      <span id={`${id}-label`}>
        冲正调账 <span className="text-neg">*</span>
      </span>
      <div
        role="radiogroup"
        aria-labelledby={`${id}-label`}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? `${id}-error` : undefined}
        className="flex flex-col gap-1.5"
      >
        {candidates.map((entry) => (
          <label
            key={entry.id}
            className="flex cursor-pointer items-start gap-2 rounded-lg border border-input px-3 py-2 text-[13px] font-normal has-checked:border-primary has-checked:bg-brand-soft has-focus-visible:ring-[3px] has-focus-visible:ring-ring"
          >
            <input
              type="radio"
              name={id}
              value={entry.id}
              checked={selected === entry.id}
              disabled={disabled}
              onChange={() => onSelect(entry.id)}
              className="mt-0.5"
            />
            <span className="flex flex-col gap-0.5 tabular-nums">
              <span className="font-semibold">
                调账 {formatExactMoney({ currency, amount: entry.amount })}
              </span>
              <span className="text-muted-foreground">
                {formatDateTime(entry.occurredAt)}
                {entry.actor ? ` · ${entry.actor.name}` : ''}
                {entry.note ? ` · ${entry.note}` : ''}
              </span>
            </span>
          </label>
        ))}
      </div>
      {error ? (
        <span id={`${id}-error`} className="text-xs font-normal text-neg">
          {error}
        </span>
      ) : null}
      {ledger.data.truncated ? (
        <span className="text-xs font-normal text-muted-foreground">
          只检查了赊账之后最近 {adjustmentScanLimit} 条调账。
        </span>
      ) : null}
    </div>
  );
}

/**
 * 作废应收（G2）：管理员先做一笔金额相反的调账冲正余额，再在此选择那笔调账并填写原因。
 * 作废本身不改余额；是否匹配由服务端判定。打开期间以打开时的 ledgerEntryId 为准：
 * 刷新后的待收款列表已没有该行时禁止提交。409 与网络中断刷新列表，不自动重试。
 */
export function VoidReceivableDialog({
  receivable,
  current,
  refresh,
  onReconcile,
  onRetryRefresh,
  returnFocus,
  fallbackFocus,
  onClose,
  onDone,
  onAdjust,
}: {
  receivable: AdminReceivable;
  /** 最新待收款列表里的同一行；不在列表里时为 undefined。 */
  current: AdminReceivable | undefined;
  refresh: ListRefresh;
  onReconcile: () => void;
  onRetryRefresh: () => void;
  returnFocus: React.RefObject<HTMLElement | null>;
  fallbackFocus: React.RefObject<HTMLElement | null>;
  onClose: () => void;
  onDone: () => void;
  /** 打开预填好冲正金额的调账对话框。 */
  onAdjust: () => void;
}) {
  const queryClient = useQueryClient();
  const voidReceivable = useApiMutation('adminVoidReceivable', {
    invalidate: () => invalidateTenant(queryClient, receivable.tenant.id),
  });
  const [adjustment, setAdjustment] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const [errors, setErrors] = useState<{
    adjustment?: string;
    reason?: string;
  }>({});
  const [failure, setFailure] = useState<{
    error: unknown;
    kind: ReceivableActionFailure<'reason'>;
  } | null>(null);
  const { tenant } = receivable;
  const amount = formatMoney({
    currency: tenant.currency,
    amount: receivable.amount,
  });
  const stale = failure?.kind.kind === 'stale' ? failure.kind : null;
  const superseded = current === undefined;
  const blocked = stale !== null || superseded || refresh !== 'fresh';
  const locked = voidReceivable.isPending || stale !== null || superseded;

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (blocked) return;
    const reasonError = validateReason(reason);
    setErrors({
      ...(adjustment ? {} : { adjustment: '请选择冲正调账' }),
      ...(reasonError ? { reason: reasonError } : {}),
    });
    if (!adjustment || reasonError) return;
    setFailure(null);
    try {
      await voidReceivable.mutateAsync({
        params: { id: receivable.ledgerEntryId },
        body: { adjustmentLedgerEntryId: adjustment, reason },
      });
      onDone();
    } catch (error) {
      const kind = voidReceivableFailure(error);
      if (kind.kind === 'fields') setErrors(kind.errors);
      else setFailure({ error, kind });
      if (kind.kind === 'stale' || kind.kind === 'unknown') onReconcile();
    }
  }

  return (
    <ModalDialog
      open
      {...(voidReceivable.isPending
        ? {}
        : { onOpenChange: (open: boolean) => open || onClose() })}
      title="作废应收"
      description={`${tenant.code} ${tenant.name}（${tenant.currency}）`}
      className="md:w-[520px]"
      returnFocus={returnFocus}
      fallbackFocus={fallbackFocus}
    >
      <div className="flex flex-col gap-1">
        <h2 className="m-0 text-[17px] font-semibold">作废应收</h2>
        <span className="text-[13px] text-muted-foreground">
          {tenant.code} {tenant.name}（{tenant.currency}）
        </span>
      </div>
      <dl className="m-0 grid grid-cols-[auto_1fr] items-baseline gap-x-3 gap-y-1.5 rounded-[10px] bg-muted px-4 py-3.5 text-[13px] tabular-nums">
        <dt className="text-muted-foreground">赊账金额</dt>
        <dd className="m-0 text-right text-lg font-semibold">{amount}</dd>
        <dt className="text-muted-foreground">赊账时间</dt>
        <dd className="m-0 text-right">
          {formatDateTime(receivable.createdAt)} · {receivable.actor.name}
        </dd>
        <dt className="text-muted-foreground">备注</dt>
        <dd className="m-0 text-right break-all">
          {receivable.internalNote || '—'}
        </dd>
      </dl>
      <p className="m-0 text-[13px] leading-relaxed text-muted-foreground">
        作废表示这笔赊账不再收款，作废本身不改余额：须先用一笔金额相反的调账冲正余额，再选择那笔调账。作废后不能再确认收款；记入操作日志。
      </p>
      <form
        aria-label="作废应收"
        noValidate
        onSubmit={(event) => void submit(event)}
        className="flex flex-col gap-4"
      >
        <Candidates
          receivable={receivable}
          selected={adjustment}
          error={errors.adjustment}
          disabled={locked}
          onSelect={(id) => {
            setAdjustment(id);
            setErrors(({ reason }) => (reason ? { reason } : {}));
          }}
          onAdjust={onAdjust}
        />
        <ReasonField
          label="作废原因"
          value={reason}
          error={errors.reason}
          disabled={locked}
          placeholder="例如：客户合同终止，经确认不再收款"
          onChange={setReason}
        />
        <ActionOutcome
          stale={stale && { title: '未作废', message: stale.message }}
          superseded={
            superseded
              ? {
                  title: '该笔状态已变化，不能在此作废',
                  message:
                    '刷新后的列表中已没有这笔待收款，可能已被确认或作废。请关闭后核对。',
                }
              : null
          }
          failure={
            failure && {
              error: failure.error,
              unknown: failure.kind.kind === 'unknown',
              networkMessage:
                '无法确认是否已作废。请在列表刷新后核对该笔状态再操作。',
            }
          }
          refresh={refresh}
          onRetryRefresh={onRetryRefresh}
          pending={voidReceivable.isPending}
        />
        <div className="flex flex-col-reverse gap-2 md:flex-row md:justify-end">
          <Button
            variant="outline"
            className="h-12 md:h-9"
            disabled={voidReceivable.isPending}
            onClick={onClose}
          >
            {stale || superseded ? '关闭' : '取消'}
          </Button>
          {stale ? null : (
            <Button
              type="submit"
              variant="danger"
              className="h-12 md:h-9"
              disabled={voidReceivable.isPending || blocked}
            >
              作废 {amount}
            </Button>
          )}
        </div>
      </form>
    </ModalDialog>
  );
}
