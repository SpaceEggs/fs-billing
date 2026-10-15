import { describe, expect, it } from 'vitest';
import type { AdminTenantDetailResponse } from '@fs-billing/shared';
import {
  hasSettingsChanges,
  serverSettingsErrors,
  settingsChanges,
  settingsForm,
  validateSettings,
} from './tenant-settings';

const tenant = {
  id: '00000000-0000-4000-8000-00000000a001',
  code: 'ABC001',
  name: '深圳市某某科技有限公司',
  currency: 'CNY',
  status: 'active',
  health: 'overdraft',
  settingsConfigured: true,
  balance: '-35.2',
  overdraftLimit: '100',
  availableBalance: '64.8',
  monthConsumption: '0',
  pendingReceivable: '0',
  contactName: '',
  contactPhone: '',
  remark: '',
  settings: {
    overdraftLimit: '100',
    lowBalanceThreshold: '200.125',
    emails: ['billing@abc-tech.cn'],
  },
  createdAt: '2026-08-12T02:31:02.000Z',
} satisfies AdminTenantDetailResponse;

describe('tenant settings', () => {
  it('loads saved values without truncating historical precision', () => {
    expect(settingsForm(tenant)).toEqual({
      overdraftLimit: '100.00',
      lowBalanceThreshold: '200.125',
      emails: ['billing@abc-tech.cn'],
    });
  });

  it('rejects negative, over-precise and malformed recipients locally', () => {
    expect(
      validateSettings({
        overdraftLimit: '-50.00',
        lowBalanceThreshold: '200.125',
        emails: ['ops#abc.cn'],
      }),
    ).toEqual({
      ok: false,
      errors: {
        overdraftLimit: '透支额度不能为负数，不允许透支请填 0',
        lowBalanceThreshold: '余额提醒阈值须为数字，最多 10 位整数、2 位小数',
        emails: '「ops#abc.cn」不是有效的邮箱地址',
      },
    });
  });

  it('allows an empty recipient list', () => {
    expect(
      validateSettings({
        overdraftLimit: '300',
        lowBalanceThreshold: '200',
        emails: [],
      }),
    ).toEqual({
      ok: true,
      value: { overdraftLimit: '300', lowBalanceThreshold: '200', emails: [] },
    });
  });

  it('summarizes changes by value, including available balance and recipients', () => {
    const changes = settingsChanges(tenant, {
      overdraftLimit: '300',
      lowBalanceThreshold: '200.125',
      emails: ['finance@abc-tech.cn'],
    });
    expect(changes).toEqual({
      overdraftLimit: { before: '100', after: '300' },
      availableBalance: { before: '64.8', after: '264.8' },
      lowBalanceThreshold: null,
      emailsAdded: ['finance@abc-tech.cn'],
      emailsRemoved: ['billing@abc-tech.cn'],
    });
    expect(hasSettingsChanges(changes)).toBe(true);
    expect(
      hasSettingsChanges(
        settingsChanges(tenant, {
          overdraftLimit: '100.00',
          lowBalanceThreshold: '200.1250',
          emails: ['billing@abc-tech.cn'],
        }),
      ),
    ).toBe(false);
  });

  it('maps server issues to fields', () => {
    expect(
      serverSettingsErrors([
        { path: ['emails', 3], message: '邮箱无效' },
        { path: ['overdraftLimit'], message: '超过上限' },
        { path: [], message: '请求无效' },
      ]),
    ).toEqual({
      emails: '邮箱无效',
      overdraftLimit: '超过上限',
      form: '请求无效',
    });
  });
});
