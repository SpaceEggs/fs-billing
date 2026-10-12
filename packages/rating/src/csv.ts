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

const HEADER = ['prefix', 'country', 'rate'];
const PREFIX = /^\d+$/;
const RATE_TEXT = /^-?\d+(?:\.\d+)?$/;

/** 按 RFC 4180 拆分一行；引号内不允许换行，所以一行就是一条记录。 */
function splitRow(row: string): string[] | string {
  const cells: string[] = [];
  let i = 0;
  for (;;) {
    let cell = '';
    if (row[i] === '"') {
      i++;
      for (;;) {
        if (i >= row.length) return '引号未闭合（引号内不能换行）';
        if (row[i] === '"') {
          if (row[i + 1] === '"') {
            cell += '"';
            i += 2;
            continue;
          }
          i++;
          break;
        }
        cell += row[i++];
      }
      if (i < row.length && row[i] !== ',') return '引号后只能是逗号';
    } else {
      const end = row.indexOf(',', i);
      cell = row.slice(i, end === -1 ? row.length : end);
      if (cell.includes('"')) return '未加引号的字段中不能有引号';
      i += cell.length;
    }
    cells.push(cell.trim());
    if (i >= row.length) return cells;
    i++; // 逗号
  }
}

/** 解析 `prefix,country,rate`。任何一行出错则整体失败，返回全部错误。 */
export function parseRateCsv<C extends Currency>(
  text: string,
  currency: C,
): CsvResult<C> {
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/);
  const entries: RateEntry<C>[] = [];
  const errors: CsvError[] = [];
  const seen = new Map<string, number>();
  let first = true;

  lines.forEach((raw, index) => {
    const line = index + 1;
    if (raw.trim() === '') return;
    const fail = (reason: string) => errors.push({ line, reason });

    const split = splitRow(raw);
    if (typeof split === 'string') return fail(split);
    const cells = [...split];
    while (cells.length > 3 && cells.at(-1) === '') cells.pop();

    const isHeader =
      first && cells.map((c) => c.toLowerCase()).join(',') === HEADER.join(',');
    first = false;
    if (isHeader) return;

    if (cells.length !== 3) return fail(`应为 3 列，实际 ${cells.length} 列`);
    const [prefix, country, rateText] = cells as [string, string, string];

    if (!PREFIX.test(prefix)) return fail(`前缀只能是数字：${prefix}`);
    if (prefix.startsWith('00')) {
      return fail(`前缀不能以 00 开头（国际冠字应去掉）：${prefix}`);
    }
    const firstLine = seen.get(prefix);
    if (firstLine !== undefined) {
      return fail(`前缀 ${prefix} 与第 ${firstLine} 行重复`);
    }
    seen.set(prefix, line);
    if (country === '') return fail('国家/备注不能为空');
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

function quote(cell: string): string {
  return /[",\r\n]/.test(cell) || cell !== cell.trim()
    ? `"${cell.replace(/"/g, '""')}"`
    : cell;
}

/** 导出为 `prefix,country,rate`，费率固定 4 位小数。 */
export function formatRateCsv(entries: readonly RateEntry<Currency>[]): string {
  const rows = entries.map((e) =>
    [e.prefix, quote(e.country), e.perMinute.perMinute.toFixed(4)].join(','),
  );
  return `${[HEADER.join(','), ...rows].join('\n')}\n`;
}
