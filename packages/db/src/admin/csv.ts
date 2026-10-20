import {
  parseRateCsv,
  type Currency,
  type RateEntry,
} from '@fs-billing/rating';
import {
  adminRateEntrySchema,
  DEFAULT_ADMIN_CSV_MAX_BYTES,
  DEFAULT_ADMIN_RATE_MAX_ROWS,
} from '@fs-billing/shared';
import { AdminServiceError } from './errors.js';

export function parseInitialRateCsv<C extends Currency>(
  bytes: Uint8Array,
  currency: C,
): readonly RateEntry<C>[] {
  if (bytes.length > DEFAULT_ADMIN_CSV_MAX_BYTES)
    throw new AdminServiceError('CSV_LIMIT_EXCEEDED', 'CSV 文件超限');
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    try {
      text = new TextDecoder('gbk', { fatal: true }).decode(bytes);
    } catch {
      throw new AdminServiceError(
        'CSV_ENCODING_UNSUPPORTED',
        'CSV 必须为 UTF-8 或 GBK',
      );
    }
  }
  const result = parseRateCsv(text, currency, {
    validateEntry: (entry) => {
      const parsed = adminRateEntrySchema.safeParse({
        prefix: entry.prefix,
        iso: entry.iso,
        country: entry.country,
        description: entry.description,
        rate: entry.perMinute.perMinute.toFixed(),
      });
      return parsed.success ? undefined : parsed.error.issues[0]?.message;
    },
  });
  const errors = result.ok ? [] : [...result.errors];
  if (errors.length > 0)
    throw new AdminServiceError(
      'CSV_INVALID',
      'CSV 费率错误',
      errors.sort((left, right) => left.line - right.line),
    );
  if (!result.ok) throw new Error('CSV 校验失败但未返回错误行');
  if (result.entries.length > DEFAULT_ADMIN_RATE_MAX_ROWS)
    throw new AdminServiceError('CSV_LIMIT_EXCEEDED', 'CSV 行数超限');
  return result.entries;
}
