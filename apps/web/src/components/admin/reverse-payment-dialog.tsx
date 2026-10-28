import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { AdminReceivable } from '@fs-billing/shared';
import { invalidateTenant, useApiMutation } from '../../lib/admin-api';
import { formatDateTime, formatMoney } from '../../lib/format';
import {
  reversePaymentFailure,
  validateReason,
  type ListRefresh,
  type ReceivableActionFailure,
} from '../../lib/receivables';
import { Button } from '../ui/button';
import { ModalDialog } from '../modal-dialog';
import { ActionOutcome, ReasonField } from './receivable-action';

type Received = Extract<AdminReceivable['payment'], { status: 'received' }>;

/**
 * 撤销确认：打开时那一行的 settlementId 作为请求的 settlementId，打开期间不换。
 * 刷新后的已收款列表显示该行已不在、或确认记录已变时，禁止提交并提示重新打开。
 * 409 与网络中断刷新列表；刷新完成前不允许再次提交，不自动重试。
 */
export function ReversePaymentDialog({
  receivable,
  payment,
  confirmerName,
  current,
  refresh,
  onReconcile,
  onRetryRefresh,
  returnFocus,
  fallbackFocus,
  onClose,
  onDone,
}: {
  receivable: AdminReceivable;
  /** 打开时的收款确认快照。 */
  payment: Received;
  confirmerName: string;
  /** 最新已收款列表里的同一行；不在列表里时为 undefined。 */
  current: AdminReceivable | undefined;
  refresh: ListRefresh;
  onReconcile: () => void;
  onRetryRefresh: () => void;
  returnFocus: React.RefObject<HTMLElement | null>;
  fallbackFocus: React.RefObject<HTMLElement | null>;
  onClose: () => void;
  onDone: () => void;
}) {
  const queryClient = useQueryClient();
  const reverse = useApiMutation('adminReversePayment', {
    invalidate: () => invalidateTenant(queryClient, receivable.tenant.id),
  });
  const [reason, setReason] = useState('');
  const [reasonError, setReasonError] = useState<string>();
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
  const superseded =
    current?.payment.status !== 'received' ||
    current.payment.settlementId !== payment.settlementId;
  const blocked = stale !== null || superseded || refresh !== 'fresh';

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (blocked) return;
    const found = validateReason(reason);
    setReasonError(found);
    if (found) return;
    setFailure(null);
    try {
      await reverse.mutateAsync({
        params: { id: receivable.ledgerEntryId },
        body: { settlementId: payment.settlementId, reason },
      });
      onDone();
    } catch (error) {
      const kind = reversePaymentFailure(error);
      if (kind.kind === 'fields') setReasonError(kind.errors.reason);
      else setFailure({ error, kind });
      if (kind.kind === 'stale' || kind.kind === 'unknown') onReconcile();
    }
  }

  return (
    <ModalDialog
      open
      {...(reverse.isPending
        ? {}
        : { onOpenChange: (open: boolean) => open || onClose() })}
      title="撤销确认"
      description={`${tenant.code} ${tenant.name}（${tenant.currency}）`}
      className="md:w-[480px]"
      returnFocus={returnFocus}
      fallbackFocus={fallbackFocus}
    >
      <div className="flex flex-col gap-1">
        <h2 className="m-0 text-[17px] font-semibold">撤销确认</h2>
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
        <dt className="text-muted-foreground">收款日期</dt>
        <dd className="m-0 text-right">{payment.receivedOn}</dd>
        <dt className="text-muted-foreground">确认人</dt>
        <dd className="m-0 text-right">{confirmerName}</dd>
        <dt className="text-muted-foreground">收款备注</dt>
        <dd className="m-0 text-right break-all">{payment.note || '—'}</dd>
      </dl>
      <form
        aria-label="撤销确认"
        noValidate
        onSubmit={(event) => void submit(event)}
        className="flex flex-col gap-4"
      >
        <ReasonField
          label="撤销原因"
          value={reason}
          error={reasonError}
          disabled={reverse.isPending || stale !== null || superseded}
          placeholder="例如：款项未实际到账，误确认"
          onChange={setReason}
        />
        <p className="m-0 text-[13px] leading-relaxed text-muted-foreground">
          撤销后该笔回到「待收款」，可重新确认收款；客户余额不变；记入操作日志。
        </p>
        <ActionOutcome
          stale={stale && { title: '未撤销确认', message: stale.message }}
          superseded={
            superseded
              ? {
                  title: '该笔状态已变化，不能在此撤销',
                  message:
                    current === undefined
                      ? '刷新后的列表中已没有这笔已收款，可能已由其他管理员撤销。请关闭后核对。'
                      : '刷新后的列表显示该笔的收款确认已变化。请关闭后从列表重新打开再撤销。',
                }
              : null
          }
          failure={
            failure && {
              error: failure.error,
              unknown: failure.kind.kind === 'unknown',
              networkMessage:
                '无法确认是否已撤销。请在列表刷新后核对该笔状态再操作。',
            }
          }
          refresh={refresh}
          onRetryRefresh={onRetryRefresh}
          pending={reverse.isPending}
        />
        <div className="flex flex-col-reverse gap-2 md:flex-row md:justify-end">
          <Button
            variant="outline"
            className="h-12 md:h-9"
            disabled={reverse.isPending}
            onClick={onClose}
          >
            {stale || superseded ? '关闭' : '取消'}
          </Button>
          {stale ? null : (
            <Button
              type="submit"
              variant="destructive"
              className="h-12 md:h-9"
              disabled={reverse.isPending || blocked}
            >
              撤销确认
            </Button>
          )}
        </div>
      </form>
    </ModalDialog>
  );
}
