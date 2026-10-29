import { beforeEach, describe, expect, it } from 'vitest';
import { connections, createTenant, pgError } from '../test/support.js';
import {
  AlertMailKeys,
  AlertSettingsInvalidError,
  AlertSettingsVersionConflictError,
  DEFAULT_ALERT_DIGEST_MINUTES,
  MAX_ALERTS_PER_MAIL,
  normalizeAlertRecipients,
  noticeSlot,
  previewDigestTopTenants,
  queueAlertNotices,
  readAlertSettings,
  resolveAlertRecipients,
  saveAlertSettings,
  topUnverifiedTenants,
} from './alert-notify.js';
import { raiseAlert, recoverAlert } from './alerts.js';
import { withAdmin, withSystem, withTenant } from './client.js';
import { raiseEmailFailed } from './outbox.js';
import { ensureCdrPartitions } from './partitions.js';
import { alertSettings } from './schema.js';

const { app, owner } = connections();

// 假时钟：所有写入和 tick 都显式传时间，不依赖真实时间。
const T0 = new Date('2026-10-29T01:00:00.000Z');
const minute = (m: number) => new Date(T0.getTime() + m * 60_000);
const system = <T>(fn: Parameters<typeof withSystem<T>>[1]) =>
  withSystem(app.db, fn);
const tick = (at: Date) => system((tx) => queueAlertNotices(tx, { at }));
/** 同 Worker 的做法：先在加锁之前预算受影响租户，再带着结果入队。 */
const tickWithTopTenants = async (at: Date) => {
  const topTenants = await previewDigestTopTenants(app.db, at);
  return system((tx) => queueAlertNotices(tx, { at, topTenants }));
};
const raise = (
  overrides: Partial<Parameters<typeof raiseAlert>[1]> & { at: Date },
) =>
  system((tx) =>
    raiseAlert(tx, {
      kind: 'auth_timeout',
      subjectKey: 'fs-authorize',
      description: '授权超时放行',
      calls: 1,
      ...overrides,
    }),
  );

interface OutboxRow {
  dedupe_key: string;
  template: string;
  status: string;
  skip_reason: string | null;
  recipients: string[];
  params: {
    alerts: Record<string, unknown>[];
  };
}
const outbox = async () =>
  (
    await owner.pool.query<OutboxRow>(
      `select dedupe_key, template, status, skip_reason, recipients, params from email_outbox
       where template like 'alert\\_%' order by created_at, dedupe_key`,
    )
  ).rows;
const alertRows = async () =>
  (
    await owner.pool.query<{
      id: string;
      kind: string;
      subject_key: string;
      notify: boolean;
      occurrences: number;
      digest_cursor: number;
      notified_start_at: Date | null;
      last_digest_at: Date | null;
      notified_recovered_at: Date | null;
      recovered_at: Date | null;
    }>('select * from system_alerts order by started_at, id')
  ).rows;

async function resetSettings() {
  await owner.pool.query(
    `update alert_settings set recipients = '{}', digest_minutes = ${DEFAULT_ALERT_DIGEST_MINUTES}, version = 1,
       updated_at = now(), updated_by = null`,
  );
}
let adminId = '';
beforeEach(async () => {
  await owner.pool.query('delete from system_alerts');
  await owner.pool.query(
    "update email_outbox set status = 'skipped', skip_reason = 'test cleanup', sent_at = null, locked_until = null where status in ('pending', 'sending', 'failed', 'sent')",
  );
  // 告警模板的行不被 balance_alert_deliveries 引用，可以删，让每个用例只看到自己入队的邮件。
  await owner.pool.query(
    "delete from email_outbox where template like 'alert\\_%'",
  );
  await resetSettings();
  adminId = (
    await owner.pool.query<{ id: string }>(
      "select id from admins where status = 'active' order by created_at limit 1",
    )
  ).rows[0]!.id;
});

describe('alert settings', () => {
  it('starts as the migration default row: no recipients, fifteen minutes', async () => {
    expect(await system(readAlertSettings)).toMatchObject({
      recipients: [],
      digestMinutes: 15,
      version: 1,
    });
    const { rows } = await owner.pool.query('select * from alert_settings');
    expect(rows).toHaveLength(1);
    // 单行：第二行写不进去。
    expect(
      await pgError(
        owner.pool.query('insert into alert_settings (id) values (false)'),
      ),
    ).toMatchObject({ code: '23514' });
    expect(
      await pgError(
        owner.pool.query('insert into alert_settings (id) values (true)'),
      ),
    ).toMatchObject({ code: '23505' });
  });

  it('saves normalized recipients, bumps the version and records who saved', async () => {
    const saved = await withAdmin(app.db, (tx) =>
      saveAlertSettings(tx, {
        recipients: [
          ' Ops@Example.test',
          'ops@example.test',
          'cto@example.test',
        ],
        digestMinutes: 10,
        expectedVersion: 1,
        updatedBy: adminId,
        at: T0,
      }),
    );
    expect(saved.before).toMatchObject({ recipients: [], version: 1 });
    expect(saved.after).toMatchObject({
      recipients: ['ops@example.test', 'cto@example.test'],
      digestMinutes: 10,
      version: 2,
      updatedBy: adminId,
      updatedAt: T0,
    });
    expect(saved.recipientsChanged).toBe(true);
    expect(await system(readAlertSettings)).toEqual(saved.after);
  });

  it('alert settings reject a stale version', async () => {
    const input = {
      recipients: ['ops@example.test'],
      digestMinutes: 10,
      updatedBy: adminId,
    };
    await withAdmin(app.db, (tx) =>
      saveAlertSettings(tx, { ...input, expectedVersion: 1 }),
    );
    const error = await withAdmin(app.db, (tx) =>
      saveAlertSettings(tx, {
        ...input,
        digestMinutes: 30,
        expectedVersion: 1,
      }),
    ).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AlertSettingsVersionConflictError);
    expect(error).toMatchObject({ currentVersion: 2 });
    expect(await system(readAlertSettings)).toMatchObject({
      digestMinutes: 10,
      version: 2,
    });
  });

  it('rejects invalid recipients and intervals without writing', async () => {
    const save = (recipients: string[], digestMinutes: number) =>
      withAdmin(app.db, (tx) =>
        saveAlertSettings(tx, {
          recipients,
          digestMinutes,
          expectedVersion: 1,
          updatedBy: adminId,
        }),
      ).catch((e: unknown) => e);
    expect(await save(['not-an-address'], 15)).toBeInstanceOf(
      AlertSettingsInvalidError,
    );
    expect(await save(['A <a@example.test>'], 15)).toBeInstanceOf(
      AlertSettingsInvalidError,
    );
    expect(await save([], 0)).toBeInstanceOf(AlertSettingsInvalidError);
    expect(await save([], 1441)).toBeInstanceOf(AlertSettingsInvalidError);
    expect(await save([], 1.5)).toBeInstanceOf(AlertSettingsInvalidError);
    const many = Array.from({ length: 21 }, (_, i) => `u${i}@example.test`);
    expect(await save(many, 15)).toBeInstanceOf(AlertSettingsInvalidError);
    expect(
      normalizeAlertRecipients(many.slice(0, 20).map((a) => a.toUpperCase())),
    ).toHaveLength(20);
    expect(await system(readAlertSettings)).toMatchObject({ version: 1 });
    // 数据库自己的底线：间隔和个数的 CHECK。
    expect(
      await pgError(
        owner.pool.query('update alert_settings set digest_minutes = 0'),
      ),
    ).toMatchObject({ code: '23514' });
  });

  it('recovers the recipient:admin alert when the recipients change, not when only the interval does', async () => {
    const open = () =>
      system((tx) =>
        raiseEmailFailed(tx, {
          adminRecipients: true,
          description: '管理员告警邮件的收件人被拒绝',
          at: T0,
        }),
      );
    const state = async () =>
      (
        await owner.pool.query<{ recovered_at: Date | null }>(
          "select recovered_at from system_alerts where subject_key = 'recipient:admin' order by started_at desc",
        )
      ).rows;
    await open();
    // 只改间隔：列表没变，告警不动。
    const intervalOnly = await withAdmin(app.db, (tx) =>
      saveAlertSettings(tx, {
        recipients: [],
        digestMinutes: 20,
        expectedVersion: 1,
        updatedBy: adminId,
        at: minute(1),
      }),
    );
    expect(intervalOnly).toMatchObject({
      recipientsChanged: false,
      recoveredRecipientAlerts: 0,
    });
    expect(await state()).toEqual([{ recovered_at: null }]);
    // 改接收邮箱：同事务恢复。
    const changed = await withAdmin(app.db, (tx) =>
      saveAlertSettings(tx, {
        recipients: ['ops@example.test'],
        digestMinutes: 20,
        expectedVersion: 2,
        updatedBy: adminId,
        at: minute(2),
      }),
    );
    expect(changed).toMatchObject({
      recipientsChanged: true,
      recoveredRecipientAlerts: 1,
    });
    expect(await state()).toEqual([{ recovered_at: minute(2) }]);
  });

  it('reordering the recipients alone does not recover the recipient:admin alert', async () => {
    await withAdmin(app.db, (tx) =>
      saveAlertSettings(tx, {
        recipients: ['a@example.test', 'b@example.test'],
        digestMinutes: 15,
        expectedVersion: 1,
        updatedBy: adminId,
        at: T0,
      }),
    );
    await system((tx) =>
      raiseEmailFailed(tx, {
        adminRecipients: true,
        description: '管理员告警邮件的收件人被拒绝',
        at: minute(1),
      }),
    );
    const reordered = await withAdmin(app.db, (tx) =>
      saveAlertSettings(tx, {
        recipients: ['B@example.test', 'a@example.test'],
        digestMinutes: 15,
        expectedVersion: 2,
        updatedBy: adminId,
        at: minute(2),
      }),
    );
    expect(reordered).toMatchObject({
      recipientsChanged: false,
      recoveredRecipientAlerts: 0,
    });
    const { rows } = await owner.pool.query(
      "select 1 from system_alerts where subject_key = 'recipient:admin' and recovered_at is null",
    );
    expect(rows).toHaveLength(1);
  });

  it('a failed save does not recover the recipient alert (same transaction)', async () => {
    await system((tx) =>
      raiseEmailFailed(tx, {
        adminRecipients: true,
        description: '收件人被拒绝',
        at: T0,
      }),
    );
    await withAdmin(app.db, (tx) =>
      saveAlertSettings(tx, {
        recipients: ['ops@example.test'],
        digestMinutes: 10,
        expectedVersion: 99,
        updatedBy: adminId,
      }),
    ).catch(() => undefined);
    const { rows } = await owner.pool.query(
      "select 1 from system_alerts where subject_key = 'recipient:admin' and recovered_at is null",
    );
    expect(rows).toHaveLength(1);
  });

  it('only staff can read or change the settings', async () => {
    const tenant = await createTenant(app, 'CNY');
    expect(
      await withTenant(app.db, tenant.id, (tx) =>
        tx.select().from(alertSettings),
      ),
    ).toEqual([]);
    expect(
      await withTenant(app.db, tenant.id, (tx) =>
        tx
          .update(alertSettings)
          .set({ digestMinutes: 1 })
          .returning({ id: alertSettings.id }),
      ),
    ).toEqual([]);
    expect(
      (
        await owner.pool.query<{ digest_minutes: number }>(
          'select digest_minutes from alert_settings',
        )
      ).rows,
    ).toEqual([{ digest_minutes: 15 }]);
    expect(
      await pgError(
        withTenant(app.db, tenant.id, (tx) =>
          resolveAlertRecipients(tx, { recipients: [] }),
        ),
      ),
    ).toMatchObject({ code: '42501' });
  });
});

describe('alert recipients', () => {
  it('uses the configured recipients', async () => {
    await withAdmin(app.db, (tx) =>
      saveAlertSettings(tx, {
        recipients: ['ops@example.test'],
        digestMinutes: 10,
        expectedVersion: 1,
        updatedBy: adminId,
      }),
    );
    expect(await system((tx) => resolveAlertRecipients(tx))).toEqual({
      recipients: ['ops@example.test'],
      source: 'settings',
    });
  });

  it('falls back to the login emails of all active admins when no recipient is configured', async () => {
    const all = (
      await owner.pool.query<{ email: string }>(
        `select lower(u.email) as email from admins a join auth."user" u on u.id = a.auth_user_id
         where a.status = 'active' order by 1`,
      )
    ).rows.map((row) => row.email);
    expect(all.length).toBeGreaterThanOrEqual(2);
    const fallback = await system((tx) => resolveAlertRecipients(tx));
    expect(fallback).toEqual({ recipients: all, source: 'admins' });
    // 停用的管理员不在其中。
    const disabled = (
      await owner.pool.query<{ id: string }>(
        `select a.id from admins a join auth."user" u on u.id = a.auth_user_id
         where lower(u.email) = $1`,
        [all[0]],
      )
    ).rows[0]!.id;
    await owner.pool.query(
      "update admins set status = 'disabled' where id = $1",
      [disabled],
    );
    try {
      const reduced = await system((tx) => resolveAlertRecipients(tx));
      expect(reduced.recipients).toEqual(all.slice(1));
    } finally {
      await owner.pool.query(
        "update admins set status = 'active' where id = $1",
        [disabled],
      );
    }
  });
});

describe('alert start notices', () => {
  it('merges the alerts opened in one tick into a single start mail and never repeats it', async () => {
    await raise({ at: T0 });
    await raise({
      kind: 'partition_failed',
      subjectKey: 'partition-maintenance',
      description: '分区维护失败',
      at: minute(0),
    });
    const first = await tick(minute(0));
    expect(first).toMatchObject({ started: 2, digested: 0, recovered: 0 });
    const rows = await outbox();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      template: 'alert_start',
      status: 'pending',
    });
    expect(rows[0]!.params.alerts.map((alert) => alert.kind).sort()).toEqual([
      'auth_timeout',
      'partition_failed',
    ]);
    const claimed = await alertRows();
    for (const alert of claimed)
      expect(alert).toMatchObject({
        notified_start_at: minute(0),
        last_digest_at: minute(0),
        digest_cursor: 1,
      });
    // 重复 tick：什么也不再发。
    expect(await tick(minute(0))).toMatchObject({ started: 0 });
    expect(await outbox()).toHaveLength(1);
    // 开始邮件的键是这一批里最小的告警 id。
    const minId = claimed.map((alert) => alert.id).sort()[0]!;
    expect(rows[0]!.dedupe_key).toBe(AlertMailKeys.start(minId));
  });

  it('does not mail alerts with notify = false', async () => {
    await raise({
      kind: 'email_failed',
      subjectKey: 'smtp',
      description: 'SMTP 认证失败',
      at: T0,
    });
    expect((await alertRows())[0]!.notify).toBe(false);
    expect(await tick(minute(1))).toMatchObject({ started: 0 });
    expect(await outbox()).toEqual([]);
  });

  it('an alert that recovers before its start mail is sent gets no mails at all', async () => {
    await raise({ at: T0 });
    await system((tx) =>
      recoverAlert(tx, {
        kind: 'auth_timeout',
        subjectKey: 'fs-authorize',
        at: minute(1),
      }),
    );
    expect(await tick(minute(2))).toMatchObject({
      started: 0,
      digested: 0,
      recovered: 0,
    });
    expect(await tick(minute(40))).toMatchObject({ recovered: 0 });
    expect(await outbox()).toEqual([]);
    expect((await alertRows())[0]).toMatchObject({
      notified_start_at: null,
      notified_recovered_at: null,
    });
  });

  it('a new occurrence of a recovered alert is a new alert with its own start mail', async () => {
    await raise({ at: T0 });
    await tick(minute(0));
    await system((tx) =>
      recoverAlert(tx, {
        kind: 'auth_timeout',
        subjectKey: 'fs-authorize',
        at: minute(5),
      }),
    );
    await tick(minute(5));
    await raise({ at: minute(30) });
    await tick(minute(30));
    expect((await outbox()).map((row) => row.template)).toEqual([
      'alert_start',
      'alert_recovered',
      'alert_start',
    ]);
  });

  it('splits more than 200 alerts into several mails with their own keys', async () => {
    const many = MAX_ALERTS_PER_MAIL + 5;
    for (let i = 0; i < many; i++)
      await raise({
        kind: 'cdr_failed',
        subjectKey: `unassigned:原因${i}`,
        description: `原因 ${i}`,
        at: T0,
      });
    expect(await tick(minute(0))).toMatchObject({ started: many });
    const rows = await outbox();
    expect(
      rows.map((row) => row.params.alerts.length).sort((a, b) => a - b),
    ).toEqual([5, MAX_ALERTS_PER_MAIL]);
    expect(new Set(rows.map((row) => row.dedupe_key)).size).toBe(2);
  });

  it('two ticks at the same instant queue each notice once', async () => {
    await raise({ at: T0 });
    const results = await Promise.all([tick(minute(0)), tick(minute(0))]);
    expect(results.map((result) => result.started).sort()).toEqual([0, 1]);
    expect(await outbox()).toHaveLength(1);
  });
});

describe('alert digests', () => {
  async function started() {
    await withAdmin(app.db, (tx) =>
      saveAlertSettings(tx, {
        recipients: ['ops@example.test'],
        digestMinutes: 10,
        expectedVersion: 1,
        updatedBy: adminId,
      }),
    );
    await raise({ at: T0 });
    await tick(minute(0));
  }

  it('digest added is occurrences minus the cursor, one mail for all due alerts, keyed per alert and cursor', async () => {
    await started();
    await raise({
      kind: 'partition_failed',
      subjectKey: 'partition-maintenance',
      description: '分区维护失败',
      at: minute(0),
    });
    await tick(minute(0));
    for (let m = 1; m <= 12; m++) await raise({ at: minute(m) });
    await raise({
      kind: 'partition_failed',
      subjectKey: 'partition-maintenance',
      description: '分区维护失败',
      at: minute(3),
    });
    // 第 9 分钟还没到 0 + 10。
    expect(await tick(minute(9))).toMatchObject({ digested: 0 });
    expect(await tick(minute(10))).toMatchObject({ digested: 2 });
    const rows = await outbox();
    const digest = rows.filter((row) => row.template === 'alert_digest');
    expect(digest).toHaveLength(1);
    const byKind = (kind: string) =>
      digest[0]!.params.alerts.find((alert) => alert.kind === kind);
    expect(byKind('auth_timeout')).toMatchObject({
      added: 12,
      total: 13,
      durationMinutes: 10,
    });
    expect(byKind('partition_failed')).toMatchObject({ added: 1, total: 2 });
    expect(digest[0]!.recipients).toEqual(['ops@example.test']);
    const ids = (await alertRows()).map((alert) => alert.id).sort();
    expect(digest[0]!.dedupe_key).toBe(AlertMailKeys.digest(ids[0]!, 1));
    // 游标前进，下一封要再过 N 分钟、再有新事件。
    for (const alert of await alertRows())
      expect(alert).toMatchObject({
        digest_cursor: alert.occurrences,
        last_digest_at: minute(10),
      });
  });

  it('does not send a digest without new events', async () => {
    await started();
    // 没有新事件：不论过多久都不发汇总。
    expect(await tick(minute(10))).toMatchObject({ digested: 0 });
    expect(await tick(minute(120))).toMatchObject({ digested: 0 });
    expect((await outbox()).map((row) => row.template)).toEqual([
      'alert_start',
    ]);
    // 一个新事件之后才会发，并且间隔从开始邮件算起已满。
    await raise({ at: minute(121) });
    expect(await tick(minute(121))).toMatchObject({ digested: 1 });
  });

  it('each alert keeps its own cadence', async () => {
    await started();
    await raise({
      kind: 'partition_failed',
      subjectKey: 'partition-maintenance',
      description: '分区维护失败',
      at: minute(6),
    });
    await tick(minute(6)); // 分区告警的开始邮件在第 6 分钟。
    await raise({ at: minute(7) });
    await raise({
      kind: 'partition_failed',
      subjectKey: 'partition-maintenance',
      description: '分区维护失败',
      at: minute(7),
    });
    // 第 10 分钟：授权超时到期（0 + 10），分区告警没到（6 + 10）。
    const first = await tick(minute(10));
    expect(first).toMatchObject({ digested: 1 });
    const digests = (await outbox()).filter(
      (row) => row.template === 'alert_digest',
    );
    expect(digests[0]!.params.alerts.map((alert) => alert.kind)).toEqual([
      'auth_timeout',
    ]);
    expect(await tick(minute(16))).toMatchObject({ digested: 1 });
  });

  it('a recovered alert due for a digest in the same tick gets only the recovery mail', async () => {
    await started();
    await raise({ at: minute(5) });
    await system((tx) =>
      recoverAlert(tx, {
        kind: 'auth_timeout',
        subjectKey: 'fs-authorize',
        at: minute(9),
      }),
    );
    const result = await tick(minute(10));
    expect(result).toMatchObject({ digested: 0, recovered: 1 });
    expect((await outbox()).map((row) => row.template)).toEqual([
      'alert_start',
      'alert_recovered',
    ]);
  });

  it('lists the top tenants by unverified calls received since the alert started and caps them at five', async () => {
    await started();
    await ensureCdrPartitions(owner.db, { moment: T0 });
    const tenants: Awaited<ReturnType<typeof createTenant>>[] = [];
    for (let i = 0; i < 6; i++) tenants.push(await createTenant(app, 'CNY'));
    // 租户 i 有 1000 × (i + 1) 通未验证话单；租户 0 另有一通已验证的和一通告警开始之前入库的未验证话单。
    const insertCdr = (
      tenantId: string,
      unverified: boolean,
      receivedAt: Date,
    ) => {
      return owner.pool.query(
        `insert into cdrs (tenant_id, call_uuid, started_at, ended_at, caller, callee, billing_number, unverified, received_at)
         values ($1, gen_random_uuid(), $2, $2, '1001', '8613800138000', '8613800138000', $3, $4)`,
        [tenantId, minute(1), unverified, receivedAt],
      );
    };
    // 库是各测试文件共用的，别的文件留下的未验证话单入库时间（真实时间）也晚于这条假时间线：租户 i 放 1000 × (i + 1) 条，
    // 远多于别处可能留下的，排名才不受它们影响。
    for (const [i, tenant] of tenants.entries())
      await owner.pool.query(
        `insert into cdrs (tenant_id, call_uuid, started_at, ended_at, caller, callee, billing_number, unverified, received_at)
         select $1::uuid, gen_random_uuid(), $2::timestamptz, $2::timestamptz, '1001', '8613800138000', '8613800138000', true, $3::timestamptz
         from generate_series(1, $4::int)`,
        [tenant.id, minute(1), minute(2), (i + 1) * 1000],
      );
    await insertCdr(tenants[0]!.id, false, minute(3));
    await insertCdr(tenants[0]!.id, true, minute(-30));
    await raise({ at: minute(9) });
    await tickWithTopTenants(minute(10));
    const digest = (await outbox()).find(
      (row) => row.template === 'alert_digest',
    )!;
    expect(digest.params.alerts[0]!.topTenants).toEqual(
      [5, 4, 3, 2, 1].map((i) => tenants[i]!.code),
    );
    expect(
      await system((tx) =>
        topUnverifiedTenants(tx, { since: minute(0), until: minute(10) }, 2),
      ),
    ).toEqual([tenants[5]!.code, tenants[4]!.code]);
    await owner.pool.query('delete from cdrs where tenant_id = any($1)', [
      tenants.map((tenant) => tenant.id),
    ]);
  });

  it('counts only the calls received since the previous mail', async () => {
    await started();
    await ensureCdrPartitions(owner.db, { moment: T0 });
    const [first, second] = [
      await createTenant(app, 'CNY'),
      await createTenant(app, 'CNY'),
    ] as const;
    const load = (tenantId: string, receivedAt: Date, count: number) =>
      owner.pool.query(
        `insert into cdrs (tenant_id, call_uuid, started_at, ended_at, caller, callee, billing_number, unverified, received_at)
         select $1::uuid, gen_random_uuid(), $2::timestamptz, $2::timestamptz, '1001', '8613800138000', '8613800138000', true, $3::timestamptz
         from generate_series(1, $4::int)`,
        [tenantId, minute(1), receivedAt, count],
      );
    try {
      await load(first.id, minute(2), 3000);
      await raise({ at: minute(9) });
      await tickWithTopTenants(minute(10));
      // 第二封汇总只统计第一封（分钟 10）之后入库的：第一个租户的话单在分钟 2，不再出现。
      await load(second.id, minute(12), 2000);
      await raise({ at: minute(19) });
      await tickWithTopTenants(minute(20));
      const digests = (await outbox()).filter(
        (row) => row.template === 'alert_digest',
      );
      expect(digests).toHaveLength(2);
      expect(digests[0]!.params.alerts[0]!.topTenants).toEqual(
        expect.arrayContaining([first.code]),
      );
      const later = digests[1]!.params.alerts[0]!.topTenants as string[];
      expect(later[0]).toBe(second.code);
      expect(later).not.toContain(first.code);
    } finally {
      await owner.pool.query('delete from cdrs where tenant_id = any($1)', [
        [first.id, second.id],
      ]);
    }
  });

  it('the top tenant statistics time out instead of holding the tick, and a digest still goes out without tenants', async () => {
    await started();
    await raise({ at: minute(9) });
    // 另一个会话占着 cdrs 的排他锁：统计查询等不到，语句超时。
    const blocker = await owner.pool.connect();
    try {
      await blocker.query('begin');
      await blocker.query('lock table cdrs in access exclusive mode');
      const startedAt = Date.now();
      await expect(
        previewDigestTopTenants(app.db, minute(10), 300),
      ).rejects.toThrow();
      expect(Date.now() - startedAt).toBeLessThan(3000);
    } finally {
      await blocker.query('rollback');
      blocker.release();
    }
    // 预算不到就不带：汇总照发，租户编码为空。
    expect(await tick(minute(10))).toMatchObject({ digested: 1 });
    const digest = (await outbox()).find(
      (row) => row.template === 'alert_digest',
    )!;
    expect(digest.params.alerts[0]!.topTenants).toEqual([]);
  });

  it('does not slip a minute when the tick starts a few seconds later than the previous one', async () => {
    await withAdmin(app.db, (tx) =>
      saveAlertSettings(tx, {
        recipients: ['ops@example.test'],
        digestMinutes: 15,
        expectedVersion: 1,
        updatedBy: adminId,
      }),
    );
    // 开始邮件的 tick 在 01:00:03.2，下一次 tick 在 01:15:01.8：比 N = 15 分钟差 1.4 秒，仍然到期。
    const startTick = new Date(T0.getTime() + 3200);
    await raise({ at: startTick });
    await tick(startTick);
    expect((await alertRows())[0]).toMatchObject({
      notified_start_at: noticeSlot(startTick),
      last_digest_at: noticeSlot(startTick),
    });
    expect(noticeSlot(startTick)).toEqual(T0);
    await raise({ at: minute(14) });
    const early = new Date(T0.getTime() + 15 * 60_000 + 1800);
    expect(await tick(new Date(minute(14).getTime() + 59_000))).toMatchObject({
      digested: 0,
    });
    expect(await tick(early)).toMatchObject({ digested: 1 });
    expect((await alertRows())[0]).toMatchObject({
      last_digest_at: minute(15),
    });
  });

  it('skips rows another transaction holds and picks them up on the next tick', async () => {
    await raise({ at: T0 });
    const blocker = await owner.pool.connect();
    try {
      await blocker.query('begin');
      await blocker.query('select id from system_alerts for update');
      // 不等锁：立刻返回，什么也没认领。
      const startedAt = Date.now();
      expect(await tick(minute(1))).toMatchObject({ started: 0 });
      expect(Date.now() - startedAt).toBeLessThan(2000);
      expect(await outbox()).toEqual([]);
    } finally {
      await blocker.query('rollback');
      blocker.release();
    }
    expect(await tick(minute(2))).toMatchObject({ started: 1 });
    expect(await outbox()).toHaveLength(1);
  });

  it('names the tenant of a tenant-scoped alert and nothing for global ones, never a description', async () => {
    await started();
    const tenant = await createTenant(app, 'CNY');
    await raise({
      kind: 'statement_mismatch',
      subjectKey: `statement:${tenant.id}:2026-09`,
      tenantId: tenant.id,
      description:
        '账单与流水不一致，通话 0f5a0f5a-0000-4000-8000-000000000001 号码 8613800138000',
      at: minute(0),
    });
    await tick(minute(0));
    await raise({ at: minute(5) });
    await raise({
      kind: 'statement_mismatch',
      subjectKey: `statement:${tenant.id}:2026-09`,
      tenantId: tenant.id,
      description:
        '账单与流水不一致，通话 0f5a0f5a-0000-4000-8000-000000000001 号码 8613800138000',
      at: minute(5),
    });
    await tick(minute(10));
    const digest = (await outbox()).find(
      (row) => row.template === 'alert_digest',
    )!;
    const statement = digest.params.alerts.find(
      (alert) => alert.kind === 'statement_mismatch',
    );
    expect(statement).toMatchObject({ topTenants: [tenant.code] });
    // 汇总的参数里没有自由文本说明（决定 34）。
    expect(JSON.stringify(digest.params)).not.toMatch(
      /8613800138000|0f5a0f5a|description/,
    );
  });
});

describe('alert recovery notices', () => {
  it('sends one recovery mail per tick for the alerts that recovered after a start mail', async () => {
    await raise({ at: T0 });
    await raise({
      kind: 'partition_failed',
      subjectKey: 'partition-maintenance',
      description: '分区维护失败',
      at: T0,
    });
    await tick(minute(0));
    for (const [kind, key] of [
      ['auth_timeout', 'fs-authorize'],
      ['partition_failed', 'partition-maintenance'],
    ] as const)
      await system((tx) =>
        recoverAlert(tx, { kind, subjectKey: key, at: minute(12) }),
      );
    expect(await tick(minute(13))).toMatchObject({ recovered: 2 });
    const recovered = (await outbox()).filter(
      (row) => row.template === 'alert_recovered',
    );
    expect(recovered).toHaveLength(1);
    expect(recovered[0]!.params.alerts).toHaveLength(2);
    expect(recovered[0]!.params.alerts[0]).toMatchObject({
      durationMinutes: 12,
      total: 1,
      affectedCalls: 1,
    });
    expect(await tick(minute(14))).toMatchObject({ recovered: 0 });
    expect(
      (await outbox()).filter((r) => r.template === 'alert_recovered'),
    ).toHaveLength(1);
  });

  it('queues a skipped mail, and still advances the state, when there is nobody to send to', async () => {
    // 没有接收邮箱，也没有 active 管理员。
    const active = (
      await owner.pool.query<{ id: string }>(
        "select id from admins where status = 'active'",
      )
    ).rows.map((row) => row.id);
    await owner.pool.query(
      "update admins set status = 'disabled' where id = any($1)",
      [active],
    );
    try {
      await raise({ at: T0 });
      await tick(minute(0));
      expect(await outbox()).toMatchObject([
        {
          template: 'alert_start',
          status: 'skipped',
          skip_reason: 'no_recipients',
        },
      ]);
      expect((await alertRows())[0]!.notified_start_at).toEqual(minute(0));
      expect(await tick(minute(1))).toMatchObject({ started: 0 });
      expect(await outbox()).toHaveLength(1);
    } finally {
      await owner.pool.query(
        "update admins set status = 'active' where id = any($1)",
        [active],
      );
    }
  });
});
