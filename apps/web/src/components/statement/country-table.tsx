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
  chargeShare,
  hasUnmatchedCharge,
  sumRows,
  unmatchedChargeNote,
  type StatementCountry,
  type StatementFigures,
} from '../../lib/statement';
import { formatCount, formatMinutes } from '../cdr/cdr-format';
import { Money } from '../data-format';
import { useLocale } from '../../i18n';

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
  const { t } = useTranslation(['statement']);
  const locale = useLocale();
  const money = (amount: string) => ({ currency, amount });
  const total = sumRows(countries);
  const totalMinutes = formatMinutes(total.minutes, locale);
  const unmatched = hasUnmatchedCharge(figures.callCharges, countries);
  return (
    <section
      aria-label={t('statement:country.label')}
      className="flex flex-col gap-2 md:gap-0 md:overflow-hidden md:rounded-xl md:border md:border-border print:break-inside-avoid"
    >
      <div className="flex items-baseline justify-between md:px-5 md:py-3.5">
        <h2 className="m-0 text-[15px] font-semibold md:text-base">
          {t('statement:country.label')}
        </h2>
        <span className="text-xs text-muted-foreground">
          <span className="md:hidden">
            {t('statement:country.callsMinutes', {
              calls: formatCount(total.calls),
              minutes: totalMinutes,
            })}
          </span>
          <span className="hidden md:inline">
            {t('statement:country.byCharge')}
          </span>
        </span>
      </div>
      <Table className="hidden whitespace-nowrap md:table">
        <TableHeader>
          <TableRow className="border-t-0">
            <TableHead className="px-5 py-[9px]">
              {t('statement:country.country')}
            </TableHead>
            <TableHead className="py-[9px] text-right">
              {t('statement:country.calls')}
            </TableHead>
            <TableHead className="py-[9px] text-right">
              {t('statement:country.minutes')}
            </TableHead>
            <TableHead className="py-[9px] text-right">
              {t('statement:country.share')}
            </TableHead>
            <TableHead className="px-5 py-[9px] text-right">
              {t('statement:country.charge')}
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody className="tabular-nums">
          {countries.length === 0 ? (
            <TableRow>
              <TableCell
                colSpan={5}
                className="px-5 py-5 text-center text-muted-foreground"
              >
                {t('statement:country.empty')}
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
                {formatMinutes(row.minutes, locale)}
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
            <TableCell className="px-5 py-2.5">
              {t('statement:country.total')}
            </TableCell>
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
            {t('statement:country.empty')}
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
                {t('statement:country.callsMinutes', {
                  calls: formatCount(row.calls),
                  minutes: formatMinutes(row.minutes, locale),
                })}
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
          {unmatchedChargeNote(locale)}
        </p>
      ) : null}
    </section>
  );
}
