import { describe, expect, it } from 'vitest';
import { AdminServiceError } from './errors.js';
import { parseInitialRateCsv } from './csv.js';

describe('initial rate CSV validation', () => {
  it('reports parser and contract errors together using physical row numbers', () => {
    const bytes = Buffer.from(
      `prefix,country,rate\n\n1,${'国'.repeat(201)},0.01\nabc,美国,0.01\n44,英国,-1`,
    );
    try {
      parseInitialRateCsv(bytes, 'CNY');
      expect.fail('expected invalid CSV');
    } catch (error) {
      expect(error).toBeInstanceOf(AdminServiceError);
      expect(error).toMatchObject({
        code: 'CSV_INVALID',
        rows: [{ line: 3 }, { line: 4 }, { line: 5 }],
      });
    }
  });

  it('preserves the CSV dialect and detects duplicate prefixes across rows', () => {
    const entries = parseInitialRateCsv(
      Buffer.from('\uFEFF前缀,国家,费率\n\n1,"美国,加拿大",0.0123'),
      'USD',
    );
    expect(
      entries.map((entry) => ({
        prefix: entry.prefix,
        country: entry.country,
        currency: entry.perMinute.currency,
        rate: entry.perMinute.perMinute.toFixed(),
      })),
    ).toEqual([
      { prefix: '1', country: '美国,加拿大', currency: 'USD', rate: '0.0123' },
    ]);
    expect(() =>
      parseInitialRateCsv(Buffer.from('1,美国,0.01\n1,加拿大,0.02'), 'USD'),
    ).toThrow(expect.objectContaining({ code: 'CSV_INVALID' }));
  });
});
