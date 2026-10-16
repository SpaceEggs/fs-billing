import { describe, expect, it } from 'vitest';
import { DEFAULT_ADMIN_RATE_SCHEDULE_HORIZON_MS } from '@fs-billing/shared';
import { ApiRequestError } from './api';
import {
  beijingMinuteToIso,
  cancelFailureMessage,
  countChanges,
  diffRateTables,
  rateChangePercent,
  rateEditFailure,
  resolveSchedule,
  scheduleBounds,
  validateRateEdit,
} from './rates';

const failure = (status: number, code: string, extra: object = {}) =>
  new ApiRequestError(status, {
    error: { code, message: '服务端消息', requestId: 'req', ...extra },
  } as never);

const uk = { prefix: '447', country: '英国手机', rate: '0.0450' };

describe('diffRateTables', () => {
  it('derives added, modified and deleted rows from two full tables', () => {
    const current = [
      { prefix: '1', country: '美国/加拿大', rate: '0.0100' },
      { prefix: '44', country: '英国', rate: '0.0200' },
      uk,
      { prefix: '91', country: '印度', rate: '0.0520' },
    ];
    const scheduled = [
      { prefix: '1', country: '美国/加拿大', rate: '0.01' },
      { prefix: '44', country: '英国固话', rate: '0.0200' },
      { prefix: '447', country: '英国手机', rate: '0.0480' },
      { prefix: '1876', country: '牙买加', rate: '0.2500' },
    ];
    const changes = diffRateTables(current, scheduled);
    expect(changes).toEqual([
      {
        kind: 'modified',
        before: { prefix: '44', country: '英国', rate: '0.0200' },
        after: { prefix: '44', country: '英国固话', rate: '0.0200' },
      },
      {
        kind: 'modified',
        before: uk,
        after: { prefix: '447', country: '英国手机', rate: '0.0480' },
      },
      {
        kind: 'added',
        after: { prefix: '1876', country: '牙买加', rate: '0.2500' },
      },
      {
        kind: 'deleted',
        before: { prefix: '91', country: '印度', rate: '0.0520' },
      },
    ]);
    expect(countChanges(changes)).toEqual({
      added: 1,
      modified: 2,
      deleted: 1,
    });
  });

  it('identical tables have no changes', () => {
    expect(diffRateTables([uk], [{ ...uk, rate: '0.045' }])).toEqual([]);
  });
});

describe('rateChangePercent', () => {
  it('formats rises and falls to one decimal', () => {
    expect(rateChangePercent('0.0450', '0.0480')).toEqual({
      rising: true,
      text: '+6.7%',
    });
    expect(rateChangePercent('0.0500', '0.0450')).toEqual({
      rising: false,
      text: '-10.0%',
    });
  });

  it('has no percent from zero or without a rate change', () => {
    expect(rateChangePercent('0', '0.0100')).toBeNull();
    expect(rateChangePercent('0.0450', '0.045')).toBeNull();
  });
});

describe('beijing minute picker', () => {
  it('submits the picked Beijing minute with seconds 00 and +08:00', () => {
    expect(beijingMinuteToIso('2026-10-20T00:00')).toBe(
      '2026-10-20T00:00:00+08:00',
    );
    expect(Date.parse(beijingMinuteToIso('2026-10-20T00:00')!)).toBe(
      Date.parse('2026-10-19T16:00:00Z'),
    );
  });

  it('rejects impossible or incomplete values', () => {
    expect(beijingMinuteToIso('2026-02-30T10:00')).toBeNull();
    expect(beijingMinuteToIso('2026-10-20T24:00')).toBeNull();
    expect(beijingMinuteToIso('')).toBeNull();
  });

  it('bounds start at the next whole minute and end at now + horizon', () => {
    const now = Date.parse('2026-10-16T01:02:03.456Z');
    expect(scheduleBounds(now, DEFAULT_ADMIN_RATE_SCHEDULE_HORIZON_MS)).toEqual(
      { min: '2026-10-16T09:03', max: '2027-10-16T09:02' },
    );
  });
});

describe('resolveSchedule horizon', () => {
  const horizon = DEFAULT_ADMIN_RATE_SCHEDULE_HORIZON_MS;
  const now = Date.parse('2026-10-16T01:02:00Z');

  it('immediate needs no time', () => {
    expect(resolveSchedule({ kind: 'immediate' }, now, horizon)).toEqual({
      schedule: { kind: 'immediate' },
    });
  });

  it('accepts exactly now and exactly now + horizon', () => {
    expect(
      resolveSchedule(
        { kind: 'scheduled', minute: '2026-10-16T09:02' },
        now,
        horizon,
      ),
    ).toEqual({
      schedule: {
        kind: 'scheduled',
        effectiveFrom: '2026-10-16T09:02:00+08:00',
      },
    });
    expect(
      resolveSchedule(
        { kind: 'scheduled', minute: '2027-10-16T09:02' },
        now,
        horizon,
      ),
    ).toEqual({
      schedule: {
        kind: 'scheduled',
        effectiveFrom: '2027-10-16T09:02:00+08:00',
      },
    });
  });

  it('rejects one minute before now and one minute past the horizon', () => {
    expect(
      resolveSchedule(
        { kind: 'scheduled', minute: '2026-10-16T09:01' },
        now,
        horizon,
      ),
    ).toEqual({ error: '生效时间必须晚于当前时间' });
    expect(
      resolveSchedule(
        { kind: 'scheduled', minute: '2027-10-16T09:03' },
        now,
        horizon,
      ),
    ).toEqual({ error: '生效时间不能晚于 2027-10-16 09:02:00' });
    expect(
      resolveSchedule({ kind: 'scheduled', minute: '' }, now, horizon),
    ).toEqual({ error: '请选择生效时间' });
  });
});

describe('validateRateEdit', () => {
  it('returns the full entry with trimmed values', () => {
    expect(
      validateRateEdit(uk, { country: ' 英国手机 ', rate: '0.048' }),
    ).toEqual({ entry: { prefix: '447', country: '英国手机', rate: '0.048' } });
  });

  it('uses the draft copy for rate errors', () => {
    const rate = (value: string) =>
      validateRateEdit(uk, { country: '英国手机', rate: value });
    expect(rate('')).toEqual({ errors: { rate: '请输入费率' } });
    expect(rate('-0.01')).toEqual({ errors: { rate: '费率不能为负数' } });
    expect(rate('0.04801')).toEqual({ errors: { rate: '小数不超过 4 位' } });
    expect(rate('abc')).toEqual({ errors: { rate: '请输入有效的费率' } });
    expect(rate('0.045')).toEqual({ errors: { rate: '新费率与当前费率相同' } });
  });

  it('allows a country-only change', () => {
    expect(
      validateRateEdit(uk, { country: '英国移动', rate: '0.0450' }),
    ).toEqual({
      entry: { prefix: '447', country: '英国移动', rate: '0.0450' },
    });
    expect(validateRateEdit(uk, { country: ' ', rate: '0.05' })).toEqual({
      errors: { country: '请输入国家/备注' },
    });
  });
});

describe('rateEditFailure', () => {
  it('sends entry field issues back to the form step', () => {
    const error = failure(400, 'VALIDATION_ERROR', {
      issues: [{ path: ['entry', 'rate'], message: '请求字段格式错误' }],
    });
    expect(rateEditFailure(error)).toEqual({
      step: 'form',
      fields: { rate: '请求字段格式错误' },
      general: false,
    });
  });

  it('keeps schedule issues on the confirm step', () => {
    const error = failure(400, 'VALIDATION_ERROR', {
      issues: [
        { path: ['schedule', 'effectiveFrom'], message: '请求字段格式错误' },
      ],
    });
    expect(rateEditFailure(error)).toEqual({
      step: 'confirm',
      fields: { effectiveFrom: '请求字段格式错误' },
      general: false,
    });
  });

  it('issues without a field and other failures use the general notice', () => {
    expect(
      rateEditFailure(
        failure(400, 'VALIDATION_ERROR', {
          issues: [{ path: [], message: '费率请求格式或排期无效' }],
        }),
      ),
    ).toEqual({ step: 'confirm', fields: {}, general: true });
    expect(rateEditFailure(failure(409, 'RATE_VERSION_CONFLICT'))).toEqual({
      step: 'confirm',
      fields: {},
      general: true,
    });
  });
});

describe('cancelFailureMessage', () => {
  it('explains the cancellation margin and stale versions', () => {
    expect(cancelFailureMessage(failure(409, 'RATE_VERSION_CONFLICT'))).toBe(
      '该版本已生效或即将生效，不能取消；也可能费率表已被修改。请刷新后查看。',
    );
    expect(cancelFailureMessage(failure(404, 'NOT_FOUND'))).toBe(
      '该排定版本已不存在，可能已被取消。请刷新后查看。',
    );
  });

  it('leaves other failures to the generic notice', () => {
    expect(
      cancelFailureMessage(failure(503, 'SERVICE_UNAVAILABLE')),
    ).toBeNull();
    expect(cancelFailureMessage(new ApiRequestError(0, null))).toBeNull();
  });
});
