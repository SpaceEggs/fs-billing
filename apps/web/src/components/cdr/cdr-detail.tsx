import { useTranslation } from 'react-i18next';
import {
  translate,
  type Currency,
  type Locale,
  type PortalCdr,
} from '@fs-billing/shared';
import { formatDateTime } from '../../lib/format';
import { formatDuration } from '../../lib/duration';
import { useLocale } from '../../i18n';
import { cn } from '../../lib/utils';
import { Badge } from '../ui/badge';
import { Money, Rate } from '../data-format';
import { ModalDialog } from '../modal-dialog';
import {
  cdrCountryLabel,
  cdrDirectionLabel,
  cdrHangupCause,
  cdrIsInbound,
  cdrRateUnit,
  formatMinutes,
} from './cdr-format';

type DetailRow = { label: string; value: React.ReactNode; mono?: boolean };

/** 后台在详情里多出的内容：开头的几行与末尾的说明框；门户不传。 */
export type CdrDetailExtra = {
  rows: readonly DetailRow[];
  note: React.ReactNode;
};

function detailRows(cdr: PortalCdr, locale: Locale): DetailRow[] {
  const dash = '—';
  const label = (key: string) => translate(locale, `cdr:detail.${key}`);
  return [
    {
      label: label('direction'),
      value: (
        <Badge variant={cdrIsInbound(cdr) ? 'secondary' : 'plain'}>
          {cdrDirectionLabel(cdr, locale)}
        </Badge>
      ),
    },
    { label: label('caller'), value: cdr.caller },
    { label: label('callee'), value: cdr.callee },
    { label: label('country'), value: cdrCountryLabel(cdr, locale) },
    {
      label: label('matchedPrefix'),
      value: cdr.matchedPrefix ?? dash,
      mono: true,
    },
    { label: label('ringStart'), value: formatDateTime(cdr.startedAt, locale) },
    {
      label: label('answeredAt'),
      value:
        cdr.answeredAt === null ? dash : formatDateTime(cdr.answeredAt, locale),
    },
    { label: label('endedAt'), value: formatDateTime(cdr.endedAt, locale) },
    {
      label: label('duration'),
      value: formatDuration(cdr.durationSeconds, locale),
    },
    { label: label('billed'), value: formatMinutes(cdr.billedMinutes, locale) },
    {
      label: label('rate'),
      value:
        cdrIsInbound(cdr) || cdr.rate === null ? (
          dash
        ) : (
          <Rate value={cdr.rate} />
        ),
    },
    { label: label('hangupCause'), value: cdrHangupCause(cdr, locale) },
    { label: label('uuid'), value: cdr.callUuid, mono: true },
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
  const { t } = useTranslation(['cdr']);
  const locale = useLocale();
  const rows = cdr ? detailRows(cdr, locale) : [];
  const more = cdr && extra ? extra(cdr) : null;
  const title = t('cdr:detail.title');
  return (
    <ModalDialog
      open={cdr !== null}
      onOpenChange={(open) => open || onClose()}
      title={title}
      className="gap-0 px-0 md:w-[540px] md:gap-0 md:p-0"
    >
      {cdr ? (
        <>
          <div className="flex flex-col gap-1 border-b border-border px-4 pb-3 md:px-6 md:pt-5 md:pb-4">
            <span className="text-[17px] font-semibold">{title}</span>
            <span className="text-[13px] text-muted-foreground tabular-nums">
              {cdr.callee} · {cdrCountryLabel(cdr, locale)}
            </span>
          </div>
          <div className="mx-4 mt-3 flex items-baseline justify-between gap-3 rounded-[10px] bg-muted p-3.5 tabular-nums md:mx-0 md:mt-0 md:rounded-none md:px-6 md:py-4">
            <span className="text-[13px] text-muted-foreground">
              {cdrIsInbound(cdr) ? (
                t('cdr:detail.inboundFree')
              ) : cdr.rate === null ? (
                t('cdr:notConnected')
              ) : (
                <>
                  {formatMinutes(cdr.billedMinutes, locale)} ×{' '}
                  <Rate value={cdr.rate} />
                  {` ${cdrRateUnit(currency, locale)}`}
                </>
              )}
            </span>
            {cdrIsInbound(cdr) ? (
              <span className="text-[22px] font-semibold md:text-2xl">—</span>
            ) : (
              <Money
                value={{ currency, amount: cdr.charge }}
                tone="plain"
                exact
                className="text-[22px] font-semibold md:text-2xl"
              />
            )}
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
