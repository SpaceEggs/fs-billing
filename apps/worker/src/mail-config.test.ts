import { describe, expect, it } from 'vitest';
import { mailSettingsOf } from '@fs-billing/mailer';
import { workerEnvironmentSchema } from './config.js';

const environment = {
  APP_DATABASE_URL:
    'postgresql://fs_billing_app:local@127.0.0.1:5432/fs_billing',
  WORKER_SHARED_KEY: 'test-worker-key-123456',
  WORKER_ALLOWED_IPS: '127.0.0.1',
};

describe('Worker 邮件配置接线', () => {
  it('仍从邮件配置形状读取 SMTP 设置', () => {
    const config = workerEnvironmentSchema.parse({
      ...environment,
      SMTP_HOST: '127.0.0.1',
      SMTP_PORT: '1025',
      SMTP_SECURE: 'false',
      MAIL_FROM: 'billing@example.test',
      ALERT_QUIET_MINUTES: '15',
      APP_PUBLIC_URL: 'https://bill.example.test/',
    });
    expect(config.ALERT_QUIET_MINUTES).toBe(15);
    expect(mailSettingsOf(config)).toMatchObject({
      host: '127.0.0.1',
      port: 1025,
      secure: false,
      from: 'billing@example.test',
      siteUrl: 'https://bill.example.test',
    });
  });

  it('没有 SMTP_HOST 时邮件发送未启用', () => {
    expect(
      mailSettingsOf(workerEnvironmentSchema.parse(environment)),
    ).toBeUndefined();
  });
});
