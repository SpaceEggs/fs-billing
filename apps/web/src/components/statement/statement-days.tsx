import type { Currency } from '@fs-billing/shared';
import {
  formatStatementCalls,
  formatStatementMinutes,
  sumStatementRows,
  type StatementDayRow,
} from '../../lib/statements';
import { Money } from '../data-format';

const calls = formatStatementCalls;
const minutes = (value: string) => `${formatStatementMinutes(value)}分钟`;

/**
 * 按日汇总（决定 23）：`days` 已补零，区间内每天一行，标题显示区间天数；
 * `today` 是进行中月份的当天，加「今日 · 截至当前」标记。电脑用表，手机用卡片。
 */
export function StatementDays({
  currency,
  days,
  today,
}: {
  currency: Currency;
  days: readonly StatementDayRow[];
  today?: string | null;
}) {
  const sums = sumStatementRows(days);
  const money = (amount: string) => ({ currency, amount });
  return (
    <section
      aria-label="按日汇总"
      className="overflow-hidden rounded-xl border border-border"
    >
      <div className="flex items-baseline justify-between px-5 py-3.5">
        <h2 className="m-0 text-base font-semibold">按日汇总</h2>
        <span className="text-xs text-muted-foreground">{days.length} 天</span>
      </div>
      <table className="hidden w-full border-collapse text-[13px] whitespace-nowrap md:table">
        <thead>
          <tr className="bg-muted text-xs text-muted-foreground">
            <th className="px-5 py-2 text-left font-medium">日期</th>
            <th className="px-3 py-2 text-right font-medium">通话数</th>
            <th className="px-3 py-2 text-right font-medium">计费分钟</th>
            <th className="px-5 py-2 text-right font-medium">费用</th>
          </tr>
        </thead>
        <tbody className="tabular-nums">
          {days.map((row) => (
            <tr key={row.day} className="border-t border-border">
              <td className="px-5 py-2">
                <span className="flex items-center gap-2">
                  {row.day}
                  {row.day === today ? <TodayTag /> : null}
                </span>
              </td>
              <td className="px-3 py-2 text-right">{calls(row.calls)}</td>
              <td className="px-3 py-2 text-right">{minutes(row.minutes)}</td>
              <td className="px-5 py-2 text-right font-medium">
                <Money value={money(row.charge)} tone="plain" />
              </td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr className="border-t border-border bg-muted font-semibold tabular-nums">
            <td className="px-5 py-2.5">合计</td>
            <td className="px-3 py-2.5 text-right">{calls(sums.calls)}</td>
            <td className="px-3 py-2.5 text-right">{minutes(sums.minutes)}</td>
            <td className="px-5 py-2.5 text-right">
              <Money value={money(sums.charge)} tone="plain" />
            </td>
          </tr>
        </tfoot>
      </table>
      <div className="md:hidden">
        <div className="grid grid-cols-[1fr_1fr_1.1fr] gap-2 bg-muted px-3.5 py-2 text-xs text-muted-foreground">
          <span>日期</span>
          <span className="text-right">通话 / 分钟</span>
          <span className="text-right">费用</span>
        </div>
        {days.map((row) => (
          <div
            key={row.day}
            className="grid grid-cols-[1fr_1fr_1.1fr] gap-2 border-t border-border px-3.5 py-2 text-[13px] tabular-nums"
          >
            <span className="flex flex-col">
              {row.day.slice(5)}
              {row.day === today ? <TodayTag /> : null}
            </span>
            <span className="text-right text-muted-foreground">
              {calls(row.calls)} / {formatStatementMinutes(row.minutes)}
            </span>
            <span className="text-right font-medium">
              <Money value={money(row.charge)} tone="plain" />
            </span>
          </div>
        ))}
        <div className="grid grid-cols-[1fr_1fr_1.1fr] gap-2 border-t border-border bg-muted px-3.5 py-2.5 text-[13px] font-semibold tabular-nums">
          <span>合计</span>
          <span className="text-right">
            {calls(sums.calls)} / {formatStatementMinutes(sums.minutes)}
          </span>
          <span className="text-right">
            <Money value={money(sums.charge)} tone="plain" />
          </span>
        </div>
      </div>
    </section>
  );
}

function TodayTag() {
  return (
    <span className="w-fit rounded-[4px] border border-border px-[5px] text-[11px] text-muted-foreground">
      今日 · 截至当前
    </span>
  );
}
