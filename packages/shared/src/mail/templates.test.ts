import { describe, expect, it } from 'vitest';
import {
  MAIL_TEMPLATES,
  formatBeijingTime,
  formatDuration,
  mailParamsSchemas,
  renderMail,
} from './templates.js';

const lowParams = {
  tenantCode: 'ABC001',
  tenantName: '华东示例公司',
  currency: 'CNY',
  balance: '80.00',
  threshold: '100.00',
  overdraftLimit: '100.00',
  available: '180.00',
} as const;
const suspendedParams = {
  tenantCode: 'HZX014',
  tenantName: '杭州示例',
  currency: 'USD',
  balance: '-100.36',
  overdraftLimit: '100.00',
} as const;
const startedAt = '2026-10-29T06:03:00.000Z';
const startParams = {
  alerts: [
    {
      kind: 'auth_timeout',
      description: '授权接口超时放行',
      startedAt,
    },
    { kind: 'cdr_failed', description: '话单保存失败', startedAt },
  ],
};
const digestParams = {
  alerts: [
    {
      kind: 'auth_timeout',
      description: '授权接口超时放行',
      startedAt,
      durationMinutes: 95,
      added: 10,
      total: 21,
      topTenants: ['ABC001', 'XYZ002'],
    },
  ],
};
const recoveredParams = {
  alerts: [
    {
      kind: 'auth_timeout',
      startedAt,
      recoveredAt: '2026-10-29T06:29:00.000Z',
      durationMinutes: 26,
      total: 20,
      affectedCalls: 20,
    },
  ],
};
const samples = {
  balance_low: lowParams,
  balance_suspended: suspendedParams,
  alert_start: startParams,
  alert_digest: digestParams,
  alert_recovered: recoveredParams,
  test: { sentAt: startedAt },
} as const;

describe('邮件模板', () => {
  it.each(MAIL_TEMPLATES)(
    '%s renders subject, plain text and html without line breaks in the subject',
    (template) => {
      const mail = renderMail(template, samples[template]);
      expect(mail.subject).not.toMatch(/[\r\n]/);
      expect(mail.subject.length).toBeGreaterThan(0);
      expect(mail.text.length).toBeGreaterThan(0);
      expect(mail.html).toContain('<!doctype html>');
      expect(mail.html).toContain('lang="zh-CN"');
    },
  );

  it('subjects follow the design', () => {
    expect(renderMail('balance_low', lowParams).subject).toBe(
      '【余额不足】华东示例公司 余额 CNY 80.00',
    );
    expect(renderMail('balance_suspended', suspendedParams).subject).toBe(
      '【已停机】杭州示例 可用额度已用完',
    );
    expect(renderMail('alert_start', startParams).subject).toBe(
      '【故障告警】2 项告警开始：授权超时、话单处理失败',
    );
    expect(renderMail('alert_digest', digestParams).subject).toBe(
      '【故障汇总】1 项告警仍在进行',
    );
    expect(renderMail('alert_recovered', recoveredParams).subject).toBe(
      '【故障恢复】授权超时 已恢复，持续 26 分钟',
    );
    expect(renderMail('test', samples.test).subject).toBe(
      '【测试邮件】FS-Billing',
    );
  });

  it('shows times in Beijing time regardless of the host time zone', () => {
    // 06:03 UTC 是北京时间 14:03；夏令时之类的偏移不影响 Asia/Shanghai。
    expect(formatBeijingTime('2026-10-29T06:03:00Z')).toBe('2026-10-29 14:03');
    expect(formatBeijingTime('2026-10-29T16:30:00-08:00')).toBe(
      '2026-10-30 08:30',
    );
    const mail = renderMail('alert_recovered', recoveredParams);
    expect(mail.text).toContain('开始：2026-10-29 14:03 北京时间');
    expect(mail.text).toContain(
      '恢复：2026-10-29 14:29 北京时间（持续 26 分钟）',
    );
  });

  it('formats durations', () => {
    expect(formatDuration(0)).toBe('不到 1 分钟');
    expect(formatDuration(59)).toBe('59 分钟');
    expect(formatDuration(60)).toBe('1 小时');
    expect(formatDuration(95)).toBe('1 小时 35 分钟');
    expect(formatDuration(1440)).toBe('1 天');
    expect(formatDuration(1500)).toBe('1 天 1 小时');
  });

  it('digest carries duration, new and total counts and the busiest tenants', () => {
    const { text } = renderMail('alert_digest', digestParams);
    expect(text).toContain('持续 1 小时 35 分钟');
    expect(text).toContain('距上次通知新增 10 次，累计 21 次');
    expect(text).toContain('受影响最多的租户：ABC001、XYZ002');
  });

  it('escapes html in tenant names and strips line breaks from subjects', () => {
    const mail = renderMail('balance_low', {
      ...lowParams,
      tenantName: '<script>alert(1)</script>\r\nBcc: attacker@example.com',
    });
    expect(mail.subject).not.toMatch(/[\r\n]/);
    expect(mail.subject).toContain('<script>');
    expect(mail.html).not.toContain('<script>');
    expect(mail.html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    // 正文里名称也折成单行，换行不会带出一个看起来像头部的行。
    expect(mail.text).not.toMatch(/^Bcc:/m);
    expect(mail.html).not.toMatch(/\r|\nBcc:/);
  });

  it('escapes quotes in the site link attribute', () => {
    const mail = renderMail('alert_start', startParams, {
      siteUrl: 'https://bill.example.test/"onmouseover="x',
    });
    expect(mail.html).toContain('&quot;onmouseover=&quot;x');
    expect(mail.html).not.toContain('"onmouseover="x');
  });

  it('removes call UUIDs from alert descriptions', () => {
    const uuid = '3f2b8c1e-9a4d-4e6f-8b7a-1c2d3e4f5a6b';
    const mail = renderMail('alert_start', {
      alerts: [
        {
          kind: 'cdr_failed',
          description: `话单停放到未归属：号码不一致，最近一通 ${uuid}`,
          startedAt,
        },
      ],
    });
    expect(mail.text).not.toContain(uuid);
    expect(mail.html).not.toContain(uuid);
    expect(mail.text).toContain('话单停放到未归属：号码不一致，最近一通 …');
  });

  it('never prints numbers, accounts or other tenants', () => {
    const other = {
      ...lowParams,
      tenantCode: 'OTHER99',
      tenantName: '别家公司',
    };
    const mail = renderMail('balance_low', lowParams);
    expect(mail.text + mail.html).not.toContain(other.tenantCode);
    expect(mail.text + mail.html).not.toContain(other.tenantName);
    // params 是严格对象：想塞主叫、被叫之类的多余字段会在渲染前被拒绝。
    expect(() =>
      renderMail('balance_low', { ...lowParams, callee: '8613800138000' }),
    ).toThrow();
    expect(() =>
      renderMail('alert_start', {
        alerts: [{ ...startParams.alerts[0], callee: '8613800138000' }],
      }),
    ).toThrow();
  });

  it('includes a site link only when a site URL is configured', () => {
    expect(renderMail('alert_start', startParams).text).not.toContain('http');
    const withLink = renderMail('alert_start', startParams, {
      siteUrl: 'https://bill.example.test',
    });
    expect(withLink.text).toContain(
      '查看详情：https://bill.example.test/admin/system-alerts',
    );
    expect(withLink.html).toContain(
      'href="https://bill.example.test/admin/system-alerts"',
    );
    // 测试邮件没有链接。
    expect(
      renderMail('test', samples.test, { siteUrl: 'https://bill.example.test' })
        .text,
    ).not.toContain('http');
  });

  it('rejects invalid params instead of rendering them', () => {
    expect(() =>
      renderMail('balance_low', { ...lowParams, balance: 'abc' }),
    ).toThrow();
    expect(() => renderMail('alert_start', { alerts: [] })).toThrow();
    expect(() => renderMail('test', { sentAt: 'yesterday' })).toThrow();
  });

  it('has a params schema for every template', () => {
    expect(Object.keys(mailParamsSchemas).sort()).toEqual(
      [...MAIL_TEMPLATES].sort(),
    );
  });

  it('merges several recovered alerts into one subject', () => {
    const [first] = recoveredParams.alerts;
    const mail = renderMail('alert_recovered', {
      alerts: [first, { ...first, kind: 'cdr_failed' }],
    });
    expect(mail.subject).toBe(
      '【故障恢复】2 项告警已恢复：授权超时、话单处理失败',
    );
  });
});
