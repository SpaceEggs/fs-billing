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

const HEADER = ['ISO', 'Country', 'Destination Prefix', 'Description', 'Rate'];
const HEADER_ALIASES = [
  HEADER.join(',').toLowerCase(),
  'iso,country,destination prefixes,description,rate',
  'iso,国家,号码前缀,说明,费率',
];
const OLD_FORMAT =
  '不再支持三列格式（前缀、国家、费率）。请改用五列并保留表头：ISO,Country,Destination Prefix,Description,Rate；可在导入对话框下载 CSV 模板';
const INVALID_HEADER =
  '表头无法识别，第一行必须是：ISO,Country,Destination Prefix,Description,Rate（也可用中文表头 ISO,国家,号码前缀,说明,费率）';
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

/** 解析 `ISO,Country,Destination Prefix,Description,Rate`。任何一行出错则整体失败，返回全部错误。 */
export function parseRateCsv<C extends Currency>(
  text: string,
  currency: C,
  options: { validateEntry?: (entry: RateEntry<C>) => string | undefined } = {},
): CsvResult<C> {
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/);
  const entries: RateEntry<C>[] = [];
  const errors: CsvError[] = [];
  const seen = new Map<string, number>();
  let first = true;
  let headerFailed = false;

  lines.forEach((raw, index) => {
    if (headerFailed) return;
    const line = index + 1;
    if (raw.trim() === '') return;
    const fail = (reason: string) => errors.push({ line, reason });
    const isFirst = first;
    first = false;

    const split = splitRow(raw);
    if (typeof split === 'string') {
      if (isFirst) headerFailed = true;
      return fail(split);
    }
    const cells = [...split];
    while (cells.length > (isFirst ? 3 : 5) && cells.at(-1) === '') cells.pop();

    if (isFirst) {
      const header = cells.map((c) => c.toLowerCase()).join(',');
      if (HEADER_ALIASES.includes(header)) return;
      headerFailed = true;
      return fail(
        ['prefix,country,rate', '前缀,国家,费率'].includes(header) ||
          (cells.length === 3 && PREFIX.test(cells[0] ?? ''))
          ? OLD_FORMAT
          : INVALID_HEADER,
      );
    }
    if (cells.length !== 5) return fail(`应为 5 列，实际 ${cells.length} 列`);
    const iso = cells[0]!.toUpperCase();
    const country = cells[1]!;
    const prefix = cells[2]!;
    const description = cells[3]!;
    const rateText = cells[4]!;

    if (!PREFIX.test(prefix)) return fail(`前缀只能是数字：${prefix}`);
    if (prefix.startsWith('00')) {
      return fail(`前缀不能以 00 开头（国际冠字应去掉）：${prefix}`);
    }
    const firstLine = seen.get(prefix);
    if (firstLine !== undefined) {
      return fail(`前缀 ${prefix} 与第 ${firstLine} 行重复`);
    }
    seen.set(prefix, line);
    if (!/^(?:[A-Za-z]{2})?$/.test(cells[0]!))
      return fail(`ISO 必须是两位字母，或留空：${cells[0]}`);
    if (country === '') return fail('国家不能为空');
    if (!RATE_TEXT.test(rateText)) return fail(`费率不是数字：${rateText}`);
    if (rateText.startsWith('-')) return fail(`费率不能为负：${rateText}`);
    if ((rateText.split('.')[1] ?? '').length > 4) {
      return fail(`费率最多 4 位小数：${rateText}`);
    }
    const entry = {
      prefix,
      iso,
      country,
      description,
      perMinute: rate(currency, rateText),
    };
    const issue = options.validateEntry?.(entry);
    if (issue !== undefined) return fail(issue);
    entries.push(entry);
  });

  if (errors.length > 0) return { ok: false, errors };
  if (entries.length === 0) {
    return { ok: false, errors: [{ line: 1, reason: '文件没有费率行' }] };
  }
  return { ok: true, entries };
}

/** 按 RFC 4180 给单元格加引号：含逗号、引号、换行或首尾空白时。 */
export function quoteCsvCell(cell: string): string {
  return /[",\r\n]/.test(cell) || cell !== cell.trim()
    ? `"${cell.replace(/"/g, '""')}"`
    : cell;
}

const NUMBER_LIKE = /^[+-]\d+(?:\.\d+)?$/;

/**
 * Excel 和 WPS 会把以 = + - @ 开头的单元格当公式执行。只中和危险内容：
 * 以 = 或 @ 开头，或以 + - 开头但整格不是带符号的数字，前面加单引号；
 * 开头的制表符和回车同样加单引号。纯号码（+447700900123）和带符号金额（-35.20）原样导出。
 */
export function neutralizeCsvFormula(cell: string): string {
  if (/^[=@\t\r]/.test(cell)) return `'${cell}`;
  if (/^[+-]/.test(cell) && !NUMBER_LIKE.test(cell)) return `'${cell}`;
  return cell;
}

/** 话单与流水 CSV 共用的单元格输出：先中和公式，再按 RFC 4180 加引号。 */
export function csvCell(cell: string): string {
  return quoteCsvCell(neutralizeCsvFormula(cell));
}

export const CSV_BOM = '\uFEFF';
export const CSV_EOL = '\r\n';

/** 一条记录，不含行结束符。 */
export function csvRecord(cells: readonly string[]): string {
  return cells.map(csvCell).join(',');
}

/** 导出为 `ISO,Country,Destination Prefix,Description,Rate`，费率固定 4 位小数。 */
export function formatRateCsv(entries: readonly RateEntry<Currency>[]): string {
  const rows = entries.map((e) =>
    [
      e.iso,
      e.country,
      e.prefix,
      e.description,
      e.perMinute.perMinute.toFixed(4),
    ]
      .map(quoteCsvCell)
      .join(','),
  );
  return `${[HEADER.join(','), ...rows].join('\n')}\n`;
}
