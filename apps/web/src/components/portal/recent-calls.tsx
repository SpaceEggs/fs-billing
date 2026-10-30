import {
  Table,
  TableCaption,
  TableHeader,
  TableRow,
  TableHead,
  TableBody,
  TableCell,
} from '@/components/ui/table';
import {
  formatCountryLabel,
  type Currency,
  type PortalHomeResponse,
} from '@fs-billing/shared';
import { formatBilledMinutes, formatDateTime } from '../../lib/format';
import { formatDuration } from '../../lib/duration';
import { DateTime, Money } from '../data-format';

type RecentCall = PortalHomeResponse['recentCalls'][number];

function countryLabel(call: RecentCall) {
  return call.country === null
    ? '—'
    : formatCountryLabel(call.country, call.description);
}

/**
 * 首页「最近话单」的最小行组件（设计稿 1a、1b）：电脑为表格，手机为卡片。
 * 首页是六列、不能点开详情，与话单页的共用表格（八列、点击出详情）不同，所以没有换成共用组件。
 */
export function RecentCalls({
  currency,
  calls,
}: {
  currency: Currency;
  calls: readonly RecentCall[];
}) {
  const money = (amount: string) => ({ currency, amount });
  return (
    <>
      <Table className="hidden tabular-nums md:table">
        <TableCaption>最近 10 通话单</TableCaption>
        <TableHeader>
          <TableRow className="border-t-0">
            <TableHead className="px-6 py-[9px]">接通时间</TableHead>
            <TableHead className="py-[9px]">被叫号码</TableHead>
            <TableHead className="py-[9px]">国家</TableHead>
            <TableHead className="py-[9px] text-right">通话时长</TableHead>
            <TableHead className="py-[9px] text-right">计费时长</TableHead>
            <TableHead className="px-6 py-[9px] text-right">费用</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {calls.map((call) => (
            <TableRow key={call.callUuid}>
              <TableCell className="px-6 py-2.5">
                <DateTime value={call.answeredAt} />
              </TableCell>
              <TableCell className="py-2.5">{call.callee}</TableCell>
              <TableCell className="py-2.5">{countryLabel(call)}</TableCell>
              <TableCell className="py-2.5 text-right">
                {formatDuration(call.durationSeconds)}
              </TableCell>
              <TableCell className="py-2.5 text-right">
                {formatBilledMinutes(Number(call.billedMinutes))}
              </TableCell>
              <TableCell className="px-6 py-2.5 text-right font-medium">
                <Money value={money(call.charge)} />
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      <ul className="m-0 flex list-none flex-col gap-2 p-0 md:hidden">
        {calls.map((call) => (
          <li
            key={call.callUuid}
            className="flex flex-col gap-1.5 rounded-[10px] border border-border px-3.5 py-3 tabular-nums"
          >
            <div className="flex justify-between text-[15px] font-medium">
              <span>{call.callee}</span>
              <Money value={money(call.charge)} />
            </div>
            <div className="flex justify-between text-xs text-muted-foreground">
              <span>
                {countryLabel(call)} · {formatDuration(call.durationSeconds)}
              </span>
              <span>{formatDateTime(call.answeredAt).slice(5)}</span>
            </div>
          </li>
        ))}
      </ul>
    </>
  );
}
