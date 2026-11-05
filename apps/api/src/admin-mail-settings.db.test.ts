import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  adminApiErrorSchema,
  adminMailSettingsResponseSchema,
  adminMailSettingsTestResponseSchema,
  adminMailSettingsUpdateResponseSchema,
  type AdminMailSettingsEnvironment,
} from '@fs-billing/shared';
import type { MailSettings, MailTransport } from '@fs-billing/mailer';
import {
  apiConnections,
  createFixture,
  fixtureApi,
  login,
  requestHeaders,
  type Fixture,
} from '../test/support.js';
import { createApiLogger } from '../src/logging.js';

const connections = apiConnections();
const key = Buffer.alloc(32, 5);
const emptyEnv: AdminMailSettingsEnvironment = {
  host: null,
  port: null,
  secure: null,
  username: null,
  mailFrom: null,
  siteUrl: null,
};

const createApiFor = (options: {
  key?: Buffer | undefined;
  allowPlaintext?: boolean;
  transportFactory?: (settings: MailSettings) => MailTransport;
  lookupHost?: (host: string) => Promise<readonly { address: string }[]>;
  env?: AdminMailSettingsEnvironment;
  loggerInstance?: ReturnType<typeof createApiLogger>;
}) =>
  fixtureApi(connections, {
    mailSettings: {
      key: options.key,
      allowPlaintext: options.allowPlaintext ?? true,
      timeoutMs: 2_000,
      env: options.env ?? emptyEnv,
      ...(options.transportFactory
        ? { transportFactory: options.transportFactory }
        : {}),
      ...(options.lookupHost ? { lookupHost: options.lookupHost } : {}),
    },
    ...(options.loggerInstance
      ? { loggerInstance: options.loggerInstance }
      : {}),
  });

const main = createApiFor({ key });
const keyless = createApiFor({});
const api = main.api;

let fixture: Fixture;
let cookie: string;
let otherCookie: string;

const get = (from = api, as = cookie) =>
  from.inject({
    url: '/api/admin/mail-settings',
    headers: requestHeaders(as),
  });
const put = (payload: object, from = api, as = cookie) =>
  from.inject({
    method: 'PUT',
    url: '/api/admin/mail-settings',
    headers: requestHeaders(as),
    payload,
  });
const postTest = (payload: object, from = api, as = cookie) =>
  from.inject({
    method: 'POST',
    url: '/api/admin/mail-settings/test',
    headers: requestHeaders(as),
    payload,
  });

const validUpdate = {
  enabled: true,
  host: 'smtp.example.test',
  port: 465,
  secure: true,
  username: 'ops@example.test',
  mailFrom: 'ops@example.test',
  siteUrl: 'https://billing.example.test',
};

const validTest = {
  ...validUpdate,
  to: 'recipient@example.test',
};

const resetSettings = () =>
  connections.owner.pool.query(
    `update smtp_settings
        set managed = false, enabled = false, host = null, port = null, secure = null,
            username = null, password_ciphertext = null, mail_from = null, site_url = null,
            last_test_at = null, last_test_ok = null, last_test_result = null,
            version = 1, updated_at = now(), updated_by = null`,
  );

const logText = async () => {
  const { rows } = await connections.owner.pool.query<{ text: string }>(
    `select details::text as text from operation_logs
      where action in ('mail_settings_update', 'mail_settings_test')`,
  );
  return rows.map((row) => row.text).join('\n');
};

const successTransport = (): MailTransport => ({
  send: () =>
    Promise.resolve({
      accepted: ['recipient@example.test'],
      rejected: [],
      response: '250 OK',
    }),
  close: () => {},
});
const captureTransport =
  (captured: MailSettings[]): ((settings: MailSettings) => MailTransport) =>
  (settings) => {
    captured.push(settings);
    return successTransport();
  };

beforeAll(async () => {
  fixture = await createFixture(connections);
  cookie = (await login(api, fixture.admin)).cookie;
  otherCookie = (await login(api, fixture.otherAdmin)).cookie;
});

beforeEach(resetSettings);
afterAll(resetSettings);

describe('GET /api/admin/mail-settings', () => {
  it('reads defaults without any secret field', async () => {
    const response = await get();
    expect(response.statusCode, response.body).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    const body = adminMailSettingsResponseSchema.parse(response.json());
    expect(body).toMatchObject({
      managed: false,
      enabled: false,
      host: null,
      port: null,
      secure: null,
      username: null,
      passwordSet: false,
      mailFrom: null,
      siteUrl: null,
      version: 1,
      source: 'none',
      env: emptyEnv,
      keyConfigured: true,
      passwordUsable: true,
      allowPlaintext: true,
    });
    expect(body.delivery.pendingCount).toBeGreaterThanOrEqual(0);
    expect(body).not.toHaveProperty('password');
    expect(body).not.toHaveProperty('passwordCiphertext');
    expect(response.body).not.toContain('ciphertext');
  });
});

describe('PUT /api/admin/mail-settings', () => {
  it('saves settings, never returns the password and never logs it', async () => {
    const password = 'unique-smtp-password-4c1d';
    const response = await put({
      ...validUpdate,
      expectedVersion: 1,
      password,
    });
    expect(response.statusCode, response.body).toBe(200);
    const saved = adminMailSettingsUpdateResponseSchema.parse(response.json());
    expect(saved).toMatchObject({
      managed: true,
      enabled: true,
      host: validUpdate.host,
      port: 465,
      secure: true,
      username: validUpdate.username,
      passwordSet: true,
      source: 'page',
      version: 2,
    });
    expect(saved.auditId).toEqual(expect.any(String));
    expect(response.body).not.toContain(password);
    expect(response.body).not.toContain('ciphertext');
    expect(await logText()).not.toContain(password);
    const read = adminMailSettingsResponseSchema.parse((await get()).json());
    expect(read).toMatchObject({ passwordSet: true, source: 'page' });
    expect(JSON.stringify(read)).not.toContain(password);
  });

  it('rejects a stale version with 409 and writes no log', async () => {
    expect(
      (await put({ ...validUpdate, expectedVersion: 1, password: 'a' }))
        .statusCode,
    ).toBe(200);
    const before = await logText();
    const stale = await put(
      { ...validUpdate, expectedVersion: 1, password: 'b' },
      api,
      otherCookie,
    );
    expect(stale.statusCode, stale.body).toBe(409);
    expect(adminApiErrorSchema.parse(stale.json()).error.code).toBe(
      'MAIL_SETTINGS_VERSION_CONFLICT',
    );
    expect(await logText()).toBe(before);
  });

  it('requires host, port, secure and mailFrom when enabled', async () => {
    const response = await put({
      ...validUpdate,
      enabled: true,
      host: null,
      expectedVersion: 1,
      password: 'x',
    });
    expect(response.statusCode, response.body).toBe(400);
    expect(adminApiErrorSchema.parse(response.json()).error.code).toBe(
      'VALIDATION_ERROR',
    );
  });

  it('rejects changing the host without a new password and writes no log', async () => {
    await put({
      ...validUpdate,
      expectedVersion: 1,
      password: 'saved-password',
    });
    const before = await logText();
    const response = await put(
      {
        ...validUpdate,
        host: 'smtp.attacker.test',
        expectedVersion: 2,
      },
      api,
      otherCookie,
    );
    expect(response.statusCode, response.body).toBe(400);
    expect(adminApiErrorSchema.parse(response.json()).error.code).toBe(
      'MAIL_SETTINGS_PASSWORD_REQUIRED',
    );
    expect(await logText()).toBe(before);
  });
});

describe('POST /api/admin/mail-settings/test', () => {
  it('refuses a new host without a password before opening any connection', async () => {
    await put({
      ...validUpdate,
      expectedVersion: 1,
      password: 'saved-password',
    });
    const captured: MailSettings[] = [];
    const spied = createApiFor({
      key,
      transportFactory: captureTransport(captured),
    });
    const spiedCookie = (await login(spied.api, fixture.admin)).cookie;
    const response = await postTest(
      { ...validTest, host: 'smtp.attacker.test', password: undefined },
      spied.api,
      spiedCookie,
    );
    expect(response.statusCode, response.body).toBe(400);
    expect(adminApiErrorSchema.parse(response.json()).error.code).toBe(
      'MAIL_SETTINGS_PASSWORD_REQUIRED',
    );
    expect(captured).toHaveLength(0);
  });

  it('decrypts and reuses the stored password for the same host and username', async () => {
    const password = 'reuse-this-password-7f2a';
    await put({ ...validUpdate, expectedVersion: 1, password });
    const captured: MailSettings[] = [];
    const spied = createApiFor({
      key,
      transportFactory: captureTransport(captured),
    });
    const spiedCookie = (await login(spied.api, fixture.admin)).cookie;
    const response = await postTest(
      { ...validTest, password: undefined },
      spied.api,
      spiedCookie,
    );
    expect(response.statusCode, response.body).toBe(200);
    expect(adminMailSettingsTestResponseSchema.parse(response.json())).toEqual({
      ok: true,
      result: 'ok',
    });
    expect(captured).toHaveLength(1);
    expect(captured[0]).toMatchObject({
      host: validUpdate.host,
      user: validUpdate.username,
      pass: password,
      from: validUpdate.mailFrom,
    });
  });

  it('turns SMTP authentication failure into ok=false/result=auth and records it', async () => {
    const failure = Object.assign(new Error('535 auth failed'), {
      code: 'EAUTH',
      responseCode: 535,
      response: '535 Authentication failed',
    });
    const failing = createApiFor({
      key,
      transportFactory: () => ({
        send: () => Promise.reject(failure),
        close: () => {},
      }),
    });
    const failureCookie = (await login(failing.api, fixture.admin)).cookie;
    const response = await postTest(
      { ...validTest, password: 'wrong-password' },
      failing.api,
      failureCookie,
    );
    expect(response.statusCode, response.body).toBe(200);
    expect(adminMailSettingsTestResponseSchema.parse(response.json())).toEqual({
      ok: false,
      result: 'auth',
    });
    const read = adminMailSettingsResponseSchema.parse((await get()).json());
    expect(read).toMatchObject({ lastTestOk: false, lastTestResult: 'auth' });
    expect(await logText()).toContain('auth');
    expect(await logText()).not.toContain('wrong-password');
  });

  it('sends a real message to Mailpit when it is configured', async () => {
    const host = process.env.MAILPIT_SMTP_HOST ?? '127.0.0.1';
    const port = Number(process.env.MAILPIT_SMTP_PORT ?? 1025);
    const response = await postTest(
      {
        enabled: true,
        host,
        port,
        secure: false,
        username: null,
        mailFrom: 'mailpit-sender@example.test',
        siteUrl: null,
        to: 'mailpit-recipient@example.test',
      },
      api,
      (await login(api, fixture.otherAdmin)).cookie,
    );
    expect(response.statusCode, response.body).toBe(200);
    expect(
      adminMailSettingsTestResponseSchema.parse(response.json()),
    ).toMatchObject({
      ok: true,
      result: 'ok',
    });
  });

  it('limits each administrator to five test sends per minute', async () => {
    const failing = createApiFor({
      key,
      transportFactory: () => ({
        send: () =>
          Promise.reject(
            Object.assign(new Error('auth'), {
              code: 'EAUTH',
              responseCode: 535,
            }),
          ),
        close: () => {},
      }),
    });
    const limitedCookie = (await login(failing.api, fixture.admin)).cookie;
    for (let index = 0; index < 5; index += 1) {
      const response = await postTest(
        { ...validTest, password: 'x' },
        failing.api,
        limitedCookie,
      );
      expect(response.statusCode, response.body).toBe(200);
    }
    const rejected = await postTest(
      { ...validTest, password: 'x' },
      failing.api,
      limitedCookie,
    );
    expect(rejected.statusCode, rejected.body).toBe(429);
    expect(adminApiErrorSchema.parse(rejected.json()).error.code).toBe(
      'RATE_LIMITED',
    );
  });

  it('rejects unauthenticated and portal identities', async () => {
    const anonymous = await api.inject({
      method: 'POST',
      url: '/api/admin/mail-settings/test',
      payload: validTest,
    });
    expect(anonymous.statusCode).toBe(401);
    const portalCookie = (await login(api, fixture.a)).cookie;
    const portal = await postTest(validTest, api, portalCookie);
    expect(portal.statusCode).toBe(403);
    expect(adminApiErrorSchema.parse(portal.json()).error.code).toBe(
      'FORBIDDEN',
    );
  });
});

describe('production host safety', () => {
  let cached: ReturnType<typeof createApiFor> | undefined;
  const productionApi = () => {
    cached ??= createApiFor({
      key,
      allowPlaintext: false,
      lookupHost: () => Promise.resolve([{ address: '93.184.216.34' }]),
    });
    return cached;
  };

  it.each([
    'localhost',
    '127.0.0.1',
    '10.1.2.3',
    '172.16.0.1',
    '192.168.1.1',
    '100.100.100.200',
    '::ffff:10.0.0.1',
    '0.0.0.0',
    '169.254.1.1',
    '[::1]',
    'fc00::1',
    'fe80::1',
  ])('rejects %s as a mail host', async (host) => {
    const prod = productionApi();
    const prodCookie = (await login(prod.api, fixture.admin)).cookie;
    const response = await put(
      {
        ...validUpdate,
        host,
        username: 'ops@example.test',
        expectedVersion: 1,
        password: 'x',
      },
      prod.api,
      prodCookie,
    );
    expect(response.statusCode, response.body).toBe(400);
    expect(adminApiErrorSchema.parse(response.json()).error.code).toBe(
      'MAIL_SETTINGS_HOST_NOT_ALLOWED',
    );
  });

  it('shows form field names, not environment variable names, in errors', async () => {
    const response = await put({
      ...validUpdate,
      enabled: true,
      host: 'smtp.qq.com',
      username: 'owner@qq.com',
      mailFrom: 'other@qq.com',
      expectedVersion: 1,
      password: 'super-secret',
    });
    expect(response.statusCode, response.body).toBe(400);
    expect(response.body).toContain('QQ 邮箱的发件人邮箱必须与账号相同');
    expect(response.body).not.toMatch(/SMTP_|MAIL_FROM/);
  });

  it('rejects ports outside 25/465/587/2525', async () => {
    const prod = productionApi();
    const prodCookie = (await login(prod.api, fixture.admin)).cookie;
    const response = await put(
      {
        ...validUpdate,
        port: 1234,
        secure: false,
        username: 'ops@example.test',
        expectedVersion: 1,
        password: 'x',
      },
      prod.api,
      prodCookie,
    );
    expect(response.statusCode, response.body).toBe(400);
    expect(adminApiErrorSchema.parse(response.json()).error.code).toBe(
      'VALIDATION_ERROR',
    );
  });

  it('rejects a domain that resolves to a private address, without connecting', async () => {
    const captured: MailSettings[] = [];
    const prod = createApiFor({
      key,
      allowPlaintext: false,
      lookupHost: () => Promise.resolve([{ address: '10.0.0.5' }]),
      transportFactory: captureTransport(captured),
    });
    const prodCookie = (await login(prod.api, fixture.admin)).cookie;
    const response = await postTest(
      {
        ...validTest,
        username: 'ops@example.test',
        password: 'x',
      },
      prod.api,
      prodCookie,
    );
    expect(response.statusCode, response.body).toBe(400);
    expect(adminApiErrorSchema.parse(response.json()).error.code).toBe(
      'MAIL_SETTINGS_HOST_NOT_ALLOWED',
    );
    expect(captured).toHaveLength(0);
  });
});

describe('settings encryption key', () => {
  it('requires a key to save a new password, but allows non-password edits', async () => {
    const missing = await put(
      { ...validUpdate, expectedVersion: 1, password: 'x' },
      keyless.api,
      (await login(keyless.api, fixture.admin)).cookie,
    );
    expect(missing.statusCode, missing.body).toBe(400);
    expect(adminApiErrorSchema.parse(missing.json()).error.code).toBe(
      'SETTINGS_KEY_MISSING',
    );

    await put({
      ...validUpdate,
      expectedVersion: 1,
      password: 'saved-password',
    });
    const edited = await put(
      {
        ...validUpdate,
        siteUrl: 'https://changed.example.test',
        expectedVersion: 2,
      },
      keyless.api,
      (await login(keyless.api, fixture.admin)).cookie,
    );
    expect(edited.statusCode, edited.body).toBe(200);
    const read = adminMailSettingsUpdateResponseSchema.parse(edited.json());
    expect(read).toMatchObject({
      passwordSet: true,
      passwordUsable: false,
      keyConfigured: false,
    });
  });

  it('returns SETTINGS_KEY_MISSING when testing with a stored password and no key', async () => {
    await put({
      ...validUpdate,
      expectedVersion: 1,
      password: 'saved-password',
    });
    const response = await postTest(
      { ...validTest, password: undefined },
      keyless.api,
      (await login(keyless.api, fixture.admin)).cookie,
    );
    expect(response.statusCode, response.body).toBe(400);
    expect(adminApiErrorSchema.parse(response.json()).error.code).toBe(
      'SETTINGS_KEY_MISSING',
    );
  });

  it('returns MAIL_SETTINGS_PASSWORD_UNUSABLE when the stored ciphertext cannot be decrypted', async () => {
    await put({
      ...validUpdate,
      expectedVersion: 1,
      password: 'saved-password',
    });
    const wrongKey = createApiFor({ key: Buffer.alloc(32, 9) });
    const response = await postTest(
      { ...validTest, password: undefined },
      wrongKey.api,
      (await login(wrongKey.api, fixture.admin)).cookie,
    );
    expect(response.statusCode, response.body).toBe(400);
    expect(adminApiErrorSchema.parse(response.json()).error.code).toBe(
      'MAIL_SETTINGS_PASSWORD_UNUSABLE',
    );
  });
});

describe('alert settings mailEnabled', () => {
  it('follows the page setting once managed and the environment before that', async () => {
    const envConfigured = createApiFor({
      key,
      env: {
        ...emptyEnv,
        host: 'smtp.env.test',
        port: 465,
        secure: true,
        username: null,
        mailFrom: 'env@example.test',
      },
    });
    const envCookie = (await login(envConfigured.api, fixture.admin)).cookie;
    const fromEnv = await envConfigured.api.inject({
      url: '/api/admin/alert-settings',
      headers: requestHeaders(envCookie),
    });
    expect(fromEnv.statusCode, fromEnv.body).toBe(200);
    expect(fromEnv.json()).toMatchObject({ mailEnabled: true });

    const saved = await put({
      ...validUpdate,
      expectedVersion: 1,
      password: 'saved-password',
    });
    expect(saved.statusCode, saved.body).toBe(200);
    const managedApiCookie = (await login(envConfigured.api, fixture.admin))
      .cookie;
    const managed = await envConfigured.api.inject({
      url: '/api/admin/alert-settings',
      headers: requestHeaders(managedApiCookie),
    });
    expect(managed.json()).toMatchObject({ mailEnabled: true });

    const disabled = await put({
      ...validUpdate,
      enabled: false,
      expectedVersion: 2,
    });
    expect(disabled.statusCode, disabled.body).toBe(200);
    const afterDisable = await envConfigured.api.inject({
      url: '/api/admin/alert-settings',
      headers: requestHeaders(managedApiCookie),
    });
    expect(afterDisable.json()).toMatchObject({ mailEnabled: false });
  });
});

describe('logging', () => {
  it('never writes the password into requests, responses or captured logs', async () => {
    const lines: string[] = [];
    const logged = createApiFor({
      key,
      loggerInstance: createApiLogger({ write: (line) => lines.push(line) }),
      transportFactory: () => successTransport(),
    });
    const loggedCookie = (await login(logged.api, fixture.admin)).cookie;
    const password = 'never-log-this-password-9a1c';
    const testPassword = 'never-log-test-password-5e2b';
    const saved = await put(
      {
        ...validUpdate,
        expectedVersion: 1,
        password,
      },
      logged.api,
      loggedCookie,
    );
    expect(saved.statusCode, saved.body).toBe(200);
    const tested = await postTest(
      { ...validTest, password: testPassword },
      logged.api,
      loggedCookie,
    );
    expect(tested.statusCode, tested.body).toBe(200);
    const refused = await postTest(
      {
        ...validTest,
        host: 'smtp.attacker.test',
        password: undefined,
      },
      logged.api,
      loggedCookie,
    );
    // 新主机却没密码：被拒绝，也不会连接。
    expect(refused.statusCode).toBe(400);
    const text = lines.join('');
    expect(text).not.toContain(password);
    expect(text).not.toContain(testPassword);
    expect(saved.body).not.toContain(password);
    expect(tested.body).not.toContain(testPassword);
    expect(refused.body).not.toContain(password);
    expect(await logText()).not.toContain(password);
    expect(await logText()).not.toContain(testPassword);
  });
});
