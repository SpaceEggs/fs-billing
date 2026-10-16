import type { AdminRateChange, Currency } from '@fs-billing/shared';
import { formatRate } from '../../lib/format';
import { rateChangePercent } from '../../lib/rates';
import { cn } from '../../lib/utils';
import { rateUnit } from './rate-edit-dialog';

const changeTags = {
  added: { label: '新增', className: 'border-ok-border bg-ok-soft text-ok' },
  modified: {
    label: '修改',
    className: 'border-brand-border bg-brand-soft text-primary',
  },
  deleted: {
    label: '删除',
    className: 'border-err-border bg-err-soft text-err',
  },
} as const satisfies Record<
  AdminRateChange['kind'],
  { label: string; className: string }
>;

/** 费率变动明细（排定的新版本、导入与复制的预览共用）。 */
export function RateChangesTable({
  changes,
  currency,
  showHeader = false,
  columns = { before: '当前费率', after: '新费率' },
}: {
  changes: readonly AdminRateChange[];
  currency: Currency;
  showHeader?: boolean;
  columns?: { before: string; after: string };
}) {
  const unit = rateUnit[currency];
  return (
    <table className="w-full border-collapse text-[13px] whitespace-nowrap">
      <thead
        className={
          showHeader
            ? 'sticky top-0 bg-muted text-xs text-muted-foreground'
            : 'sr-only'
        }
      >
        <tr>
          <th className="py-2 pr-2 pl-3.5 text-left font-medium">变动</th>
          <th className="px-2 py-2 text-left font-medium">前缀</th>
          <th className="px-2 py-2 text-left font-medium">国家/备注</th>
          <th className="px-2 py-2 text-right font-medium">
            {columns.before}（{unit}）
          </th>
          <th className="px-2 py-2 text-right font-medium">
            {columns.after}（{unit}）
          </th>
          <th className="py-2 pr-3.5 pl-2 text-right font-medium">涨跌</th>
        </tr>
      </thead>
      <tbody className="tabular-nums">
        {changes.map((change) => (
          <ChangeRow
            key={`${change.kind}-${(change.kind === 'added' ? change.after : change.before).prefix}`}
            change={change}
          />
        ))}
      </tbody>
    </table>
  );
}

function ChangeRow({ change }: { change: AdminRateChange }) {
  const tag = changeTags[change.kind];
  const entry = change.kind === 'added' ? change.after : change.before;
  const before = change.kind === 'added' ? null : change.before;
  const after = change.kind === 'deleted' ? null : change.after;
  const percent =
    before && after ? rateChangePercent(before.rate, after.rate) : null;
  return (
    <tr className="border-t border-border first:border-t-0">
      <td className="py-2 pr-2 pl-3.5">
        <span
          className={cn(
            'inline-flex h-5 items-center rounded-[5px] border px-1.5 text-[11px] font-medium',
            tag.className,
          )}
        >
          {tag.label}
        </span>
      </td>
      <td className="px-2 py-2 font-mono font-semibold">{entry.prefix}</td>
      <td className="w-full px-2 py-2">{(after ?? entry).country}</td>
      <td
        className={cn(
          'px-2 py-2 text-right text-muted-foreground',
          change.kind === 'deleted' && 'line-through',
        )}
      >
        {before ? formatRate(before.rate) : '—'}
        {change.kind === 'modified' ? (
          <span aria-hidden className="pl-2">
            →
          </span>
        ) : null}
      </td>
      <td className="px-2 py-2 text-right font-semibold">
        {after ? formatRate(after.rate) : '—'}
      </td>
      <td
        className={cn(
          'py-2 pr-3.5 pl-2 text-right',
          percent?.rising ? 'text-neg' : 'text-pos',
        )}
      >
        {percent?.text ?? ''}
      </td>
    </tr>
  );
}
