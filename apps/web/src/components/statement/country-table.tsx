import {
  Table,
  TableHeader,
  TableRow,
  TableHead,
  TableBody,
  TableCell,
  TableFooter,
} from '@/components/ui/table';
import type { Currency } from '@fs-billing/shared';
import {
  chargeShare,
  hasUnmatchedCharge,
  sumRows,
  unmatchedChargeNote,
  type StatementCountry,
  type StatementFigures,
} from '../../lib/statement';
import { formatCount, formatMinutes } from '../cdr/cdr-format';
import { Money } from '../data-format';

/**
 * 按国家汇总（设计稿 2a、2b，决定 21）：只按国家分组，列头「国家」，按费用从高到低。
 * 合计行与「占比」都以国家行为准：占比是该国费用占各行费用之和的百分比（合计 100%），由费用算出、不入库。
 * 头部的通话扣费（来自流水）与各行之和不等时，表下写一行说明。电脑用表，手机用卡片。
 */
export function StatementCountries({
  currency,
  countries,
  figures,
}: {
  currency: Currency;
  countries: readonly StatementCountry[];
  figures: StatementFigures;
}) {
  const money = (amount: string) => ({ currency, amount });
  const total = sumRows(countries);
  const totalMinutes = formatMinutes(total.minutes);
  const unmatched = hasUnmatchedCharge(figures.callCharges, countries);
  return (
    <section
      aria-label="按国家汇总"
      className="flex flex-col gap-2 md:gap-0 md:overflow-hidden md:rounded-xl md:border md:border-border print:break-inside-avoid"
    >
      <div className="flex items-baseline justify-between md:px-5 md:py-3.5">
        <h2 className="m-0 text-[15px] font-semibold md:text-base">
          按国家汇总
        </h2>
        <span className="text-xs text-muted-foreground">
          <span className="md:hidden">
            {formatCount(total.calls)} 通 · {totalMinutes}
          </span>
          <span className="hidden md:inline">按费用从高到低</span>
        </span>
      </div>
      <Table className="hidden whitespace-nowrap md:table">
        <TableHeader>
          <TableRow className="border-t-0">
            <TableHead className="px-5 py-[9px]">国家</TableHead>
            <TableHead className="py-[9px] text-right">通话数</TableHead>
            <TableHead className="py-[9px] text-right">计费分钟</TableHead>
            <TableHead className="py-[9px] text-right">占比</TableHead>
            <TableHead className="px-5 py-[9px] text-right">费用</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody className="tabular-nums">
          {countries.length === 0 ? (
            <TableRow>
              <TableCell
                colSpan={5}
                className="px-5 py-5 text-center text-muted-foreground"
              >
                没有已接通的通话
              </TableCell>
            </TableRow>
          ) : null}
          {countries.map((row) => (
            <TableRow key={row.country}>
              <TableCell className="px-5 py-2.5">{row.country}</TableCell>
              <TableCell className="py-2.5 text-right">
                {formatCount(row.calls)}
              </TableCell>
              <TableCell className="py-2.5 text-right">
                {formatMinutes(row.minutes)}
              </TableCell>
              <TableCell className="py-2.5 text-right text-muted-foreground">
                {chargeShare(row.charge, total.charge)}
              </TableCell>
              <TableCell className="px-5 py-2.5 text-right font-medium">
                <Money value={money(row.charge)} tone="plain" />
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
        <TableFooter>
          <TableRow>
            <TableCell className="px-5 py-2.5">合计</TableCell>
            <TableCell className="py-2.5 text-right">
              {formatCount(total.calls)}
            </TableCell>
            <TableCell className="py-2.5 text-right">{totalMinutes}</TableCell>
            <TableCell className="py-2.5" />
            <TableCell className="px-5 py-2.5 text-right">
              <Money value={money(total.charge)} tone="plain" />
            </TableCell>
          </TableRow>
        </TableFooter>
      </Table>
      <ul className="m-0 flex list-none flex-col overflow-hidden rounded-xl border border-border p-0 md:hidden">
        {countries.length === 0 ? (
          <li className="px-3.5 py-4 text-center text-[13px] text-muted-foreground">
            没有已接通的通话
          </li>
        ) : null}
        {countries.map((row) => (
          <li
            key={row.country}
            className="flex items-center justify-between border-b border-border px-3.5 py-2.5 last:border-b-0"
          >
            <div className="flex flex-col gap-0.5">
              <span className="text-sm">{row.country}</span>
              <span className="text-xs text-muted-foreground tabular-nums">
                {formatCount(row.calls)} 通 · {formatMinutes(row.minutes)}
              </span>
            </div>
            <span className="text-sm font-semibold tabular-nums">
              <Money value={money(row.charge)} tone="plain" />
            </span>
          </li>
        ))}
      </ul>
      {unmatched ? (
        <p className="m-0 text-xs text-muted-foreground md:border-t md:border-border md:px-5 md:py-2.5">
          {unmatchedChargeNote}
        </p>
      ) : null}
    </section>
  );
}
