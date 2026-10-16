import { describe, expect, it } from 'vitest';
import { ApiRequestError } from './api';
import { formatMoney } from './format';
import {
  confirmPaymentFailure,
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
