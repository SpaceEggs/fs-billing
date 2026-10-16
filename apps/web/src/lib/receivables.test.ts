import { describe, expect, it } from 'vitest';
import { ApiRequestError } from './api';
import { formatMoney } from './format';
import type { AdminLedgerEntry, AdminReceivable } from '@fs-billing/shared';
import {
  confirmPaymentFailure,
  reversalCandidates,
  reversePaymentFailure,
  sequencedRequests,
  validateReason,
  voidReceivableFailure,
  validateConfirmPayment,
  visibleTotals,
} from './receivables';

const conflict = (code: string, status = 409) =>
  new ApiRequestError(status, {
    error: { code, message: '冲突', requestId: 'req-test' },
  } as never);

describe('visibleTotals', () => {
  it('keeps CNY and USD as separate exact decimal strings', () => {
    const totals = visibleTotals(
      { CNY: '90071992547409.93', USD: '0.1' },
      undefined,
    );
    expect(totals).toEqual([
      { currency: 'CNY', amount: '90071992547409.93' },
      { currency: 'USD', amount: '0.1' },
    ]);
    // 超出浮点精度的金额原样显示，不相加。
    expect(totals.map(formatMoney)).toEqual([
      '¥90,071,992,547,409.93',
      '$0.10',
    ]);
  });

  it('shows only the selected currency, hiding the placeholder zero', () => {
    expect(visibleTotals({ CNY: '0', USD: '1700' }, 'USD')).toEqual([
      { currency: 'USD', amount: '1700' },
    ]);
    expect(visibleTotals({ CNY: '6300', USD: '0' }, 'CNY')).toEqual([
      { currency: 'CNY', amount: '6300' },
    ]);
  });
});

describe('validateConfirmPayment', () => {
  const bounds = { min: '2026-09-01', max: '2026-10-15' };
  it('accepts both boundary days', () => {
    expect(
      validateConfirmPayment({ receivedOn: '2026-09-01', note: '' }, bounds),
    ).toEqual({});
    expect(
      validateConfirmPayment({ receivedOn: '2026-10-15', note: '' }, bounds),
    ).toEqual({});
  });

  it('rejects empty, future and before-credit dates', () => {
    expect(
      validateConfirmPayment({ receivedOn: '', note: '' }, bounds),
    ).toEqual({ receivedOn: '请选择实际收款日期' });
    expect(
      validateConfirmPayment({ receivedOn: '2026-10-16', note: '' }, bounds),
    ).toEqual({ receivedOn: '收款日期不能晚于今天（北京时间）' });
    expect(
      validateConfirmPayment({ receivedOn: '2026-08-31', note: '' }, bounds),
    ).toEqual({ receivedOn: '收款日期不能早于赊账日期 2026-09-01' });
  });
});

describe('confirmPaymentFailure', () => {
  it.each([
    ['ALREADY_RECEIVED', '该笔已确认收款，可能已由其他管理员处理。'],
    [
      'SETTLEMENT_CONFLICT',
      '该笔的收款状态已变化（例如确认后又被撤销），请核对后重新确认。',
    ],
    ['RECEIVABLE_VOIDED', '该笔应收已作废，不能再确认收款。'],
  ])('maps 409 %s to a stale refresh', (code, message) => {
    expect(confirmPaymentFailure(conflict(code))).toEqual({
      kind: 'stale',
      message,
    });
  });

  it('treats a vanished receivable as stale', () => {
    expect(confirmPaymentFailure(conflict('NOT_FOUND', 404))).toEqual({
      kind: 'stale',
      message: '该笔应收不存在或已被删除。',
    });
  });

  it('puts server validation issues on the fields', () => {
    const error = new ApiRequestError(400, {
      error: {
        code: 'VALIDATION_ERROR',
        message: '校验失败',
        requestId: 'req-test',
        issues: [{ path: ['receivedOn'], message: '收款日期不能早于赊账日期' }],
      },
    } as never);
    expect(confirmPaymentFailure(error)).toEqual({
      kind: 'fields',
      errors: { receivedOn: '收款日期不能早于赊账日期' },
    });
  });

  it('distinguishes an unknown outcome from generic failures', () => {
    expect(confirmPaymentFailure(new ApiRequestError(0, null))).toEqual({
      kind: 'unknown',
    });
    expect(confirmPaymentFailure(conflict('SERVICE_UNAVAILABLE', 503))).toEqual(
      { kind: 'general' },
    );
  });
});

describe('sequencedRequests', () => {
  const settle = <Value>() => {
    let resolve!: (value: Value) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<Value>((ok, fail) => {
      resolve = ok;
      reject = fail;
    });
    return { promise, resolve, reject };
  };

  it('treats rows that were never flagged as fresh', () => {
    const requests = sequencedRequests();
    expect(
      requests.refresh(undefined, {
        data: undefined,
        error: null,
        isFetching: true,
      }),
    ).toBe('fresh');
  });

  it('ignores a response to a request issued before the mark, even if it settles after', async () => {
    const requests = sequencedRequests();
    const early = settle<{ items: string[] }>();
    const before = requests.wrap(() => early.promise)();
    const mark = requests.mark();
    early.resolve({ items: ['old'] });
    const data = await before;
    expect(data.items).toEqual(['old']);
    expect(data.request.number).toBe(1);
    expect(
      requests.refresh(mark, { data, error: null, isFetching: false }),
    ).toBe('refreshing');

    const after = await requests.wrap(() =>
      Promise.resolve({ items: ['new'] }),
    )();
    expect(
      requests.refresh(mark, { data: after, error: null, isFetching: false }),
    ).toBe('fresh');
  });

  it('ignores a response from another sequencer, whatever its number', async () => {
    const earlier = sequencedRequests();
    let cached = await earlier.wrap(() => Promise.resolve({ items: [] }))();
    for (let i = 0; i < 3; i += 1)
      cached = await earlier.wrap(() => Promise.resolve({ items: [] }))();
    const requests = sequencedRequests();
    void requests.wrap(() => new Promise<{ items: string[] }>(() => {}))();
    const mark = requests.mark();
    expect(
      requests.refresh(mark, { data: cached, error: null, isFetching: true }),
    ).toBe('refreshing');
  });

  it('reports failure only for a request issued after the mark, once nothing is in flight', async () => {
    const requests = sequencedRequests();
    const data = await requests.wrap(() => Promise.resolve({ items: [] }))();
    const staleError = conflict('SERVICE_UNAVAILABLE', 503);
    await expect(
      requests.wrap(() => Promise.reject(staleError))(),
    ).rejects.toBe(staleError);
    const mark = requests.mark();
    // 核对前的失败不算核对结果。
    expect(
      requests.refresh(mark, { data, error: staleError, isFetching: false }),
    ).toBe('refreshing');

    const error = conflict('SERVICE_UNAVAILABLE', 503);
    await expect(requests.wrap(() => Promise.reject(error))()).rejects.toBe(
      error,
    );
    expect(requests.refresh(mark, { data, error, isFetching: true })).toBe(
      'refreshing',
    );
    expect(requests.refresh(mark, { data, error, isFetching: false })).toBe(
      'failed',
    );
  });
});

describe('reversalCandidates', () => {
  const tenantId = '00000000-0000-4000-8000-0000000a0001';
  const credit = {
    ledgerEntryId: '00000000-0000-4000-8000-0000000e0001',
    tenant: { id: tenantId, code: 'GZT007', name: '广州', currency: 'CNY' },
    amount: '500.00',
    createdAt: '2026-10-01T02:00:00.000Z',
  } as AdminReceivable;
  const adjustment = (
    id: string,
    amount: string,
    occurredAt: string,
    kind: AdminLedgerEntry['kind'] = 'adjustment',
  ) =>
    ({
      id: `00000000-0000-4000-8000-00000000000${id}`,
      kind,
      amount,
      occurredAt,
    }) as AdminLedgerEntry;
  const later = '2026-10-01T02:00:00.001Z';

  it('keeps only exact negations strictly after the credit', () => {
    const items = [
      adjustment('1', '-500.0000', later),
      adjustment('2', '-500', '2026-10-02T00:00:00.000Z'),
      adjustment('3', '-500.0001', later),
      adjustment('4', '-499.9999', later),
      adjustment('5', '500.0000', later),
      adjustment('6', '-500.0000', credit.createdAt),
      adjustment('7', '-500.0000', '2026-10-01T01:59:59.999Z'),
      adjustment('8', '-500.00', later, 'recharge'),
    ];
    expect(
      reversalCandidates(credit, { tenantId, items }).map((entry) => entry.id),
    ).toEqual([
      '00000000-0000-4000-8000-000000000001',
      '00000000-0000-4000-8000-000000000002',
    ]);
  });

  it("never offers another tenant's ledger", () => {
    expect(
      reversalCandidates(credit, {
        tenantId: '00000000-0000-4000-8000-0000000a0002',
        items: [adjustment('1', '-500.0000', later)],
      }),
    ).toEqual([]);
  });
});

describe('reason and action failures', () => {
  it('requires a nonblank reason up to 2000 characters', () => {
    expect(validateReason('   ')).toBe('请填写原因');
    expect(validateReason('x'.repeat(2001))).toBe('原因最多 2000 字');
    expect(validateReason('x'.repeat(2000))).toBeUndefined();
  });

  it.each([
    [
      'SETTLEMENT_CONFLICT',
      '该笔的收款确认已变化（可能已被撤销或重新确认），请核对后再操作。',
    ],
    ['RECEIVABLE_VOIDED', '该笔应收已作废，不能撤销确认。'],
  ])('reverse 409 %s is stale', (code, message) => {
    expect(reversePaymentFailure(conflict(code))).toEqual({
      kind: 'stale',
      message,
    });
  });

  it.each([
    ['ALREADY_RECEIVED', '该笔已确认收款，须先撤销确认才能作废。'],
    ['RECEIVABLE_VOIDED', '该笔应收已作废，可能已由其他管理员处理。'],
    [
      'RECEIVABLE_REVERSAL_MISMATCH',
      '所选调账不能用于冲正：金额须恰为赊账金额的相反数、晚于赊账，且未被其他作废使用或被之后的反向调账抵消。',
    ],
  ])('void 409 %s is stale', (code, message) => {
    expect(voidReceivableFailure(conflict(code))).toEqual({
      kind: 'stale',
      message,
    });
  });

  it('puts a server reason issue on the field and treats a dropped request as unknown', () => {
    const validation = new ApiRequestError(400, {
      error: {
        code: 'VALIDATION_ERROR',
        message: '校验失败',
        requestId: 'req-test',
        issues: [{ path: ['reason'], message: '原因不能为空' }],
      },
    } as never);
    expect(voidReceivableFailure(validation)).toEqual({
      kind: 'fields',
      errors: { reason: '原因不能为空' },
    });
    expect(
      reversePaymentFailure(new ApiRequestError(0, undefined as never)),
    ).toEqual({ kind: 'unknown' });
  });
});
