import { describe, expect, it } from 'vitest';
import {
  mailEnvironmentSchema,
  mailSettingsOf,
  workerEnvironmentSchema,
} from './config.js';

const environment = {
  APP_DATABASE_URL:
    'postgresql://fs_billing_app:local@127.0.0.1:5432/fs_billing',
  WORKER_SHARED_KEY: 'test-worker-key-123456',
  WORKER_ALLOWED_IPS: '127.0.0.1',
};
const mailpit = {
  SMTP_HOST: '127.0.0.1',
  SMTP_PORT: '1025',
  SMTP_SECURE: 'false',
  MAIL_FROM: 'billing@example.test',
};
// 与 QQ 邮箱同形的占位值；不是任何真实账号或授权码。
const qq = {
  SMTP_HOST: 'smtp.qq.com',
  SMTP_PORT: '465',
  SMTP_SECURE: 'true',
  SMTP_USER: 'sender@example.test',
  SMTP_PASS: 'placeholder-auth-code',
  MAIL_FROM: 'sender@example.test',
};
const parse = (extra: Record<string, string | undefined>) =>
  workerEnvironmentSchema.safeParse({ ...environment, ...extra });
const messages = (extra: Record<string, string | undefined>) => {
  const result = parse(extra);
  return result.success
    ? []
    : result.error.issues.map(
        (issue) => `${issue.path.join('.')}:${issue.message}`,
      );
};

describe('邮件配置', () => {
  it('is disabled without SMTP_HOST and has the documented defaults', () => {
    const config = workerEnvironmentSchema.parse(environment);
    expect(mailSettingsOf(config)).toBeUndefined();
    expect(config).toMatchObject({
      SMTP_PORT: 465,
      SMTP_SECURE: true,
      SMTP_TIMEOUT_MS: 15000,
      MAIL_RATE_PER_MINUTE: 20,
      MAIL_MAX_ATTEMPTS: 6,
      ALERT_QUIET_MINUTES: 10,
    });
    expect(config.APP_PUBLIC_URL).toBeUndefined();
  });

  it('treats empty mail settings as not set', () => {
    const config = workerEnvironmentSchema.parse({
      ...environment,
      SMTP_HOST: '',
      SMTP_PORT: '',
      SMTP_USER: '',
      SMTP_PASS: '',
      MAIL_FROM: '',
      ALERT_QUIET_MINUTES: '',
      APP_PUBLIC_URL: '',
    });
    expect(mailSettingsOf(config)).toBeUndefined();
    expect(config.SMTP_PORT).toBe(465);
    expect(config.ALERT_QUIET_MINUTES).toBe(10);
  });

  it('accepts plain smtp to a loopback Mailpit without credentials', () => {
    expect(mailSettingsOf(parse(mailpit).data!)).toMatchObject({
      host: '127.0.0.1',
      port: 1025,
      secure: false,
      user: undefined,
      from: 'billing@example.test',
    });
    expect(parse({ ...mailpit, SMTP_HOST: 'localhost' }).success).toBe(true);
    expect(parse({ ...mailpit, SMTP_HOST: '::1' }).success).toBe(true);
  });

  it('accepts implicit tls on 465 and starttls on 587', () => {
    expect(mailSettingsOf(parse(qq).data!)).toMatchObject({
      host: 'smtp.qq.com',
      port: 465,
      secure: true,
      user: 'sender@example.test',
    });
    expect(
      parse({
        ...qq,
        SMTP_HOST: 'smtp.example.test',
        SMTP_PORT: '587',
        SMTP_SECURE: 'false',
      }).success,
    ).toBe(true);
  });

  it('requires MAIL_FROM with SMTP_HOST', () => {
    expect(messages({ ...mailpit, MAIL_FROM: undefined })).toEqual([
      'MAIL_FROM:设置了 SMTP_HOST 就必须设置 MAIL_FROM',
    ]);
    expect(messages({ ...mailpit, MAIL_FROM: 'not an address' })).toHaveLength(
      1,
    );
  });

  it('rejects unauthenticated smtp on a non loopback host', () => {
    // 明文只允许回环：非回环主机必须认证；SMTP_SECURE=false 时传输层强制 STARTTLS（见 mail.test.ts）。
    expect(messages({ ...mailpit, SMTP_HOST: 'mail.example.test' })).toEqual([
      'SMTP_USER:非回环地址的 SMTP 服务器必须认证：需要 SMTP_USER 与 SMTP_PASS',
    ]);
    expect(
      messages({ ...mailpit, SMTP_HOST: '10.0.0.5' }).length,
    ).toBeGreaterThan(0);
  });

  it('requires SMTP_USER and SMTP_PASS together', () => {
    expect(messages({ ...mailpit, SMTP_USER: 'someone' })).toEqual([
      'SMTP_PASS:SMTP_USER 与 SMTP_PASS 必须同时设置或同时不设置',
    ]);
    expect(messages({ ...mailpit, SMTP_PASS: 'secret-value' })).toEqual([
      'SMTP_PASS:SMTP_USER 与 SMTP_PASS 必须同时设置或同时不设置',
    ]);
  });

  it('rejects credentials without a host instead of silently disabling mail', () => {
    expect(
      messages({ SMTP_USER: 'someone', SMTP_PASS: 'secret-value' }),
    ).toEqual([
      'SMTP_USER:设置了 SMTP_USER 却没有 SMTP_HOST',
      'SMTP_PASS:设置了 SMTP_PASS 却没有 SMTP_HOST',
    ]);
  });

  it('rejects inconsistent port and tls combinations', () => {
    expect(messages({ ...qq, SMTP_SECURE: 'false' })).toEqual([
      'SMTP_SECURE:端口 465 是隐式 TLS 端口，SMTP_SECURE 不能为 false',
    ]);
    expect(
      messages({ ...qq, SMTP_HOST: 'smtp.example.test', SMTP_PORT: '587' }),
    ).toEqual([
      'SMTP_SECURE:端口 587 是 STARTTLS 端口，SMTP_SECURE 应为 false；隐式 TLS 用 465',
    ]);
  });

  it('qq sender must equal the authenticated user', () => {
    expect(messages({ ...qq, MAIL_FROM: 'someone-else@example.test' })).toEqual(
      ['MAIL_FROM:QQ 邮箱的 MAIL_FROM 必须与 SMTP_USER 相同'],
    );
    // 比较不区分大小写；子域名也算 QQ。
    expect(parse({ ...qq, MAIL_FROM: 'SENDER@Example.test' }).success).toBe(
      true,
    );
    expect(
      messages({
        ...qq,
        SMTP_HOST: 'smtp.exmail.qq.com',
        MAIL_FROM: 'x@example.test',
      }),
    ).toHaveLength(1);
  });

  it('never echoes the password in a configuration error', () => {
    const secret = 'super-secret-auth-code-1234';
    const result = parse({ ...qq, SMTP_PASS: secret, SMTP_SECURE: 'false' });
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error)).not.toContain(secret);
    expect(String(result.error)).not.toContain(secret);
    const invalid = parse({ ...qq, SMTP_PASS: secret, SMTP_PORT: '0' });
    expect(JSON.stringify(invalid.error)).not.toContain(secret);
  });

  it.each([
    { SMTP_HOST: 'not a host' },
    { SMTP_HOST: 'smtp://mail.example.test' },
    { SMTP_PORT: '0' },
    { SMTP_PORT: '70000' },
    { SMTP_SECURE: 'yes' },
    { SMTP_TIMEOUT_MS: '10' },
    { SMTP_TIMEOUT_MS: '600000' },
    { MAIL_RATE_PER_MINUTE: '0' },
    { MAIL_RATE_PER_MINUTE: '1001' },
    { MAIL_MAX_ATTEMPTS: '0' },
    { MAIL_MAX_ATTEMPTS: '21' },
    { ALERT_QUIET_MINUTES: '0' },
    { ALERT_QUIET_MINUTES: '1441' },
    { ALERT_QUIET_MINUTES: '1.5' },
    { APP_PUBLIC_URL: 'http://bill.example.test' },
    { APP_PUBLIC_URL: 'https://user:pass@bill.example.test' },
    { APP_PUBLIC_URL: 'https://bill.example.test/app' },
    { APP_PUBLIC_URL: 'https://bill.example.test/?a=1' },
    { APP_PUBLIC_URL: 'ftp://bill.example.test' },
    { APP_PUBLIC_URL: 'bill.example.test' },
  ])('rejects invalid mail settings %j', (invalid) => {
    expect(parse({ ...mailpit, ...invalid }).success).toBe(false);
  });

  it('wires ALERT_QUIET_MINUTES and normalizes APP_PUBLIC_URL', () => {
    const config = workerEnvironmentSchema.parse({
      ...environment,
      ...mailpit,
      ALERT_QUIET_MINUTES: '15',
      APP_PUBLIC_URL: 'https://bill.example.test/',
    });
    expect(config.ALERT_QUIET_MINUTES).toBe(15);
    expect(mailSettingsOf(config)?.siteUrl).toBe('https://bill.example.test');
    expect(
      workerEnvironmentSchema.parse({
        ...environment,
        APP_PUBLIC_URL: 'http://127.0.0.1:5173',
      }).APP_PUBLIC_URL,
    ).toBe('http://127.0.0.1:5173');
  });

  it('mailEnvironmentSchema parses without any worker settings', () => {
    expect(mailEnvironmentSchema.safeParse(mailpit).success).toBe(true);
    expect(
      mailEnvironmentSchema.safeParse({ SMTP_HOST: 'mail.example.test' })
        .success,
    ).toBe(false);
  });
});
