import { sql } from 'drizzle-orm';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { adminId, connections, pgError, tenantId } from '../../test/support.js';
import { withAdmin, withTenant } from '../client.js';
import {
  getMailSettings,
  MailSettingsPasswordRequiredError,
  MailSettingsVersionConflictError,
  recordMailSettingsTest,
  updateMailSettings,
  type MailSettingsInput,
} from './mail-settings.js';

const { app, owner } = connections();
const key = Buffer.alloc(32, 3);
let actor: { id: string; name: string };

beforeAll(async () => {
  actor = { id: await adminId(owner), name: '管理员' };
});

beforeEach(async () => {
  await owner.pool.query(
    `update smtp_settings
        set managed = false, enabled = false, host = null, port = null, secure = null,
            username = null, password_ciphertext = null, mail_from = null, site_url = null,
            last_test_at = null, last_test_ok = null, last_test_result = null,
            version = 1, updated_at = now(), updated_by = null`,
  );
});

const base: MailSettingsInput = {
  enabled: true,
  host: 'smtp.example.com',
  port: 465,
  secure: true,
  username: 'ops@example.com',
  mailFrom: 'ops@example.com',
  siteUrl: 'https://billing.example.com',
};

function save(
  expectedVersion = 1,
  overrides: Partial<MailSettingsInput> = {},
  // 传 null 表示不提供密码；传 undefined 会触发这里的默认值。
  password: string | null = 'super-secret-password',
) {
  return updateMailSettings(app.db, {
    actor,
    key,
    expectedVersion,
    input: { ...base, ...overrides, password: password ?? undefined },
  });
}

async function logCount(): Promise<number> {
  const { rows } = await owner.pool.query<{ n: number }>(
    `select count(*)::int as n from operation_logs
      where action in ('mail_settings_update', 'mail_settings_test')`,
  );
  return rows[0]!.n;
}

async function ciphertext(): Promise<string> {
  const { rows } = await owner.pool.query<{ password_ciphertext: string }>(
    'select password_ciphertext from smtp_settings',
  );
  return rows[0]!.password_ciphertext;
}

describe('admin mail settings', () => {
  it('reads and writes settings without exposing the password', async () => {
    expect(await getMailSettings(app.db)).toMatchObject({
      managed: false,
      enabled: false,
      host: null,
      passwordSet: false,
      version: 1,
    });

    const saved = await save(1, {}, 'super-secret-password');
    expect(saved.auditId).toEqual(expect.any(String));
    expect(saved.settings).toMatchObject({
      managed: true,
      enabled: true,
      host: base.host,
      port: 465,
      secure: true,
      username: base.username,
      mailFrom: base.mailFrom,
      siteUrl: base.siteUrl,
      passwordSet: true,
      version: 2,
    });
    expect(await getMailSettings(app.db)).toEqual(saved.settings);

    const stored = await ciphertext();
    expect(stored.startsWith('v1:')).toBe(true);
    expect(stored).not.toContain('super-secret-password');
  });

  it('rejects a stale expectedVersion without writing a log', async () => {
    await save(1);
    const before = await logCount();
    await expect(save(1)).rejects.toBeInstanceOf(
      MailSettingsVersionConflictError,
    );
    expect(await logCount()).toBe(before);
    expect((await getMailSettings(app.db)).version).toBe(2);
  });

  it('does not bump the version or write a log when nothing changed', async () => {
    const first = await save(1);
    const before = await logCount();
    const same = await save(first.settings.version, {}, null);
    expect(same.auditId).toBeNull();
    expect(same.settings.version).toBe(2);
    expect(await logCount()).toBe(before);
  });

  it('rejects changing the host without a new password', async () => {
    await save(1);
    const before = await logCount();
    await expect(
      save(2, { host: 'smtp.attacker.test' }, null),
    ).rejects.toBeInstanceOf(MailSettingsPasswordRequiredError);
    expect(await logCount()).toBe(before);
    expect((await getMailSettings(app.db)).version).toBe(2);
  });

  it('rejects changing the username without a new password', async () => {
    await save(1);
    const before = await logCount();
    await expect(
      save(2, { username: 'other@example.com' }, null),
    ).rejects.toBeInstanceOf(MailSettingsPasswordRequiredError);
    expect(await logCount()).toBe(before);
    expect((await getMailSettings(app.db)).version).toBe(2);
  });

  it('reuses the stored ciphertext when the host and username stay the same', async () => {
    await save(1);
    const before = await ciphertext();
    const updated = await save(
      2,
      { siteUrl: 'https://new.example.com' },
      null,
    );
    expect(updated.settings.version).toBe(3);
    expect(await ciphertext()).toBe(before);
  });

  it('rejects the first save without a password outside loopback', async () => {
    await expect(save(1, {}, null)).rejects.toBeInstanceOf(
      MailSettingsPasswordRequiredError,
    );
  });

  it('allows loopback with an empty username and no password for development', async () => {
    const saved = await save(
      1,
      {
        host: 'localhost',
        port: 1025,
        secure: false,
        username: null,
        mailFrom: 'dev@example.com',
      },
      null,
    );
    expect(saved.settings.passwordSet).toBe(false);
  });

  it('never serializes the plaintext or ciphertext into settings or the audit log', async () => {
    const password = 'unique-secret-9f2a';
    await save(1, {}, password);
    const stored = await ciphertext();
    const settings = await getMailSettings(app.db);
    const json = JSON.stringify(settings);
    expect(json).not.toContain(password);
    expect(json).not.toContain(stored);
    expect(json).not.toContain('passwordCiphertext');

    const { rows } = await owner.pool.query<{ text: string }>(
      `select details::text as text from operation_logs
        where action = 'mail_settings_update'`,
    );
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.text).not.toContain(password);
      expect(row.text).not.toContain(stored);
      expect(row.text).not.toContain('v1:');
    }
  });

  it('enforces the managed completeness and port CHECK constraints', async () => {
    const incomplete = await pgError(
      owner.pool.query(
        `update smtp_settings
            set managed = true, enabled = true, host = null, port = 465,
                secure = true, mail_from = 'ops@example.com'`,
      ),
    );
    expect(incomplete).toMatchObject({
      code: '23514',
      constraint: 'smtp_settings_managed_complete',
    });
    expect(
      (await pgError(owner.pool.query('update smtp_settings set port = 70000')))
        .code,
    ).toBe('23514');
  });

  it('hides the settings from tenant identities through RLS', async () => {
    const abc001 = await tenantId(app, 'ABC001');
    const { rows } = await withTenant(app.db, abc001, (tx) =>
      tx.execute(sql`select count(*)::int as n from smtp_settings`),
    );
    expect(rows).toEqual([{ n: 0 }]);
    const seen = await withAdmin(app.db, (tx) =>
      tx.execute(sql`select count(*)::int as n from smtp_settings`),
    );
    expect(seen.rows).toEqual([{ n: 1 }]);
    const updated = await withTenant(app.db, abc001, (tx) =>
      tx.execute(
        sql`update smtp_settings set site_url = 'https://tenant.test'`,
      ),
    );
    expect(updated.rowCount).toBe(0);
  });

  it('records a test result without bumping the version', async () => {
    const saved = await save(1);
    const before = await logCount();
    const tested = await recordMailSettingsTest(app.db, {
      actor,
      to: 'ops@example.com',
      result: 'ok',
    });
    expect(tested.version).toBe(saved.settings.version);
    const after = await getMailSettings(app.db);
    expect(after.version).toBe(2);
    expect(after.lastTestOk).toBe(true);
    expect(after.lastTestResult).toBe('ok');
    expect(after.lastTestAt).toBeInstanceOf(Date);
    expect(await logCount()).toBe(before + 1);

    const { rows } = await owner.pool.query<{ text: string }>(
      `select details::text as text from operation_logs
        where action = 'mail_settings_test'
        order by created_at desc, id limit 1`,
    );
    expect(rows[0]!.text).toContain('ops@example.com');
    expect(rows[0]!.text).toContain('ok');
  });
});
