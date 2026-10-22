import { describe, expect, it } from 'vitest';
import {
  addDecimalStrings,
  type PortalStatementResponse,
} from '@fs-billing/shared';
import { csvRecord } from '@fs-billing/rating';
import {
  statementSummaryHeaders,
  statementSummaryRows,
} from './statement-csv.js';

const statement: Pick<
  PortalStatementResponse,
  'figures' | 'countries' | 'days'
> = {
  figures: {
    openingBalance: '1176.6',
    recharge: '1300',
    gift: '0',
    adjustment: '-25.5',
    callCharges: '2486.3',
    closingBalance: '-35.2',
    calls: 12804,
    callMinutes: '49726',
  },
  countries: [
    { country: '中国', calls: 9000, minutes: '30000', charge: '1500' },
    { country: '=1+1', calls: 3804, minutes: '19726', charge: '986.3' },
  ],
  days: [
    { day: '2026-09-01', calls: 400, minutes: '1600', charge: '80.1' },
    { day: '2026-09-02', calls: 0, minutes: '0', charge: '0' },
  ],
};

describe('statement summary CSV rows', () => {
  it('writes a long table whose signed summary amounts add up to the closing balance', () => {
    const rows = statementSummaryRows(statement);
    const summary = rows.filter((row) => row[0] === '汇总');
    expect(summary.map((row) => row[1])).toEqual([
      '期初余额',
      '充值',
      '赠送',
      '调账',
      '通话扣费',
      '期末余额',
    ]);
    const closing = summary.at(-1)?.[4] ?? '';
    expect(
      addDecimalStrings(summary.slice(0, 5).map((row) => row[4] ?? '')),
    ).toBe(closing);
    expect(closing).toBe('-35.2');
    expect(summary[4]).toEqual([
      '汇总',
      '通话扣费',
      '12804',
      '49726',
      '-2486.3',
    ]);
  });

  it('fills calls and minutes only on the charge, country and day rows', () => {
    const rows = statementSummaryRows(statement);
    for (const row of rows) {
      expect(row).toHaveLength(5);
      const blank = ['期初余额', '充值', '赠送', '调账', '期末余额'];
      if (row[0] === '汇总' && blank.includes(row[1] ?? ''))
        expect([row[2], row[3]]).toEqual(['', '']);
      else expect(row[2]).not.toBe('');
    }
    expect(
      rows.filter((row) => row[0] === '国家').map((row) => row[1]),
    ).toEqual(['中国', '=1+1']);
    expect(
      rows.filter((row) => row[0] === '日期').map((row) => row[1]),
    ).toEqual(['2026-09-01', '2026-09-02']);
  });

  it('keeps the exported amounts independent of rounding for four-decimal charges', () => {
    const rows = statementSummaryRows({
      ...statement,
      figures: {
        openingBalance: '0',
        recharge: '10',
        gift: '0',
        adjustment: '0.0001',
        callCharges: '0.1234',
        closingBalance: '9.8767',
        calls: 1,
        callMinutes: '1',
      },
    });
    const summary = rows.filter((row) => row[0] === '汇总');
    expect(
      addDecimalStrings(summary.slice(0, 5).map((row) => row[4] ?? '')),
    ).toBe('9.8767');
  });

  it('names the currency in the amount header and neutralizes formula country names when serialized', () => {
    expect(statementSummaryHeaders('USD')).toEqual([
      '类别',
      '项目',
      '通话数',
      '计费分钟',
      '金额（USD）',
    ]);
    const country = statementSummaryRows(statement).find(
      (row) => row[1] === '=1+1',
    );
    expect(csvRecord(country ?? [])).toBe("国家,'=1+1,3804,19726,986.3");
    const negative = statementSummaryRows(statement).find(
      (row) => row[1] === '通话扣费',
    );
    expect(csvRecord(negative ?? [])).toBe('汇总,通话扣费,12804,49726,-2486.3');
  });
});
