import {
  Table,
  TableHeader,
  TableRow,
  TableHead,
  TableBody,
  TableCell,
  TableFooter,
} from '@/components/ui/table';
import { useTranslation } from 'react-i18next';
import type { Currency } from '@fs-billing/shared';
import {
  hasUnmatchedCharge,
  sumRows,
  unmatchedChargeNote,
  type StatementDay,
  type StatementFigures,
} from '../../lib/statement';
import { formatCount, formatMinutes } from '../cdr/cdr-format';
import { formatDay, formatMonthDay } from '../../lib/format';
import { Money } from '../data-format';
import { useLocale } from '../../i18n';

/**
 * 按日汇总（设计稿 2a、2b，决定 23）：区间内每一天一行，没有通话的日子补零；
 * 标题旁写区间天数（如「29 天」）。`today` 是进行中月份的当天，标「今日 · 截至当前」。
 * 合计行是各日之和；头部的通话扣费（来自流水）与之不等时，表下写一行说明。电脑用表，手机用「通话 / 分钟」两列的卡片。
 */
export function StatementDays({
  currency,
  days,
  figures,
  today,
}: {
  currency: Currency;
  /** 已补零的每一天，按日期升序。 */
  days: readonly StatementDay[];
  figures: StatementFigures;
  today?: string | undefined;
}) {
  const { t } = useTranslation(['statement']);
  const locale = useLocale();
  const money = (amount: string) => ({ currency, amount });
  const total = sumRows(days);
  const totalMinutes = formatMinutes(total.minutes, locale);
  const unmatched = hasUnmatchedCharge(figures.callCharges, days);
  const dayCount = t('statement:day.days', { n: days.length });
  return (
    <section
      aria-label={t('statement:day.label')}
      className="flex flex-col gap-2 md:gap-0 md:overflow-hidden md:rounded-xl md:border md:border-border"
    >
      <div className="flex items-baseline justify-between md:px-5 md:py-3.5">
        <h2 className="m-0 text-[15px] font-semibold md:text-base">
          {t('statement:day.label')}
        </h2>
        <span className="text-xs text-muted-foreground">{dayCount}</span>
      </div>
      <Table className="hidden whitespace-nowrap md:table">
        <TableHeader>
          <TableRow className="border-t-0">
            <TableHead className="px-5 py-[9px]">
              {t('statement:day.day')}
            </TableHead>
            <TableHead className="py-[9px] text-right">
              {t('statement:day.calls')}
            </TableHead>
            <TableHead className="py-[9px] text-right">
              {t('statement:day.minutes')}
            </TableHead>
            <TableHead className="px-5 py-[9px] text-right">
              {t('statement:day.charge')}
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody className="tabular-nums">
          {days.map((row) => (
            <TableRow key={row.day} className="print:break-inside-avoid">
              <TableCell className="px-5 py-2">
                <div className="flex flex-wrap items-center gap-2">
                  {formatDay(row.day, locale)}
                  {row.day === today ? (
                    <span className="rounded border border-border px-[5px] text-[11px] text-muted-foreground">
                      {t('statement:day.today')}
                    </span>
                  ) : null}
                </div>
              </TableCell>
              <TableCell className="py-2 text-right">
                {formatCount(row.calls)}
              </TableCell>
              <TableCell className="py-2 text-right">
                {formatMinutes(row.minutes, locale)}
              </TableCell>
              <TableCell className="px-5 py-2 text-right font-medium">
                <Money value={money(row.charge)} tone="plain" />
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
        <TableFooter>
          <TableRow>
            <TableCell className="px-5 py-2.5">
              {t('statement:day.total')}
            </TableCell>
            <TableCell className="py-2.5 text-right">
              {formatCount(total.calls)}
            </TableCell>
            <TableCell className="py-2.5 text-right">{totalMinutes}</TableCell>
            <TableCell className="px-5 py-2.5 text-right">
              <Money value={money(total.charge)} tone="plain" />
            </TableCell>
          </TableRow>
        </TableFooter>
      </Table>
      <div className="overflow-hidden rounded-xl border border-border tabular-nums md:hidden">
        <div className="grid grid-cols-[1fr_1fr_1.1fr] gap-2 bg-muted px-3.5 py-2 text-xs text-muted-foreground">
          <span>{t('statement:day.day')}</span>
          <span className="whitespace-nowrap text-right">
            {t('statement:day.mobileHeader')}
          </span>
          <span className="text-right">{t('statement:day.charge')}</span>
        </div>
        <ul className="m-0 list-none p-0">
          {days.map((row) => (
            <li
              key={row.day}
              className="grid grid-cols-[1fr_1fr_1.1fr] gap-2 border-t border-border px-3.5 py-2 text-[13px]"
            >
              <span>
                {formatMonthDay(row.day, locale)}
                {row.day === today ? (
                  <span className="ml-1.5 text-[11px] text-muted-foreground">
                    {t('statement:day.todayShort')}
                  </span>
                ) : null}
              </span>
              <span className="whitespace-nowrap text-right text-muted-foreground">
                {formatCount(row.calls)} / {formatMinutes(row.minutes, locale)}
              </span>
              <span className="text-right font-medium">
                <Money value={money(row.charge)} tone="plain" />
              </span>
            </li>
          ))}
        </ul>
      </div>
      {unmatched ? (
        <p className="m-0 text-xs text-muted-foreground md:border-t md:border-border md:px-5 md:py-2.5">
          {unmatchedChargeNote(locale)}
        </p>
      ) : null}
    </section>
  );
}
