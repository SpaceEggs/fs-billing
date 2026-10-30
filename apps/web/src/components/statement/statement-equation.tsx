import type { Currency } from '@fs-billing/shared';
import { cn } from '../../lib/utils';
import { formatCount, formatMinutes } from '../cdr/cdr-format';
import { Money } from '../data-format';
import type { StatementFigures } from '../../lib/statement';

const amountClass = 'text-[22px] leading-normal';

function Operator({ children }: { children: React.ReactNode }) {
  return (
    <span aria-hidden className="flex flex-col gap-1.5 text-muted-foreground">
      <span className="invisible text-[13px]">
        <br />
      </span>
      <span className={amountClass}>{children}</span>
    </span>
  );
}

function Term({
  label,
  className,
  children,
  note,
}: {
  label: string;
  className?: string;
  children: React.ReactNode;
  note?: React.ReactNode;
}) {
  return (
    <div className="flex min-w-fit flex-1 flex-col gap-1.5">
      <span className="text-[13px] text-muted-foreground">{label}</span>
      <span
        className={cn(
          amountClass,
          'whitespace-nowrap font-semibold',
          className,
        )}
      >
        {children}
      </span>
      {note ? (
        <span className="whitespace-nowrap text-xs text-muted-foreground">
          {note}
        </span>
      ) : null}
    </div>
  );
}

function Row({
  operator,
  label,
  className,
  children,
}: {
  operator?: string;
  label: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex justify-between border-t border-border py-2.5 first:border-t-0">
      <span className="text-muted-foreground">
        <span className="inline-block w-[18px]">{operator}</span>
        {label}
      </span>
      <span className={className}>{children}</span>
    </div>
  );
}

/**
 * 汇总算式：期初余额 + 充值 + 赠送 ± 调账 − 通话扣费 = 期末余额（设计稿 2a 与 2b）。
 * 赠送、调账为 0 仍显示 0.00；调账为负数与期末为负数用红色。电脑一行算式，手机一列明细。
 * 金额按 2 位显示，不改变账单存下的精确值（决定 26）。
 */
export function StatementEquation({
  currency,
  figures,
}: {
  currency: Currency;
  figures: StatementFigures;
}) {
  const money = (amount: string) => ({ currency, amount });
  const usageNote = `${formatCount(figures.calls)} 通 · ${formatMinutes(figures.callMinutes)}`;
  return (
    <section aria-label="账单汇总">
      <div className="hidden items-stretch gap-2.5 overflow-x-auto rounded-xl border border-border p-6 tabular-nums md:flex print:break-inside-avoid print:flex-wrap print:overflow-visible">
        <Term label="期初余额">
          <Money value={money(figures.openingBalance)} />
        </Term>
        <Operator>+</Operator>
        <Term label="充值">
          <Money value={money(figures.recharge)} tone="plain" />
        </Term>
        <Operator>+</Operator>
        <Term label="赠送">
          <Money value={money(figures.gift)} tone="plain" />
        </Term>
        <Operator>±</Operator>
        <Term label="调账">
          <Money value={money(figures.adjustment)} />
        </Term>
        <Operator>−</Operator>
        <Term label="通话扣费" note={usageNote}>
          <Money value={money(figures.callCharges)} tone="plain" />
        </Term>
        <Operator>=</Operator>
        <div className="-my-3 mr-[-8px] flex min-w-fit flex-[1.2] flex-col justify-center gap-1.5 rounded-lg bg-muted px-4 py-3">
          <span className="text-[13px] text-muted-foreground">期末余额</span>
          <span className="text-[26px] font-bold">
            <Money value={money(figures.closingBalance)} />
          </span>
        </div>
      </div>
      <div className="flex flex-col rounded-xl border border-border px-4 py-1.5 text-[15px] tabular-nums md:hidden">
        <Row label="期初余额">
          <Money value={money(figures.openingBalance)} />
        </Row>
        <Row operator="+" label="充值">
          <Money value={money(figures.recharge)} tone="plain" />
        </Row>
        <Row operator="+" label="赠送">
          <Money value={money(figures.gift)} tone="plain" />
        </Row>
        <Row operator="±" label="调账">
          <Money value={money(figures.adjustment)} />
        </Row>
        <Row operator="−" label="通话扣费">
          <Money value={money(figures.callCharges)} tone="plain" />
        </Row>
        <div className="flex items-baseline justify-between border-t-2 border-foreground pt-3 pb-2.5">
          <span className="font-semibold">
            <span className="inline-block w-[18px]">=</span>期末余额
          </span>
          <span className="text-[22px] font-bold">
            <Money value={money(figures.closingBalance)} />
          </span>
        </div>
      </div>
    </section>
  );
}
