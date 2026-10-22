import type { Currency } from '@fs-billing/shared';
import {
  countryShare,
  formatStatementCalls,
  formatStatementMinutes,
  sumStatementRows,
  type StatementCountryRow,
} from '../../lib/statements';
import { Money } from '../data-format';

const calls = formatStatementCalls;
const minutes = (value: string) => `${formatStatementMinutes(value)}分钟`;

/**
 * 按国家汇总（决定 21）：只按国家分组、按费用从高到低，带由费用算出的「占比」；
 * 合计行是各行之和，占比以各行费用合计为分母。电脑用表，手机用卡片。
 */
export function StatementCountries({
  currency,
  countries,
}: {
  currency: Currency;
  countries: readonly StatementCountryRow[];
}) {
  const sums = sumStatementRows(countries);
  const money = (amount: string) => ({ currency, amount });
  return (
    <section
      aria-label="按国家汇总"
      className="overflow-hidden rounded-xl border border-border"
    >
      <div className="flex items-baseline justify-between px-5 py-3.5">
        <h2 className="m-0 text-base font-semibold">按国家汇总</h2>
        <span className="text-xs text-muted-foreground">按费用从高到低</span>
      </div>
      {countries.length === 0 ? (
        <p className="m-0 border-t border-border px-5 py-6 text-center text-[13px] text-muted-foreground">
          该月没有已接通的通话
        </p>
      ) : (
        <>
          <table className="hidden w-full border-collapse text-[13px] whitespace-nowrap md:table">
            <thead>
              <tr className="bg-muted text-xs text-muted-foreground">
                <th className="px-5 py-2 text-left font-medium">国家</th>
                <th className="px-3 py-2 text-right font-medium">通话数</th>
                <th className="px-3 py-2 text-right font-medium">计费分钟</th>
                <th className="px-3 py-2 text-right font-medium">占比</th>
                <th className="px-5 py-2 text-right font-medium">费用</th>
              </tr>
            </thead>
            <tbody className="tabular-nums">
              {countries.map((row) => (
                <tr key={row.country} className="border-t border-border">
                  <td className="px-5 py-2.5">{row.country}</td>
                  <td className="px-3 py-2.5 text-right">{calls(row.calls)}</td>
                  <td className="px-3 py-2.5 text-right">
                    {minutes(row.minutes)}
                  </td>
                  <td className="px-3 py-2.5 text-right text-muted-foreground">
                    {countryShare(row.charge, sums.charge)}
                  </td>
                  <td className="px-5 py-2.5 text-right font-medium">
                    <Money value={money(row.charge)} tone="plain" />
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="border-t border-border bg-muted font-semibold tabular-nums">
                <td className="px-5 py-2.5">合计</td>
                <td className="px-3 py-2.5 text-right">{calls(sums.calls)}</td>
                <td className="px-3 py-2.5 text-right">
                  {minutes(sums.minutes)}
                </td>
                <td className="px-3 py-2.5" />
                <td className="px-5 py-2.5 text-right">
                  <Money value={money(sums.charge)} tone="plain" />
                </td>
              </tr>
            </tfoot>
          </table>
          <ul className="m-0 list-none p-0 md:hidden">
            {countries.map((row) => (
              <li
                key={row.country}
                className="flex items-center justify-between border-t border-border px-3.5 py-2.5 tabular-nums"
              >
                <span className="flex flex-col gap-0.5">
                  <span className="text-sm">{row.country}</span>
                  <span className="text-xs text-muted-foreground">
                    {calls(row.calls)} 通 · {minutes(row.minutes)} ·{' '}
                    {countryShare(row.charge, sums.charge)}
                  </span>
                </span>
                <span className="text-sm font-semibold">
                  <Money value={money(row.charge)} tone="plain" />
                </span>
              </li>
            ))}
            <li className="flex items-center justify-between border-t border-border bg-muted px-3.5 py-2.5 text-sm font-semibold tabular-nums">
              <span>
                合计 · {calls(sums.calls)} 通 · {minutes(sums.minutes)}
              </span>
              <Money value={money(sums.charge)} tone="plain" />
            </li>
          </ul>
        </>
      )}
    </section>
  );
}
