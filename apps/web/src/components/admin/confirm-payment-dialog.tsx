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

/**
 * 确认收款（设计稿第二批 6c/6d）：只能整笔全额确认（决定 4），不填金额。
 * 提交列表给出的 latestSettlementId 作为 expectedLatestSettlementId；状态已变的 409 刷新列表，
 * 本对话框不再提交，管理员核对后从刷新后的行重新打开（设计文档 L169，不自动重试）。
 */
export function ConfirmPaymentDialog({
  receivable,
  onClose,
  onDone,
}: {
  receivable: AdminReceivable;
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

  async function submit(event: React.FormEvent) {
    event.preventDefault();
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
      if (kind.kind === 'stale' || kind.kind === 'unknown')
        void invalidateTenant(queryClient, tenant.id);
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
              disabled={confirm.isPending || stale !== null}
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
              disabled={confirm.isPending || stale !== null}
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
          </div>
        ) : failure ? (
          <ProblemAlert
            error={failure.error}
            networkMessage="无法确认是否已收款。列表已刷新，请核对该笔状态后再操作。"
          />
        ) : null}
        <div className="flex flex-col-reverse gap-2 md:flex-row md:justify-end">
          <Button
            variant="outline"
            className="h-12 md:h-9"
            disabled={confirm.isPending}
            onClick={onClose}
          >
            {stale ? '关闭' : '取消'}
          </Button>
          {stale ? null : (
            <Button
              type="submit"
              className="h-12 md:h-9"
              disabled={confirm.isPending}
            >
              确认收款 {amount}
            </Button>
          )}
        </div>
      </form>
    </ModalDialog>
  );
}
