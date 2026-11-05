import type {} from '../../../packages/db/test/global-setup.js';
import type { FastifyBaseLogger } from 'fastify';
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { updateMailSettings, type MailSettingsInput } from '@fs-billing/db';
import type { MailSettings } from '@fs-billing/mailer';
import { adminId, connections } from '../../../packages/db/test/support.js';
import { resolveMailSettings, type MailTuning } from './mail-settings.js';

const { app, owner } = connections();
const key = Buffer.alloc(32, 7);
const otherKey = Buffer.alloc(32, 9);
const tuning: MailTuning = {
  timeoutMs: 7000,
  ratePerTick: 3,
  maxAttempts: 2,
};
const envSettings: MailSettings = {
  host: 'env.example.test',
  port: 587,
  secure: false,
  user: 'env-user',
  pass: 'env-pass',
  from: 'env@example.test',
  timeoutMs: 15000,
  ratePerTick: 20,
  maxAttempts: 6,
  siteUrl: 'https://env.example.test',
};

let actor: { id: string; name: string };
beforeAll(async () => {
  actor = { id: await adminId(owner), name: '管理员' };
});

const reset = () =>
  owner.pool.query(
    `update smtp_settings
        set managed = false, enabled = false, host = null, port = null, secure = null,
            username = null, password_ciphertext = null, mail_from = null, site_url = null,
            last_test_at = null, last_test_ok = null, last_test_result = null,
            version = 1, updated_at = now(), updated_by = null`,
  );

beforeEach(reset);
afterAll(reset);

const base: MailSettingsInput = {
  enabled: true,
  host: 'smtp.example.com',
  port: 465,
  secure: true,
  username: 'ops@example.com',
  mailFrom: 'ops@example.com',
  siteUrl: 'https://billing.example.test',
};

/** 用 `updateMailSettings` 准备页面管理的配置（它会把 managed 设为 true）。 */
function save(
  keyToUse: Buffer = key,
  overrides: Partial<MailSettingsInput> = {},
  // 传 null 表示不提供密码；传 undefined 会触发默认值。
  password: string | null = 'db-secret',
) {
  return updateMailSettings(app.db, {
    actor,
    key: keyToUse,
    expectedVersion: 1,
    input: { ...base, ...overrides, password: password ?? undefined },
  });
}

const resolve = (
  options: {
    envSettings?: MailSettings | undefined;
    key?: Buffer | undefined;
    logger?: Pick<FastifyBaseLogger, 'error'>;
  } = {},
) =>
  resolveMailSettings(app.db, {
    envSettings: 'envSettings' in options ? options.envSettings : envSettings,
    key: 'key' in options ? options.key : key,
    tuning,
    logger: options.logger,
  });

/** 让 `vi.fn()` 满足 Fastify 的 LogFn 重载；调用次数仍通过原 mock 断言。 */
const loggerOf = (error: ReturnType<typeof vi.fn>) =>
  ({ error }) as unknown as Pick<FastifyBaseLogger, 'error'>;

describe('邮件配置来源', () => {
  it('managed = false 时原样返回环境变量配置', async () => {
    expect(await resolve()).toBe(envSettings);
  });

  it('managed = false 且没有环境变量配置时不发信', async () => {
    expect(await resolve({ envSettings: undefined })).toBeUndefined();
  });

  it('managed 且启用时用数据库配置并解密密码，超时等仍来自环境变量', async () => {
    await save();
    const resolved = await resolve({
      // 环境变量故意指向别处：页面管理后不再看它。
      envSettings: { ...envSettings, host: 'ignored.example.test' },
    });
    expect(resolved).toEqual({
      host: base.host,
      port: base.port,
      secure: base.secure,
      user: base.username,
      pass: 'db-secret',
      from: base.mailFrom,
      timeoutMs: tuning.timeoutMs,
      ratePerTick: tuning.ratePerTick,
      maxAttempts: tuning.maxAttempts,
      siteUrl: base.siteUrl,
    });
  });

  it('managed 且停用时返回 undefined，即使配了环境变量', async () => {
    await save(key, { enabled: false });
    expect(await resolve()).toBeUndefined();
  });

  it('密码解不开时返回 undefined、不回退环境变量、日志不含密文和明文', async () => {
    await save();
    const { rows } = await owner.pool.query<{ password_ciphertext: string }>(
      'select password_ciphertext from smtp_settings',
    );
    const ciphertext = rows[0]!.password_ciphertext;
    const error = vi.fn();
    const resolved = await resolve({ key: otherKey, logger: loggerOf(error) });
    expect(resolved).toBeUndefined();
    expect(error).toHaveBeenCalledTimes(1);
    const logged = JSON.stringify(error.mock.calls);
    expect(logged).not.toContain(ciphertext);
    expect(logged).not.toContain('db-secret');
    expect(logged).not.toContain(otherKey.toString('base64'));
    expect(logged).not.toContain(envSettings.host);
  });

  it('没有密钥时返回 undefined、不回退环境变量、日志不含密文和明文', async () => {
    await save();
    const { rows } = await owner.pool.query<{ password_ciphertext: string }>(
      'select password_ciphertext from smtp_settings',
    );
    const ciphertext = rows[0]!.password_ciphertext;
    const error = vi.fn();
    const resolved = await resolve({ key: undefined, logger: loggerOf(error) });
    expect(resolved).toBeUndefined();
    expect(error).toHaveBeenCalledTimes(1);
    const logged = JSON.stringify(error.mock.calls);
    expect(logged).not.toContain(ciphertext);
    expect(logged).not.toContain('db-secret');
  });

  it('siteUrl 为空时不回退到环境变量的 APP_PUBLIC_URL', async () => {
    await save(key, { siteUrl: null });
    expect((await resolve())!.siteUrl).toBeUndefined();
  });

  it('用户名为空或 null 时映射为 undefined（回环地址的开发配置）', async () => {
    await save(
      key,
      { host: '127.0.0.1', port: 1025, secure: false, username: null },
      null,
    );
    expect(await resolve()).toMatchObject({ user: undefined, pass: undefined });
  });

  it('有账号却没有密文时记错误并返回 undefined', async () => {
    await owner.pool.query(
      `update smtp_settings
          set managed = true, enabled = true, host = 'smtp.example.com', port = 465,
              secure = true, username = 'ops@example.com', password_ciphertext = null,
              mail_from = 'ops@example.com', site_url = null`,
    );
    const error = vi.fn();
    expect(await resolve({ logger: loggerOf(error) })).toBeUndefined();
    expect(error).toHaveBeenCalledTimes(1);
  });
});
