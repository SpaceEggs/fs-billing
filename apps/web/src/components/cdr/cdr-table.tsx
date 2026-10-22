import type { Currency, PortalCdr } from '@fs-billing/shared';
import { formatDuration } from '../../lib/duration';
import { cn } from '../../lib/utils';
import { DateTime, Money, Rate } from '../data-format';
import {
  cdrCountryLabel,
  cdrMoment,
  cdrRateUnit,
  cdrShortMoment,
  formatMinutes,
} from './cdr-format';

type ListProps<Row extends PortalCdr> = {
  currency: Currency;
  items: readonly Row[];
  onSelect: (cdr: Row) => void;
  /** 后台在时间旁加「未经验证」标签；门户不传。 */
  badge?: ((cdr: Row) => React.ReactNode) | undefined;
};

const muted = (cdr: PortalCdr) =>
  cdr.answeredAt === null && 'text-muted-foreground';

/** 电脑版话单表（设计稿 2a）。整行可点开详情，时间是键盘可达的按钮。 */
export function CdrTable<Row extends PortalCdr>({
  currency,
  items,
  onSelect,
  badge,
}: ListProps<Row>) {
  return (
    <div className="hidden overflow-x-auto rounded-[10px] border border-border md:block">
      <table className="w-full border-collapse text-[13px] whitespace-nowrap">
        <thead>
          <tr className="bg-muted text-xs text-muted-foreground">
            <th className="px-4 py-2.5 text-left font-medium">接通时间 ↓</th>
            <th className="px-3 py-2.5 text-left font-medium">主叫号码</th>
            <th className="px-3 py-2.5 text-left font-medium">被叫号码</th>
            <th className="px-3 py-2.5 text-left font-medium">国家</th>
            <th className="px-3 py-2.5 text-right font-medium">通话时长</th>
            <th className="px-3 py-2.5 text-right font-medium">计费时长</th>
            <th className="px-3 py-2.5 text-right font-medium">
              费率（{cdrRateUnit[currency]}）
            </th>
            <th className="px-4 py-2.5 text-right font-medium">费用</th>
          </tr>
        </thead>
        <tbody className="tabular-nums">
          {items.map((cdr) => (
            <tr
              key={cdr.callUuid}
              onClick={() => onSelect(cdr)}
              className={cn(
                'cursor-pointer border-t border-border hover:bg-muted/50',
                muted(cdr),
              )}
            >
              <td className="px-4 py-[11px]">
                <span className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={(event) => {
                      event.stopPropagation();
                      onSelect(cdr);
                    }}
                    aria-label={`查看话单详情 ${cdr.callee}`}
                    className="rounded-sm text-left outline-none focus-visible:ring-[3px] focus-visible:ring-ring"
                  >
                    <DateTime value={cdrMoment(cdr)} />
                  </button>
                  {badge?.(cdr)}
                </span>
              </td>
              <td className="px-3 py-[11px]">{cdr.caller}</td>
              <td className="px-3 py-[11px]">{cdr.callee}</td>
              <td className="px-3 py-[11px]">{cdrCountryLabel(cdr)}</td>
              <td className="px-3 py-[11px] text-right">
                {formatDuration(cdr.durationSeconds)}
              </td>
              <td className="px-3 py-[11px] text-right">
                {formatMinutes(cdr.billedMinutes)}
              </td>
              <td className="px-3 py-[11px] text-right">
                {cdr.rate === null ? '—' : <Rate value={cdr.rate} />}
              </td>
              <td className="px-4 py-[11px] text-right font-medium">
                <Money value={{ currency, amount: cdr.charge }} tone="plain" />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** 手机版话单卡片（设计稿 2d）：被叫号码与费用一行，国家、时长与时间一行。 */
export function CdrCards<Row extends PortalCdr>({
  currency,
  items,
  onSelect,
  badge,
}: ListProps<Row>) {
  return (
    <ul className="m-0 flex list-none flex-col gap-2 p-0 md:hidden">
      {items.map((cdr) => (
        <li key={cdr.callUuid}>
          <button
            type="button"
            onClick={() => onSelect(cdr)}
            aria-label={`查看话单详情 ${cdr.callee}`}
            className={cn(
              'flex w-full flex-col gap-1.5 rounded-[10px] border border-border px-3.5 py-3 text-left tabular-nums outline-none focus-visible:ring-[3px] focus-visible:ring-ring',
              muted(cdr),
            )}
          >
            <span className="flex items-center justify-between gap-2 text-[15px] font-medium">
              <span className="flex items-center gap-2">
                {cdr.callee}
                {badge?.(cdr)}
              </span>
              <Money value={{ currency, amount: cdr.charge }} tone="plain" />
            </span>
            <span className="flex justify-between gap-2 text-xs text-muted-foreground">
              <span className="truncate">
                {cdrCountryLabel(cdr)} · {formatDuration(cdr.durationSeconds)}
              </span>
              <span className="whitespace-nowrap">{cdrShortMoment(cdr)}</span>
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}
