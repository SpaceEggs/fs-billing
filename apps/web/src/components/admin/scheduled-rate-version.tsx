import { useQueryClient } from '@tanstack/react-query';
import type { AdminRateVersion, Currency } from '@fs-billing/shared';
import { invalidateTenant, useApiMutation } from '../../lib/admin-api';
import { formatDateTime } from '../../lib/format';
import {
  cancelFailureMessage,
  countChanges,
  diffRateTables,
} from '../../lib/rates';
import { Button } from '../ui/button';
import { ModalDialog } from '../modal-dialog';
import { ProblemAlert } from './problem-alert';
import { RateChangesTable } from './rate-changes-table';

/**
 * 排定的新版本（设计稿第二批 7b、CSV 导入原型）。变动由前端比较该版本与前一版本的整表得出，
 * `previous` 须是未经搜索过滤的完整表。变动直接列出（稿 7b、7c）。可导出该版本的 CSV（G11）。
 * 手机只看，不显示导出和取消。
 */
export function ScheduledRateVersion({
  version,
  previous,
  currency,
  exporting,
  onExport,
  onCancel,
}: {
  version: AdminRateVersion;
  previous: AdminRateVersion;
  currency: Currency;
  exporting: boolean;
  onExport: () => void;
  onCancel: () => void;
}) {
  const changes = diffRateTables(previous.entries, version.entries);
  const counts = countChanges(changes);
  return (
    <section
      aria-label="排定的新版本"
      className="flex flex-col gap-3 rounded-xl border border-brand-border bg-brand-soft px-3.5 py-3 md:px-[18px] md:py-3.5"
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <span className="inline-flex h-[22px] items-center rounded-md bg-primary px-2 text-xs font-semibold text-primary-foreground">
          排定的新版本
        </span>
        <span className="text-sm tabular-nums">
          <time dateTime={version.effectiveFrom} className="font-semibold">
            {formatDateTime(version.effectiveFrom)}
          </time>{' '}
          起生效 · 新增 {counts.added} · 修改 {counts.modified} · 删除{' '}
          {counts.deleted}
        </span>
        <span className="flex-1" />
        <Button
          variant="outline"
          size="sm"
          className="hidden bg-background md:inline-flex"
          disabled={exporting}
          onClick={onExport}
        >
          导出 CSV
        </Button>
        <Button
          variant="outline"
          size="sm"
          className="hidden bg-background md:inline-flex"
          onClick={onCancel}
        >
          取消排定
        </Button>
      </div>
      {changes.length ? (
        <div className="max-h-[320px] overflow-auto rounded-lg border border-border bg-card">
          <RateChangesTable changes={changes} currency={currency} />
        </div>
      ) : null}
    </section>
  );
}

/** 取消排定的确认。服务端按数据库时间拒绝临近生效（默认 60 秒内）的取消，返回 409。 */
export function CancelScheduledDialog({
  tenantId,
  version,
  onClose,
  onDone,
}: {
  tenantId: string;
  version: AdminRateVersion;
  onClose: () => void;
  onDone: (changed: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const cancel = useApiMutation('adminRateCancelFutureVersion', {
    invalidate: (client, input) =>
      invalidateTenant(client, input.params.tenantId),
  });
  const refresh = () => {
    void invalidateTenant(queryClient, tenantId);
    onClose();
  };
  async function confirm() {
    try {
      const result = await cancel.mutateAsync({
        params: { tenantId },
        body: { versionId: version.id },
      });
      onDone(result.auditId !== null);
    } catch {
      // 失败说明由 cancel.error 显示。
    }
  }
  const title = '取消排定的新版本？';
  const knownFailure = cancel.error ? cancelFailureMessage(cancel.error) : null;
  return (
    <ModalDialog
      open
      {...(cancel.isPending
        ? {}
        : { onOpenChange: (open: boolean) => open || onClose() })}
      title={title}
    >
      <div className="flex flex-col gap-1.5">
        <h2 className="m-0 text-[17px] font-semibold">{title}</h2>
        <span className="text-sm leading-relaxed text-muted-foreground">
          原定{' '}
          <span className="tabular-nums">
            {formatDateTime(version.effectiveFrom)}
          </span>{' '}
          起生效的新版本将被删除，当前版本继续生效。将记入操作日志。
        </span>
      </div>
      {cancel.error ? (
        knownFailure ? (
          <div
            role="alert"
            className="flex items-start gap-3 rounded-lg border border-err-border bg-err-soft px-3 py-2.5 text-[13px] text-err"
          >
            <span className="flex-1 font-semibold">{knownFailure}</span>
            <Button variant="outline" size="sm" onClick={refresh}>
              刷新
            </Button>
          </div>
        ) : (
          <ProblemAlert
            error={cancel.error}
            networkMessage="无法确认是否已取消，请刷新费率表核对后再操作。"
            onRefresh={refresh}
          />
        )
      ) : null}
      <div className="flex flex-col-reverse gap-2 md:flex-row md:justify-end">
        <Button
          variant="outline"
          className="h-12 md:h-9"
          disabled={cancel.isPending}
          onClick={onClose}
        >
          暂不取消
        </Button>
        <Button
          className="h-12 bg-destructive text-white md:h-9"
          disabled={cancel.isPending}
          onClick={() => void confirm()}
        >
          取消排定
        </Button>
      </div>
    </ModalDialog>
  );
}
