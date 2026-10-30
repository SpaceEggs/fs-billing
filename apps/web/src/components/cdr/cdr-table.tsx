import {
  Table,
  TableHeader,
  TableRow,
  TableHead,
  TableBody,
  TableCell,
} from '@/components/ui/table';
import type { Currency, PortalCdr } from '@fs-billing/shared';
import { Button } from '../ui/button';
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
      <Table className="whitespace-nowrap">
        <TableHeader>
          <TableRow className="border-t-0">
            <TableHead className="px-4">接通时间 ↓</TableHead>
            <TableHead>主叫号码</TableHead>
            <TableHead>被叫号码</TableHead>
            <TableHead>国家</TableHead>
            <TableHead className="text-right">通话时长</TableHead>
            <TableHead className="text-right">计费时长</TableHead>
            <TableHead className="text-right">
              费率（{cdrRateUnit[currency]}）
            </TableHead>
            <TableHead className="px-4 text-right">费用</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody className="tabular-nums">
          {items.map((cdr) => (
            <TableRow
              key={cdr.callUuid}
              onClick={() => onSelect(cdr)}
              className={cn('cursor-pointer hover:bg-muted/50', muted(cdr))}
            >
              <TableCell className="px-4">
                <span className="flex items-center gap-2">
                  <Button
                    variant="ghost"
                    size="inline"
                    onClick={(event) => {
                      event.stopPropagation();
                      onSelect(cdr);
                    }}
                    aria-label={`查看话单详情 ${cdr.callee}`}
                    className="text-left hover:bg-transparent"
                  >
                    <DateTime value={cdrMoment(cdr)} />
                  </Button>
                  {badge?.(cdr)}
                </span>
              </TableCell>
              <TableCell>{cdr.caller}</TableCell>
              <TableCell>{cdr.callee}</TableCell>
              <TableCell>{cdrCountryLabel(cdr)}</TableCell>
              <TableCell className="text-right">
                {formatDuration(cdr.durationSeconds)}
              </TableCell>
              <TableCell className="text-right">
                {formatMinutes(cdr.billedMinutes)}
              </TableCell>
              <TableCell className="text-right">
                {cdr.rate === null ? '—' : <Rate value={cdr.rate} />}
              </TableCell>
              <TableCell className="px-4 text-right font-medium">
                <Money value={{ currency, amount: cdr.charge }} tone="plain" />
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
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
