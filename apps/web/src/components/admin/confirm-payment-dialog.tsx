import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { AdminReceivable } from '@fs-billing/shared';
import { invalidateTenant, useApiMutation } from '../../lib/admin-api';
import { formatDateTime, formatMoney } from '../../lib/format';
import {
  confirmPaymentFailure,
  receivedOnBounds,
  validateConfirmPayment,
  type ConfirmPaymentErrors,
  type ConfirmPaymentFailure,
  type ListRefresh,
} from '../../lib/receivables';
import { cn } from '../../lib/utils';
import { Button } from '../ui/button';
import { ModalDialog } from '../ui/dialog';
import { Input } from '../ui/input';
import { Field, invalidClass } from './form-fields';
import { ProblemAlert } from './problem-alert';

export const receivableMoney = (receivable: AdminReceivable) => ({
  currency: receivable.tenant.currency,
  amount: receivable.amount,
});

function RefreshLine({
  refresh,
  onRetry,
}: {
  refresh: ListRefresh;
  onRetry: () => void;
}) {
  if (refresh === 'fresh') return <span>列表已刷新。</span>;
  if (refresh === 'refreshing') return <span>正在刷新列表…</span>;
  return (
    <span className="flex items-center justify-between gap-2">
      <span>列表刷新失败，页面显示的可能不是最新状态。</span>
      <Button variant="outline" size="sm" onClick={onRetry}>
        重试刷新
      </Button>
    </span>
  );
}

/**
 * 确认收款（设计稿第二批 6c/6d）：只能整笔全额确认（决定 4），不填金额。
 * 提交打开时那一行的 latestSettlementId 作为 expectedLatestSettlementId，打开期间不换令牌：
 * 刷新后的列表（`current`）显示该行令牌已变或该行已不在列表时，禁止提交并提示关闭后重新打开。
 * 状态已变的 409 与网络中断都会刷新列表；刷新完成前不声称“已刷新”，也不允许再次提交（设计文档 L169，不自动重试）。
 */
export function ConfirmPaymentDialog({
  receivable,
  current,
  refresh,
  onReconcile,
  onRetryRefresh,
  returnFocus,
  onClose,
  onDone,
}: {
  receivable: AdminReceivable;
  /** 最新列表里的同一行；不在列表里时为 undefined。 */
  current: AdminReceivable | undefined;
  refresh: ListRefresh;
  /** 确认失败后刷新列表（含该租户的其他缓存）。 */
  onReconcile: () => void;
  onRetryRefresh: () => void;
  returnFocus: React.RefObject<HTMLElement | null>;
  onClose: () => void;
  onDone: () => void;
}) {
  const queryClient = useQueryClient();
  const confirm = useApiMutation('adminConfirmPayment', {
    invalidate: () => invalidateTenant(queryClient, receivable.tenant.id),
  });
  const [bounds] = useState(() => receivedOnBounds(receivable, new Date()));
  const [draft, setDraft] = useState({ receivedOn: bounds.max, note: '' });
  const [errors, setErrors] = useState<ConfirmPaymentErrors>({});
  const [failure, setFailure] = useState<{
    error: unknown;
    kind: ConfirmPaymentFailure;
  } | null>(null);
  const { tenant } = receivable;
  const amount = formatMoney(receivableMoney(receivable));
  const stale = failure?.kind.kind === 'stale' ? failure.kind : null;
  const superseded =
    current === undefined ||
    current.latestSettlementId !== receivable.latestSettlementId;
  const blocked = stale !== null || superseded || refresh !== 'fresh';

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (blocked) return;
    const found = validateConfirmPayment(draft, bounds);
    setErrors(found);
    if (Object.keys(found).length) return;
    setFailure(null);
    try {
      await confirm.mutateAsync({
        params: { id: receivable.ledgerEntryId },
        body: {
          expectedLatestSettlementId: receivable.latestSettlementId,
          receivedOn: draft.receivedOn,
          note: draft.note,
        },
      });
      onDone();
    } catch (error) {
      const kind = confirmPaymentFailure(error);
      if (kind.kind === 'fields') setErrors(kind.errors);
      else setFailure({ error, kind });
      if (kind.kind === 'stale' || kind.kind === 'unknown') onReconcile();
    }
  }

  return (
    <ModalDialog
      open
      {...(confirm.isPending
        ? {}
        : { onOpenChange: (open: boolean) => open || onClose() })}
      title="确认收款"
      description={`${tenant.code} ${tenant.name}（${tenant.currency}）`}
      className="md:w-[480px]"
      returnFocus={returnFocus}
    >
      <div className="flex flex-col gap-1">
        <h2 className="m-0 text-[17px] font-semibold">确认收款</h2>
        <span className="text-[13px] text-muted-foreground">
          {tenant.code} {tenant.name}（{tenant.currency}）
        </span>
      </div>
      <dl className="m-0 grid grid-cols-[1fr_auto] items-baseline gap-x-3 gap-y-1.5 rounded-[10px] bg-muted px-4 py-3.5 text-[13px] tabular-nums">
        <dt className="text-muted-foreground">赊账金额</dt>
        <dd className="m-0 text-right text-lg font-semibold">{amount}</dd>
        <dt className="text-muted-foreground">赊账时间</dt>
        <dd className="m-0 text-right">
          {formatDateTime(receivable.createdAt)} · {receivable.actor.name}
        </dd>
        <dt className="text-muted-foreground">已欠天数</dt>
        <dd
          className={cn(
            'm-0 text-right',
            receivable.overdue && 'font-semibold text-warn',
          )}
        >
          {receivable.ageDays} 天
        </dd>
      </dl>
      <form
        aria-label="确认收款"
        noValidate
        onSubmit={(event) => void submit(event)}
        className="flex flex-col gap-4"
      >
        <Field
          label="实际收款日期"
          required
          error={errors.receivedOn}
          hint="默认今天，可选择实际到账日期"
        >
          {(props) => (
            <Input
              {...props}
              type="date"
              min={bounds.min}
              max={bounds.max}
              disabled={confirm.isPending || stale !== null || superseded}
              value={draft.receivedOn}
              onChange={(event) =>
                setDraft({ ...draft, receivedOn: event.target.value })
              }
              className={cn('tabular-nums', invalidClass(errors.receivedOn))}
            />
          )}
        </Field>
        <Field
          label="收款备注"
          optional
          badge={
            <span className="rounded border border-border bg-muted px-1.5 py-px text-xs font-medium text-muted-foreground">
              仅内部可见
            </span>
          }
          error={errors.note}
        >
          {(props) => (
            <textarea
              {...props}
              rows={2}
              maxLength={2000}
              placeholder="例如：工行对公转账，流水号 2026092911840"
              disabled={confirm.isPending || stale !== null || superseded}
              value={draft.note}
              onChange={(event) =>
                setDraft({ ...draft, note: event.target.value })
              }
              className={cn(
                'resize-none rounded-lg border border-input bg-transparent px-3 py-2 text-base font-normal outline-none placeholder:text-muted-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:opacity-50 md:text-sm',
                invalidClass(errors.note),
              )}
            />
          )}
        </Field>
        <p className="m-0 text-[13px] leading-relaxed text-muted-foreground">
          确认后该笔状态变为「已收款」，客户余额不变；记入操作日志。
        </p>
        {stale ? (
          <div
            role="alert"
            className="flex flex-col gap-0.5 rounded-lg border border-warn-border bg-warn-soft px-3 py-2.5 text-[13px] text-warn"
          >
            <span className="font-semibold">未确认收款</span>
            <span>{stale.message}</span>
            <RefreshLine refresh={refresh} onRetry={onRetryRefresh} />
          </div>
        ) : superseded && !confirm.isPending ? (
          <div
            role="alert"
            className="flex flex-col gap-0.5 rounded-lg border border-warn-border bg-warn-soft px-3 py-2.5 text-[13px] text-warn"
          >
            <span className="font-semibold">该笔状态已变化，不能在此确认</span>
            <span>
              {current === undefined
                ? '刷新后的列表中已没有这笔待收款，可能已由其他管理员处理。请关闭后核对。'
                : '刷新后的列表显示该笔的收款记录已变化（例如确认后又被撤销）。请关闭后从列表重新打开再确认。'}
            </span>
          </div>
        ) : failure ? (
          <>
            <ProblemAlert
              error={failure.error}
              networkMessage="无法确认是否已收款。请在列表刷新后核对该笔状态再操作。"
            />
            {failure.kind.kind === 'unknown' ? (
              <p className="m-0 text-[13px] text-muted-foreground">
                <RefreshLine refresh={refresh} onRetry={onRetryRefresh} />
              </p>
            ) : null}
          </>
        ) : null}
        <div className="flex flex-col-reverse gap-2 md:flex-row md:justify-end">
          <Button
            variant="outline"
            className="h-12 md:h-9"
            disabled={confirm.isPending}
            onClick={onClose}
          >
            {stale || superseded ? '关闭' : '取消'}
          </Button>
          {stale ? null : (
            <Button
              type="submit"
              className="h-12 md:h-9"
              disabled={confirm.isPending || blocked}
            >
              确认收款 {amount}
            </Button>
          )}
        </div>
      </form>
    </ModalDialog>
  );
}
