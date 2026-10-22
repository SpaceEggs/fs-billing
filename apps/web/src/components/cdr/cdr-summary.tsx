import type { Currency } from '@fs-billing/shared';
import { Money } from '../data-format';
import { formatCount, formatMinutes } from './cdr-format';

export type CdrSummaryData = {
  total: number;
  billedMinutes: string;
  charge: string;
  unansweredCalls: number;
};

/**
 * 通话数旁的注释：全部视图写「含未接通 N」，已接通视图写「另有未接通 N 通」（决定 37），
 * 没有未接通时已接通视图不写。
 */
export function unansweredNote(
  status: 'answered' | 'all',
  unansweredCalls: number,
) {
  if (status === 'all')
    return unansweredCalls > 0
      ? `含未接通 ${formatCount(unansweredCalls)}`
      : '全部已接通';
  return unansweredCalls > 0
    ? `另有未接通 ${formatCount(unansweredCalls)} 通`
    : null;
}

function Stat({
  label,
  children,
  note,
}: {
  label: string;
  children: React.ReactNode;
  note?: React.ReactNode;
}) {
  return (
    <div className="flex items-baseline gap-2">
      <span className="text-[13px] text-muted-foreground">{label}</span>
      <span className="text-lg font-semibold">{children}</span>
      {note ? (
        <span className="text-xs text-muted-foreground">{note}</span>
      ) : null}
    </div>
  );
}

/** 电脑版汇总栏（设计稿 2a）：通话数、总计费分钟、总费用。 */
export function CdrSummaryBar({
  currency,
  summary,
  status,
  extraNote,
}: {
  currency: Currency;
  summary: CdrSummaryData;
  status: 'answered' | 'all';
  /** 后台在通话数后追加「其中未经验证 N 条」。 */
  extraNote?: React.ReactNode;
}) {
  const note = unansweredNote(status, summary.unansweredCalls);
  return (
    <section
      aria-label="汇总"
      className="hidden flex-wrap items-baseline gap-x-8 gap-y-2 rounded-[10px] border border-border bg-muted px-5 py-3.5 tabular-nums md:flex"
    >
      <Stat label="通话数" note={note}>
        {formatCount(summary.total)}
      </Stat>
      <Stat label="总计费">{formatMinutes(summary.billedMinutes)}</Stat>
      <Stat label="总费用">
        <Money value={{ currency, amount: summary.charge }} tone="plain" />
      </Stat>
      {extraNote ? (
        <span className="text-xs text-muted-foreground">{extraNote}</span>
      ) : null}
    </section>
  );
}

/** 手机版汇总行（设计稿 2d）：日期范围与接通状态，通话数与总费用。 */
export function CdrSummaryLine({
  currency,
  summary,
  rangeText,
  status,
}: {
  currency: Currency;
  summary: CdrSummaryData;
  rangeText: string;
  status: 'answered' | 'all';
}) {
  const note = unansweredNote(status, summary.unansweredCalls);
  return (
    <section
      aria-label="汇总"
      className="flex flex-wrap justify-between gap-x-2 gap-y-1 text-xs text-muted-foreground tabular-nums md:hidden"
    >
      <span>
        {rangeText} · {status === 'all' ? '全部' : '已接通'}
      </span>
      <span>
        {formatCount(summary.total)} 通 ·{' '}
        <Money value={{ currency, amount: summary.charge }} tone="plain" />
      </span>
      {note ? <span className="basis-full text-right">{note}</span> : null}
    </section>
  );
}
