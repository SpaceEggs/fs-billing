import { rate, type Currency } from './money.js';
import type { RateEntry } from './rates.js';

export interface CsvError {
  /** 文件中的物理行号，从 1 开始（含表头）。 */
  readonly line: number;
  readonly reason: string;
}

export type CsvResult<C extends Currency> =
  | { readonly ok: true; readonly entries: readonly RateEntry<C>[] }
  | { readonly ok: false; readonly errors: readonly CsvError[] };

const HEADER = 'prefix,country,rate';
const PREFIX = /^\d+$/;
const RATE_TEXT = /^-?\d+(?:\.\d+)?$/;

/** 解析 `prefix,country,rate`。任何一行出错则整体失败，返回全部错误。 */
export function parseRateCsv<C extends Currency>(
  text: string,
  currency: C,
): CsvResult<C> {
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/);
  const entries: RateEntry<C>[] = [];
  const errors: CsvError[] = [];
  const seen = new Map<string, number>();

  lines.forEach((raw, index) => {
    const line = index + 1;
    const row = raw.trim();
    if (row === '') return;
    if (line === 1 && row.toLowerCase().replace(/\s/g, '') === HEADER) return;
    const fail = (reason: string) => errors.push({ line, reason });

    const cells = row.split(',').map((cell) => cell.trim());
    if (cells.length !== 3) return fail(`应为 3 列，实际 ${cells.length} 列`);
    const [prefix, country, rateText] = cells as [string, string, string];

    if (!PREFIX.test(prefix)) return fail(`前缀只能是数字：${prefix}`);
    const first = seen.get(prefix);
    if (first !== undefined) {
      return fail(`前缀 ${prefix} 与第 ${first} 行重复`);
    }
    seen.set(prefix, line);
    if (!RATE_TEXT.test(rateText)) return fail(`费率不是数字：${rateText}`);
    if (rateText.startsWith('-')) return fail(`费率不能为负：${rateText}`);
    if ((rateText.split('.')[1] ?? '').length > 4) {
      return fail(`费率最多 4 位小数：${rateText}`);
    }
    entries.push({ prefix, country, perMinute: rate(currency, rateText) });
  });

  if (errors.length > 0) return { ok: false, errors };
  if (entries.length === 0) {
    return { ok: false, errors: [{ line: 1, reason: '文件没有费率行' }] };
  }
  return { ok: true, entries };
}
