import type { Currency } from '@fs-billing/shared';
import { cn } from '../../lib/utils';
import {
  formatStatementCalls,
  formatStatementMinutes,
} from '../../lib/statements';
import { Money } from '../data-format';

type SummaryFigures = {
  openingBalance: string;
  recharge: string;
  gift: string;
  adjustment: string;
  callCharges: string;
  closingBalance: string;
  calls: number;
  callMinutes: string;
};

const operators = ['+', '+', '±', '−', '='] as const;

/**
 * 账单算式：期初余额 + 充值 + 赠送 ± 调账 − 通话扣费 = 期末余额（设计稿 2a/2c，手机 2b/2d）。
 * 赠送、调账为零仍显示 0.00；调账为负、期末为负显示红色。电脑横排，手机竖排。
 */
export function StatementSummary({
  currency,
  figures,
}: {
  currency: Currency;
  figures: SummaryFigures;
}) {
  const money = (amount: string) => ({ currency, amount });
  const cells = [
    { label: '期初余额', amount: figures.openingBalance },
    { label: '充值', amount: figures.recharge },
    { label: '赠送', amount: figures.gift },
    { label: '调账', amount: figures.adjustment },
    {
      label: '通话扣费',
      amount: figures.callCharges,
      note: `${formatStatementCalls(figures.calls)} 通 · ${formatStatementMinutes(figures.callMinutes)}分钟`,
    },
  ];
  return (
    <section aria-label="账单汇总">
      <div className="hidden items-stretch gap-2.5 rounded-xl border border-border p-6 tabular-nums md:flex">
        {cells.map((cell, index) => (
          <div key={cell.label} className="contents">
            <div className="flex flex-1 flex-col gap-1.5">
              <span className="text-[13px] text-muted-foreground">
                {cell.label}
              </span>
              <Money
                value={money(cell.amount)}
                tone={cell.label === '调账' ? 'negative' : 'plain'}
                className="text-[22px] font-semibold"
              />
              {cell.note ? (
                <span className="text-xs text-muted-foreground">
                  {cell.note}
                </span>
              ) : null}
            </div>
            <span
              aria-hidden
              className="self-end pb-0.5 text-[22px] text-muted-foreground"
            >
              {operators[index]}
            </span>
          </div>
        ))}
        <div className="-my-3 -mr-2 flex flex-[1.2] flex-col justify-center gap-1.5 rounded-lg bg-muted px-4 py-3">
          <span className="text-[13px] text-muted-foreground">期末余额</span>
          <Money
            value={money(figures.closingBalance)}
            className="text-[26px] font-bold"
          />
        </div>
      </div>
      <dl className="m-0 flex flex-col rounded-xl border border-border px-4 py-1.5 text-[15px] tabular-nums md:hidden">
        {cells.map((cell, index) => (
          <div
            key={cell.label}
            className={cn(
              'flex justify-between py-2.5',
              index > 0 && 'border-t border-border',
            )}
          >
            <dt className="text-muted-foreground">
              <span className="inline-block w-[18px]">
                {index === 0 ? '' : ['+', '+', '±', '−'][index - 1]}
              </span>
              {cell.label}
            </dt>
            <dd className="m-0 text-right">
              <Money
                value={money(cell.amount)}
                tone={cell.label === '调账' ? 'negative' : 'plain'}
              />
              {cell.note ? (
                <span className="block text-xs text-muted-foreground">
                  {cell.note}
                </span>
              ) : null}
            </dd>
          </div>
        ))}
        <div className="flex items-baseline justify-between border-t-2 border-foreground pt-3 pb-2.5">
          <dt className="font-semibold">
            <span className="inline-block w-[18px]">=</span>期末余额
          </dt>
          <dd className="m-0">
            <Money
              value={money(figures.closingBalance)}
              className="text-[22px] font-bold"
            />
          </dd>
        </div>
      </dl>
    </section>
  );
}
