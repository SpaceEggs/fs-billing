import { describe, expect, it } from 'vitest';
import { csvRecord } from '@fs-billing/rating';
import {
  adminCdrCells,
  cdrCells,
  cdrHeaders,
  directionLabel,
  ledgerCells,
  ledgerHeaders,
  type CdrExportRow,
  type LedgerExportRow,
} from './csv-labels.js';

const HAN = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;

const cdr: CdrExportRow = {
  calledAt: '2026-09-28 14:03:22',
  caller: '1001',
  callee: '+86 138-0013 8001',
  direction: 'outbound',
  country: '中国',
  iso: 'CN',
  description: '手机',
  durationSeconds: 60,
  billedMinutes: '1',
  rate: '0.0450',
  charge: '0.0450',
  hangupCause: 'NORMAL_CLEARING',
  matchedPrefix: '86',
  callUuid: '00000000-0000-4000-8000-000000000001',
  startedAt: '2026-09-28 14:02:22',
  endedAt: '2026-09-28 14:04:22',
};

const recharge: LedgerExportRow = {
  kind: 'recharge',
  day: '2026-09-23',
  calls: 1,
  partial: false,
  occurredAt: '2026-09-23 10:15:36',
  amount: '500.00',
  balanceAfter: '500.00',
  note: '账户充值',
  noteKey: 'ledger.accountRecharge',
};

const charge: LedgerExportRow = {
  kind: 'call_charge',
  day: '2026-09-28',
  calls: 356,
  partial: false,
  occurredAt: '2026-09-28 23:59:58',
  amount: '-248.63',
  balanceAfter: '-35.2',
  note: '',
  noteKey: null,
};

describe('CDR export cells', () => {
  it('keeps the Chinese header and rows byte-identical', () => {
    expect(csvRecord(cdrHeaders('zh'))).toBe(
      '接通时间,主叫号码,被叫号码,ISO,国家,说明,通话时长(秒),计费时长(分钟),费率,费用,振铃开始时间,挂断时间,挂断原因,匹配前缀,通话UUID',
    );
    expect(csvRecord(cdrCells(cdr, 'zh'))).toBe(
      "2026-09-28 14:03:22,1001,'+86 138-0013 8001,CN,中国,手机,60,1,0.0450,0.0450,2026-09-28 14:02:22,2026-09-28 14:04:22,NORMAL_CLEARING（正常挂断）,86,00000000-0000-4000-8000-000000000001,呼出",
    );
    expect(csvRecord(adminCdrCells({ ...cdr, unverified: true }, 'zh'))).toBe(
      "2026-09-28 14:03:22,1001,'+86 138-0013 8001,CN,中国,手机,60,1,0.0450,0.0450,2026-09-28 14:02:22,2026-09-28 14:04:22,NORMAL_CLEARING（正常挂断）,86,00000000-0000-4000-8000-000000000001,未经验证,呼出",
    );
  });

  it('writes English headers and system values without Han', () => {
    const headers = cdrHeaders('en');
    expect(headers).toEqual([
      'Answer time (Beijing time)',
      'Caller',
      'Callee',
      'ISO',
      'Country',
      'Description',
      'Duration (seconds)',
      'Billed minutes',
      'Rate',
      'Charge',
      'Ring start time (Beijing time)',
      'Hangup time (Beijing time)',
      'Hangup cause',
      'Matched prefix',
      'Call UUID',
    ]);
    for (const header of headers) expect(HAN.test(header)).toBe(false);
    expect(directionLabel('inbound', 'en')).toBe('Inbound');
    expect(directionLabel('outbound', 'en')).toBe('Outbound');
    const cells = cdrCells(
      {
        ...cdr,
        country: null,
        iso: null,
        description: null,
        rate: null,
        matchedPrefix: null,
        hangupCause: 'NO_ANSWER',
        direction: 'inbound',
      },
      'en',
    );
    expect(cells).toContain('Unanswered');
    expect(cells).toContain('NO_ANSWER (No answer)');
    expect(cells.at(-1)).toBe('Inbound');
    expect(adminCdrCells({ ...cdr, unverified: true }, 'en').slice(-2)).toEqual(
      ['Unverified', 'Outbound'],
    );
  });
});

describe('ledger export cells', () => {
  it('keeps the Chinese header, kinds and notes byte-identical', () => {
    expect(csvRecord(ledgerHeaders('CNY', 'zh'))).toBe(
      '时间,类型,金额（CNY）,变动后余额（CNY）,备注',
    );
    expect(csvRecord(ledgerCells(recharge, 'zh'))).toBe(
      '2026-09-23 10:15:36,充值,500.00,500.00,账户充值',
    );
    expect(csvRecord(ledgerCells(charge, 'zh'))).toBe(
      '2026-09-28 23:59:58,通话扣费,-248.63,-35.2,2026-09-28 通话扣费，共 356 通',
    );
  });

  it('writes English headers, kinds and notes without Han', () => {
    expect(ledgerHeaders('USD', 'en')).toEqual([
      'Time',
      'Type',
      'Amount (USD)',
      'Balance after (USD)',
      'Note',
    ]);
    expect(ledgerCells(recharge, 'en')).toEqual([
      '2026-09-23 10:15:36',
      'Recharge',
      '500.00',
      '500.00',
      'Account recharge',
    ]);
    expect(ledgerCells(charge, 'en').at(-1)).toBe(
      '2026-09-28 Call charges, 356 calls',
    );
  });
});
