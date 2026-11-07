import {
  Table,
  TableHeader,
  TableRow,
  TableHead,
  TableBody,
  TableCell,
} from '@/components/ui/table';
import { useTranslation } from 'react-i18next';
import { useLocale } from '@/i18n';
import type {
  AdminRateChange,
  AdminRateEntry,
  Currency,
  Locale,
} from '@fs-billing/shared';
import { formatRate } from '../../lib/format';
import {
  blankAsDash,
  rateChangePercent,
  rateEntryFields,
} from '../../lib/rates';
import { cn } from '../../lib/utils';

const changeTags = {
  added: { className: 'border-ok-border bg-ok-soft text-ok' },
  modified: {
    className: 'border-brand-border bg-brand-soft text-primary',
  },
  deleted: {
    className: 'border-err-border bg-err-soft text-err',
  },
} as const satisfies Record<AdminRateChange['kind'], { className: string }>;

const cellClass: Partial<Record<keyof AdminRateEntry, string>> = {
  iso: 'font-mono',
  prefix: 'font-mono font-semibold',
  description: 'w-full',
};

/** 费率变动明细（排定的新版本、导入与复制的预览共用）。 */
export function RateChangesTable({
  changes,
  currency,
  showHeader = false,
  columns,
}: {
  changes: readonly AdminRateChange[];
  currency: Currency;
  showHeader?: boolean;
  columns?: { before: string; after: string };
}) {
  const { t } = useTranslation(['rates', 'format', 'common']);
  const locale = useLocale();
  const unit = t(
    currency === 'CNY' ? 'format:rateUnit.cny' : 'format:rateUnit.usd',
  );
  const fieldLabels = {
    iso: t('rates:field.iso'),
    prefix: t('rates:field.prefix'),
    country: t('rates:field.country'),
    description: t('rates:field.description'),
  } as const satisfies Record<
    'iso' | 'prefix' | 'country' | 'description',
    string
  >;
  const shownColumns = columns ?? {
    before: t('rates:changes.before'),
    after: t('rates:changes.after'),
  };
  return (
    <Table className="whitespace-nowrap">
      <TableHeader
        className={
          showHeader
            ? 'sticky top-0'
            : 'sr-only bg-transparent text-inherit text-[length:inherit]'
        }
      >
        <TableRow className="border-t-0">
          <TableHead className="py-2 pr-2 pl-3.5">
            {t('rates:changes.column')}
          </TableHead>
          {rateEntryFields.map(({ key }) => (
            <TableHead key={key} className="px-2 py-2">
              {fieldLabels[key]}
            </TableHead>
          ))}
          <TableHead className="px-2 py-2 text-right">
            {t('rates:changes.columnRate', {
              label: shownColumns.before,
              unit,
            })}
          </TableHead>
          <TableHead className="px-2 py-2 text-right">
            {t('rates:changes.columnRate', {
              label: shownColumns.after,
              unit,
            })}
          </TableHead>
          <TableHead className="py-2 pr-3.5 pl-2 text-right">
            {t('rates:changes.change')}
          </TableHead>
        </TableRow>
      </TableHeader>
      <TableBody className="tabular-nums">
        {changes.map((change) => (
          <ChangeRow
            key={`${change.kind}-${(change.kind === 'added' ? change.after : change.before).prefix}`}
            change={change}
            locale={locale}
          />
        ))}
      </TableBody>
    </Table>
  );
}

function ChangeRow({
  change,
  locale,
}: {
  change: AdminRateChange;
  locale: Locale;
}) {
  const { t } = useTranslation(['rates', 'format', 'common']);
  const tag = changeTags[change.kind];
  const label =
    change.kind === 'added'
      ? t('rates:changes.added')
      : change.kind === 'modified'
        ? t('rates:changes.modified')
        : t('rates:changes.deleted');
  const before = change.kind === 'added' ? null : change.before;
  const after = change.kind === 'deleted' ? null : change.after;
  const percent =
    before && after ? rateChangePercent(before.rate, after.rate) : null;
  return (
    <TableRow className="first:border-t-0">
      <TableCell className="py-2 pr-2 pl-3.5">
        <span
          className={cn(
            'inline-flex h-5 items-center rounded-[5px] border px-1.5 text-[11px] font-medium',
            tag.className,
          )}
        >
          {label}
        </span>
      </TableCell>
      {rateEntryFields.map(({ key }) => (
        <FieldCell
          key={key}
          change={change}
          field={key}
          className={cellClass[key]}
        />
      ))}
      <TableCell
        className={cn(
          'px-2 py-2 text-right text-muted-foreground',
          change.kind === 'deleted' && 'line-through',
        )}
      >
        {before ? formatRate(before.rate, { locale }) : '—'}
        {change.kind === 'modified' ? (
          <span aria-hidden className="pl-2">
            →
          </span>
        ) : null}
      </TableCell>
      <TableCell className="px-2 py-2 text-right font-semibold">
        {after ? formatRate(after.rate, { locale }) : '—'}
      </TableCell>
      <TableCell
        className={cn(
          'py-2 pr-3.5 pl-2 text-right',
          percent?.rising ? 'text-neg' : 'text-pos',
        )}
      >
        {percent?.text ?? ''}
      </TableCell>
    </TableRow>
  );
}

/** 修改行里值有变化的单元格显示「旧 → 新」（旧值划线），其余显示当前值。 */
function FieldCell({
  change,
  field,
  className,
}: {
  change: AdminRateChange;
  field: keyof AdminRateEntry;
  className?: string | undefined;
}) {
  const shown = (change.kind === 'deleted' ? change.before : change.after)[
    field
  ];
  const changed = change.kind === 'modified' && change.before[field] !== shown;
  return (
    <TableCell className={cn('px-2 py-2', className)}>
      {changed ? (
        <>
          <span className="text-muted-foreground line-through">
            {blankAsDash(change.before[field])}
          </span>
          <span aria-hidden className="px-1.5">
            →
          </span>
          {blankAsDash(shown)}
        </>
      ) : (
        shown
      )}
    </TableCell>
  );
}
