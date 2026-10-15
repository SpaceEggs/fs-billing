import { describe, expect, it } from 'vitest';
import {
  addRecipients,
  buildSubmission,
  changeCurrency,
  initialTenantForm,
  normalizedCode,
  serverFieldErrors,
  type TenantForm,
} from './tenant-create';

const filled: TenantForm = {
  ...initialTenantForm('WangMin@example.com'),
  code: 'pcl022',
  name: ' Pacific Link Communications Ltd ',
  lowBalanceThreshold: '200.00',
  portalEmail: 'billing@pacificlink.sg',
};

describe('recipients', () => {
  it('default to the current admin email, lowercased', () => {
    expect(initialTenantForm('WangMin@example.com').emails).toEqual([
      'wangmin@example.com',
    ]);
  });

  it('lowercase and deduplicate before adding, with a notice', () => {
    expect(addRecipients(['ops@a.cn'], 'OPS@A.cn, Finance@A.cn')).toEqual({
      emails: ['ops@a.cn', 'finance@a.cn'],
      notice: '「ops@a.cn」已在列表中',
    });
  });

  it('stop at twenty addresses', () => {
    const twenty = Array.from({ length: 20 }, (_, index) => `u${index}@a.cn`);
    expect(addRecipients(twenty, 'extra@a.cn')).toEqual({
      emails: twenty,
      notice: '最多 20 个通知邮箱',
    });
  });

  it('an empty list is submitted explicitly as no recipients', () => {
    const result = buildSubmission({ ...filled, emails: [] });
    expect(result.ok && result.value.tenant.settings.emails).toEqual([]);
  });

  it('an invalid address blocks submission and is named', () => {
    const result = buildSubmission({
      ...filled,
      emails: ['finance@abc-trade.cn', 'ops#abc-trade.cn'],
    });
    expect(result).toEqual({
      ok: false,
      errors: { emails: '「ops#abc-trade.cn」不是有效的邮箱地址' },
    });
  });
});

describe('currency', () => {
  it('switching updates the default overdraft until the admin edits it', () => {
    const usd = changeCurrency(filled, 'USD');
    expect(usd.overdraftLimit).toBe('15.00');
    const edited = changeCurrency(
      { ...usd, overdraftLimit: '50', overdraftEdited: true },
      'CNY',
    );
    expect(edited.overdraftLimit).toBe('50');
  });

  it('switching clears a copy source from the other currency', () => {
    const copying: TenantForm = {
      ...filled,
      rates: {
        kind: 'copy',
        source: {
          tenantId: '00000000-0000-4000-8000-000000000003',
          versionId: '00000000-0000-4000-8000-000000000004',
          label: '已复制 BJH003 的 8 条费率',
        },
      },
    };
    expect(changeCurrency(copying, 'USD').rates).toEqual({
      kind: 'copy',
      source: null,
    });
  });
});

describe('buildSubmission', () => {
  it('builds both requests from a valid form', () => {
    expect(buildSubmission(filled)).toEqual({
      ok: true,
      value: {
        tenant: {
          code: 'pcl022',
          name: 'Pacific Link Communications Ltd',
          currency: 'CNY',
          contactName: '',
          contactPhone: '',
          remark: '',
          settings: {
            overdraftLimit: '100.00',
            lowBalanceThreshold: '200.00',
            emails: ['wangmin@example.com'],
          },
          initialRates: { kind: 'blank' },
        },
        portal: { email: 'billing@pacificlink.sg' },
      },
    });
  });

  it('reports every invalid field at once', () => {
    expect(
      buildSubmission({
        ...filled,
        code: 'ABC 01!',
        overdraftLimit: '-50',
        lowBalanceThreshold: '1.234',
        portalEmail: 'finance@abc',
        portalPassword: 'short',
        rates: { kind: 'csv', file: null },
      }),
    ).toEqual({
      ok: false,
      errors: {
        code: '只能包含字母和数字，不能有空格或符号',
        overdraftLimit: '透支额度不能为负数，不允许透支请填 0',
        lowBalanceThreshold: '余额提醒阈值须为数字，最多 10 位整数、2 位小数',
        portalEmail: '邮箱格式不正确',
        portalPassword: '初始密码须为 8 到 128 位',
        rates: '请选择要导入的 CSV 文件',
      },
    });
  });

  it('a supplied initial password is passed through', () => {
    const result = buildSubmission({
      ...filled,
      portalPassword: 'Kp7#vR2mQx9s',
    });
    expect(result.ok && result.value.portal).toEqual({
      email: 'billing@pacificlink.sg',
      initialPassword: 'Kp7#vR2mQx9s',
    });
  });
});

describe('code normalization', () => {
  it('shows the uppercase value only when it differs', () => {
    expect(normalizedCode('pcl022')).toBe('PCL022');
    expect(normalizedCode('PCL022')).toBeNull();
    expect(normalizedCode('')).toBeNull();
  });
});

describe('serverFieldErrors', () => {
  it('maps nested settings paths to fields and unknown paths to the form', () => {
    expect(
      serverFieldErrors([
        { path: ['settings', 'emails', 0], message: '请求字段格式错误' },
        { path: ['code'], message: '请求字段格式错误' },
        { path: ['unexpected'], message: '未知字段' },
      ]),
    ).toEqual({
      emails: '请求字段格式错误',
      code: '请求字段格式错误',
      form: '未知字段',
    });
  });
});
