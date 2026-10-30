import type { Currency } from '@fs-billing/shared';
import { cn } from '../../lib/utils';
import { formatCount, formatMinutes } from '../cdr/cdr-format';
import { Money } from '../data-format';
import type { StatementFigures } from '../../lib/statement';

/**
 * 电脑一行算式用 CSS grid：每项占一列（max-content），运算符占其间的 1fr 列并居中，
 * 所以每个运算符两侧的空隙相等；三行依次是标签、金额、备注，所有金额与运算符同在第 2 行，
 * 用 items-baseline 共用一条基线。期末余额的底色块是跨三行的独立元素，不影响基线。
 */
const gutter = 'minmax(1.5rem, 1fr)';
const columns = `auto ${Array.from({ length: 5 }, () => `${gutter} auto`).join(' ')}`;
const closingColumn = 11;

const amountClass = 'text-[22px] leading-normal';

function Operator({ index, children }: { index: number; children: string }) {
  return (
    <span
      aria-hidden
      style={{ gridColumn: index * 2, gridRow: 2 }}
      className="self-baseline justify-self-center text-xl leading-normal font-normal text-muted-foreground"
    >
      {children}
    </span>
  );
}

/** 一项占 1 列，子元素按行落在同一个 grid 里（display: contents），不额外包一层。 */
function Term({
  index,
  label,
  className,
  children,
  note,
}: {
  index: number;
  label: string;
  className?: string;
  children: React.ReactNode;
  note?: React.ReactNode;
}) {
  const column = index * 2 - 1;
  return (
    <>
      <span
        style={{ gridColumn: column, gridRow: 1 }}
        className="text-[13px] whitespace-nowrap text-muted-foreground"
      >
        {label}
      </span>
      <span
        style={{ gridColumn: column, gridRow: 2 }}
        className={cn(
          amountClass,
          'font-semibold whitespace-nowrap',
          className,
        )}
      >
        {children}
      </span>
      {note ? (
        <span
          style={{ gridColumn: column, gridRow: 3 }}
          className="text-xs whitespace-nowrap text-muted-foreground"
        >
          {note}
        </span>
      ) : null}
    </>
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
    <div className="grid grid-cols-[1.25rem_1fr_auto] items-baseline gap-x-2 border-t border-border py-2.5 first:border-t-0 print:break-inside-avoid">
      <span aria-hidden className="text-center text-muted-foreground">
        {operator}
      </span>
      <span className="text-muted-foreground">{label}</span>
      <span className={cn('text-right', className)}>{children}</span>
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
      <div
        style={{ gridTemplateColumns: columns }}
        className="hidden items-baseline gap-y-1.5 rounded-xl border border-border px-7 py-6 tabular-nums xl:grid print:break-inside-avoid"
      >
        <Term index={1} label="期初余额">
          <Money value={money(figures.openingBalance)} />
        </Term>
        <Operator index={1}>+</Operator>
        <Term index={2} label="充值">
          <Money value={money(figures.recharge)} tone="plain" />
        </Term>
        <Operator index={2}>+</Operator>
        <Term index={3} label="赠送">
          <Money value={money(figures.gift)} tone="plain" />
        </Term>
        <Operator index={3}>±</Operator>
        <Term index={4} label="调账">
          <Money value={money(figures.adjustment)} />
        </Term>
        <Operator index={4}>−</Operator>
        <Term index={5} label="通话扣费" note={usageNote}>
          <Money value={money(figures.callCharges)} tone="plain" />
        </Term>
        <Operator index={5}>=</Operator>
        <span
          aria-hidden
          style={{ gridColumn: closingColumn, gridRow: '1 / span 3' }}
          className="-mx-4 -my-3.5 self-stretch rounded-lg bg-muted"
        />
        <Term index={6} label="期末余额" className="text-[26px] font-bold">
          <Money value={money(figures.closingBalance)} />
        </Term>
      </div>
      <div className="flex flex-col rounded-xl border border-border px-4 py-1.5 text-[15px] tabular-nums xl:hidden print:break-inside-avoid">
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
        <div className="grid grid-cols-[1.25rem_1fr_auto] items-baseline gap-x-2 border-t-2 border-foreground pt-3 pb-2.5">
          <span aria-hidden className="text-center text-muted-foreground">
            =
          </span>
          <span className="font-semibold">期末余额</span>
          <span className="text-right text-[22px] font-bold">
            <Money value={money(figures.closingBalance)} />
          </span>
        </div>
      </div>
    </section>
  );
}
