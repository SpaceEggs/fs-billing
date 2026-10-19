import { describe, expect, it } from 'vitest';
import { AdminServiceError } from './errors.js';
import { parseInitialRateCsv } from './csv.js';

describe('initial rate CSV validation', () => {
  it('reports parser and contract errors together using physical row numbers', () => {
    const bytes = Buffer.from(
      `ISO,Country,Destination Prefix,Description,Rate\n\n,${'国'.repeat(201)},1,,0.01\n,美国,abc,,0.01\nGB,英国,44,,-1`,
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
      Buffer.from('﻿ISO,国家,号码前缀,说明,费率\n\n,"美国,加拿大",1,,0.0123'),
      'USD',
    );
    expect(
      entries.map((entry) => ({
        iso: '',
        description: '',
        prefix: entry.prefix,
        country: entry.country,
        currency: entry.perMinute.currency,
        rate: entry.perMinute.perMinute.toFixed(),
      })),
    ).toEqual([
      {
        iso: '',
        description: '',
        prefix: '1',
        country: '美国,加拿大',
        currency: 'USD',
        rate: '0.0123',
      },
    ]);
    expect(() =>
      parseInitialRateCsv(
        Buffer.from(
          'ISO,Country,Destination Prefix,Description,Rate\n,美国,1,,0.01\n,加拿大,1,,0.02',
        ),
        'USD',
      ),
    ).toThrow(expect.objectContaining({ code: 'CSV_INVALID' }));
  });
});
