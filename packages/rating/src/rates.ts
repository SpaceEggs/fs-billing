import type { DialedNumber } from './dialed.js';
import type { Currency, Rate } from './money.js';

export interface RateEntry<C extends Currency> {
  readonly prefix: string;
  readonly country: string;
  readonly perMinute: Rate<C>;
}

/** 一次调价：从 effectiveFrom（含）起整表生效，直到下一个版本。 */
export interface RateVersion<C extends Currency> {
  readonly effectiveFrom: Date;
  readonly entries: readonly RateEntry<C>[];
}

/** 一个租户的费率表；币种与租户一致。 */
export interface RateTable<C extends Currency> {
  readonly currency: C;
  readonly versions: readonly RateVersion<C>[];
}

/** 接通时刻生效的版本：effectiveFrom ≤ answeredAt 中最晚的一个。 */
export function versionAt<C extends Currency>(
  table: RateTable<C>,
  answeredAt: Date,
): RateVersion<C> | undefined {
  let current: RateVersion<C> | undefined;
  for (const version of table.versions) {
    if (version.effectiveFrom.getTime() > answeredAt.getTime()) continue;
    if (
      !current ||
      version.effectiveFrom.getTime() > current.effectiveFrom.getTime()
    ) {
      current = version;
    }
  }
  return current;
}

/** 最长前缀匹配；只接受已校验的 DialedNumber。 */
export function longestPrefix<C extends Currency>(
  entries: readonly RateEntry<C>[],
  dialed: DialedNumber,
): RateEntry<C> | undefined {
  let best: RateEntry<C> | undefined;
  for (const entry of entries) {
    if (!dialed.startsWith(entry.prefix)) continue;
    if (!best || entry.prefix.length > best.prefix.length) best = entry;
  }
  return best;
}

export function findRate<C extends Currency>(
  table: RateTable<C>,
  dialed: DialedNumber,
  answeredAt: Date,
): RateEntry<C> | undefined {
  const version = versionAt(table, answeredAt);
  return version && longestPrefix(version.entries, dialed);
}
