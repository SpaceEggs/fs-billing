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
 * 话单页（PR 5）的共享话单组件会取代它。
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
      <table className="hidden w-full border-collapse text-[13px] tabular-nums md:table">
        <caption className="sr-only">最近 10 通话单</caption>
        <thead>
          <tr className="bg-muted text-xs text-muted-foreground">
            <th className="px-6 py-[9px] text-left font-medium">接通时间</th>
            <th className="px-3 py-[9px] text-left font-medium">被叫号码</th>
            <th className="px-3 py-[9px] text-left font-medium">国家</th>
            <th className="px-3 py-[9px] text-right font-medium">通话时长</th>
            <th className="px-3 py-[9px] text-right font-medium">计费时长</th>
            <th className="px-6 py-[9px] text-right font-medium">费用</th>
          </tr>
        </thead>
        <tbody>
          {calls.map((call) => (
            <tr key={call.callUuid} className="border-t border-border">
              <td className="px-6 py-2.5">
                <DateTime value={call.answeredAt} />
              </td>
              <td className="px-3 py-2.5">{call.callee}</td>
              <td className="px-3 py-2.5">{countryLabel(call)}</td>
              <td className="px-3 py-2.5 text-right">
                {formatDuration(call.durationSeconds)}
              </td>
              <td className="px-3 py-2.5 text-right">
                {formatBilledMinutes(Number(call.billedMinutes))}
              </td>
              <td className="px-6 py-2.5 text-right font-medium">
                <Money value={money(call.charge)} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
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
