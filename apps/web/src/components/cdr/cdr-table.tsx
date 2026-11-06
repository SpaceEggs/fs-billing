import { useTranslation } from 'react-i18next';
import { Item } from '../ui/item';
import {
  Table,
  TableHeader,
  TableRow,
  TableHead,
  TableBody,
  TableCell,
} from '@/components/ui/table';
import type { Currency, PortalCdr } from '@fs-billing/shared';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { formatDuration } from '../../lib/duration';
import { useLocale } from '../../i18n';
import { cn } from '../../lib/utils';
import { DateTime, Money, Rate } from '../data-format';
import {
  cdrCountryLabel,
  cdrDirectionLabel,
  cdrIsInbound,
  cdrMoment,
  cdrRateUnit,
  cdrShortMoment,
  formatMinutes,
} from './cdr-format';

/** 列表里的方向标签；呼入用 secondary，呼出用 plain。 */
function DirectionBadge({ cdr }: { cdr: PortalCdr }) {
  const locale = useLocale();
  return (
    <Badge variant={cdrIsInbound(cdr) ? 'secondary' : 'plain'}>
      {cdrDirectionLabel(cdr, locale)}
    </Badge>
  );
}

type ListProps<Row extends PortalCdr> = {
  currency: Currency;
  items: readonly Row[];
  onSelect: (cdr: Row) => void;
  /** 后台在时间旁加「未经验证」标签；门户不传。 */
  badge?: ((cdr: Row) => React.ReactNode) | undefined;
};

const muted = (cdr: PortalCdr) =>
  cdr.answeredAt === null && 'text-muted-foreground';

/** 电脑版话单表（设计稿 2a）。整行可点开详情，时间是键盘可达的按钮。 */
export function CdrTable<Row extends PortalCdr>({
  currency,
  items,
  onSelect,
  badge,
}: ListProps<Row>) {
  const { t } = useTranslation(['cdr']);
  const locale = useLocale();
  return (
    <div className="hidden overflow-x-auto rounded-[10px] border border-border md:block">
      <Table className="whitespace-nowrap">
        <TableHeader>
          <TableRow className="border-t-0">
            <TableHead className="px-4">{t('cdr:table.answeredAt')}</TableHead>
            <TableHead>{t('cdr:table.caller')}</TableHead>
            <TableHead>{t('cdr:table.callee')}</TableHead>
            <TableHead>{t('cdr:table.direction')}</TableHead>
            <TableHead>{t('cdr:table.country')}</TableHead>
            <TableHead className="text-right">
              {t('cdr:table.duration')}
            </TableHead>
            <TableHead className="text-right">
              {t('cdr:table.billed')}
            </TableHead>
            <TableHead className="text-right">
              {t('cdr:table.rate', { unit: cdrRateUnit(currency, locale) })}
            </TableHead>
            <TableHead className="px-4 text-right">
              {t('cdr:table.charge')}
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody className="tabular-nums">
          {items.map((cdr) => (
            <TableRow
              key={cdr.callUuid}
              onClick={() => onSelect(cdr)}
              className={cn('cursor-pointer hover:bg-muted/50', muted(cdr))}
            >
              <TableCell className="px-4">
                <span className="flex items-center gap-2">
                  <Button
                    variant="ghost"
                    size="inline"
                    onClick={(event) => {
                      event.stopPropagation();
                      onSelect(cdr);
                    }}
                    aria-label={t('cdr:table.viewDetail', {
                      callee: cdr.callee,
                    })}
                    className="text-left hover:bg-transparent"
                  >
                    <DateTime value={cdrMoment(cdr)} />
                  </Button>
                  {badge?.(cdr)}
                </span>
              </TableCell>
              <TableCell>{cdr.caller}</TableCell>
              <TableCell>{cdr.callee}</TableCell>
              <TableCell>
                <DirectionBadge cdr={cdr} />
              </TableCell>
              <TableCell>{cdrCountryLabel(cdr, locale)}</TableCell>
              <TableCell className="text-right">
                {formatDuration(cdr.durationSeconds, locale)}
              </TableCell>
              <TableCell className="text-right">
                {formatMinutes(cdr.billedMinutes, locale)}
              </TableCell>
              <TableCell className="text-right">
                {cdrIsInbound(cdr) || cdr.rate === null ? (
                  '—'
                ) : (
                  <Rate value={cdr.rate} />
                )}
              </TableCell>
              <TableCell className="px-4 text-right font-medium">
                {cdrIsInbound(cdr) ? (
                  '—'
                ) : (
                  <Money
                    value={{ currency, amount: cdr.charge }}
                    tone="plain"
                  />
                )}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

/** 手机版话单卡片（设计稿 2d）：被叫号码与费用一行，国家、时长与时间一行。 */
export function CdrCards<Row extends PortalCdr>({
  currency,
  items,
  onSelect,
  badge,
}: ListProps<Row>) {
  const { t } = useTranslation(['cdr']);
  const locale = useLocale();
  return (
    <ul className="m-0 flex list-none flex-col gap-2 p-0 md:hidden">
      {items.map((cdr) => (
        <li key={cdr.callUuid}>
          <Item
            asChild
            variant="outline"
            size="sm"
            className={cn(
              'w-full flex-col items-stretch gap-1.5 text-left tabular-nums',
              muted(cdr),
            )}
          >
            <button
              type="button"
              onClick={() => onSelect(cdr)}
              aria-label={t('cdr:table.viewDetail', { callee: cdr.callee })}
            >
              <span className="flex items-center justify-between gap-2 text-[15px] font-medium">
                <span className="flex items-center gap-2">
                  {cdr.callee}
                  <DirectionBadge cdr={cdr} />
                  {badge?.(cdr)}
                </span>
                {cdrIsInbound(cdr) ? (
                  '—'
                ) : (
                  <Money
                    value={{ currency, amount: cdr.charge }}
                    tone="plain"
                  />
                )}
              </span>
              <span className="flex justify-between gap-2 text-xs text-muted-foreground">
                <span className="truncate">
                  {cdrCountryLabel(cdr, locale)} ·{' '}
                  {formatDuration(cdr.durationSeconds, locale)}
                </span>
                <span className="whitespace-nowrap">
                  {cdrShortMoment(cdr, locale)}
                </span>
              </span>
            </button>
          </Item>
        </li>
      ))}
    </ul>
  );
}
