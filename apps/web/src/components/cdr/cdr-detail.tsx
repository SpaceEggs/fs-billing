import type { Currency, PortalCdr } from '@fs-billing/shared';
import { formatDateTime } from '../../lib/format';
import { formatDuration } from '../../lib/duration';
import { cn } from '../../lib/utils';
import { Money, Rate } from '../data-format';
import { ModalDialog } from '../modal-dialog';
import {
  cdrCountryLabel,
  cdrHangupCause,
  cdrRateUnit,
  formatMinutes,
} from './cdr-format';

type DetailRow = { label: string; value: React.ReactNode; mono?: boolean };

/** 后台在详情里多出的内容：开头的几行与末尾的说明框；门户不传。 */
export type CdrDetailExtra = {
  rows: readonly DetailRow[];
  note: React.ReactNode;
};

function detailRows(cdr: PortalCdr): DetailRow[] {
  const dash = '—';
  return [
    { label: '主叫号码', value: cdr.caller },
    { label: '被叫号码', value: cdr.callee },
    { label: '国家', value: cdrCountryLabel(cdr) },
    { label: '匹配的前缀', value: cdr.matchedPrefix ?? dash, mono: true },
    { label: '振铃开始', value: formatDateTime(cdr.startedAt) },
    {
      label: '接通时间',
      value: cdr.answeredAt === null ? dash : formatDateTime(cdr.answeredAt),
    },
    { label: '挂断时间', value: formatDateTime(cdr.endedAt) },
    { label: '通话时长', value: formatDuration(cdr.durationSeconds) },
    { label: '计费时长', value: formatMinutes(cdr.billedMinutes) },
    {
      label: '费率',
      value: cdr.rate === null ? dash : <Rate value={cdr.rate} />,
    },
    { label: '挂断原因', value: cdrHangupCause(cdr) },
    { label: '通话 UUID', value: cdr.callUuid, mono: true },
  ];
}

/**
 * 话单详情（设计稿 2b、2g）：电脑居中对话框，手机底部弹出。
 * 费用显示存储的精确值，列表为两位小数的舍入值。
 */
export function CdrDetailDialog({
  cdr,
  currency,
  onClose,
  extra,
}: {
  cdr: PortalCdr | null;
  currency: Currency;
  onClose: () => void;
  extra?: ((cdr: PortalCdr) => CdrDetailExtra) | undefined;
}) {
  const rows = cdr ? detailRows(cdr) : [];
  const more = cdr && extra ? extra(cdr) : null;
  return (
    <ModalDialog
      open={cdr !== null}
      onOpenChange={(open) => open || onClose()}
      title="话单详情"
      className="gap-0 px-0 md:w-[540px] md:gap-0 md:p-0"
    >
      {cdr ? (
        <>
          <div className="flex flex-col gap-1 border-b border-border px-4 pb-3 md:px-6 md:pt-5 md:pb-4">
            <span className="text-[17px] font-semibold">话单详情</span>
            <span className="text-[13px] text-muted-foreground tabular-nums">
              {cdr.callee} · {cdrCountryLabel(cdr)}
            </span>
          </div>
          <div className="mx-4 mt-3 flex items-baseline justify-between gap-3 rounded-[10px] bg-muted p-3.5 tabular-nums md:mx-0 md:mt-0 md:rounded-none md:px-6 md:py-4">
            <span className="text-[13px] text-muted-foreground">
              {cdr.rate === null ? (
                '未接通'
              ) : (
                <>
                  {formatMinutes(cdr.billedMinutes)} × <Rate value={cdr.rate} />
                  {` ${cdrRateUnit[currency]}`}
                </>
              )}
            </span>
            <Money
              value={{ currency, amount: cdr.charge }}
              tone="plain"
              exact
              className="text-[22px] font-semibold md:text-2xl"
            />
          </div>
          <dl className="m-0 grid grid-cols-[104px_1fr] px-4 pt-2 pb-5 text-sm tabular-nums md:grid-cols-[120px_1fr] md:px-6">
            {[...(more?.rows ?? []), ...rows].map((row) => (
              <div key={row.label} className="contents">
                <dt className="border-b border-border py-[9px] text-muted-foreground">
                  {row.label}
                </dt>
                <dd
                  className={cn(
                    'm-0 border-b border-border py-[9px] break-all',
                    row.mono && 'font-mono text-[13px]',
                  )}
                >
                  {row.value}
                </dd>
              </div>
            ))}
          </dl>
          {more?.note ? (
            <div className="mx-4 mb-5 md:mx-6">{more.note}</div>
          ) : null}
        </>
      ) : null}
    </ModalDialog>
  );
}
