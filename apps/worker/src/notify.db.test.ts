import type {} from '../../../packages/db/test/global-setup.js';
import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  enqueueEmail,
  raiseAlert,
  recoverAlert,
  saveAlertSettings,
  withAdmin,
  withSystem,
} from '@fs-billing/db';
import { connections } from '../../../packages/db/test/support.js';
import type { MailSettings } from './config.js';
import { runNotifyTick } from './notify.js';
import {
  clearMailpit,
  mailpitMessage,
  mailpitMessages,
  mailpitSettings,
} from '../test/mail-support.js';

const { app, owner } = connections();

// 假时钟：Worker 的 tick、告警事件、邮件入队与分发都用同一个注入的时间，真实时间不参与。
const T0 = new Date('2026-10-29T01:00:00.000Z');
const minute = (m: number) => new Date(T0.getTime() + m * 60_000);
const SITE = 'http://127.0.0.1:5173';
const OPS = 'ops@example.test';

const settings = (overrides: Partial<MailSettings> = {}) =>
  mailpitSettings({ siteUrl: SITE, ...overrides });
const tickAt = (
  m: number,
  options: { quietMinutes?: number; mail?: MailSettings | undefined } = {},
) =>
  runNotifyTick(app.db, {
    mail: 'mail' in options ? options.mail : settings(),
    quietMinutes: options.quietMinutes ?? 10,
    now: () => minute(m),
  });
const raiseAuthTimeout = (m: number) =>
  withSystem(app.db, (tx) =>
    raiseAlert(tx, {
      kind: 'auth_timeout',
      subjectKey: 'fs-authorize',
      description: '授权超时放行',
      calls: 1,
      at: minute(m),
    }),
  );

let adminId = '';
beforeEach(async () => {
  await clearMailpit();
  await owner.pool.query('delete from system_alerts');
  await owner.pool.query(
    "update email_outbox set status = 'skipped', skip_reason = 'test cleanup', sent_at = null, locked_until = null where status in ('pending', 'sending', 'failed', 'sent')",
  );
  await owner.pool.query(
    "delete from email_outbox where template like 'alert\\_%'",
  );
  await owner.pool.query(
    `update alert_settings set recipients = '{}', digest_minutes = 15, version = 1, updated_by = null`,
  );
  adminId = (
    await owner.pool.query<{ id: string }>(
      "select id from admins where status = 'active' order by created_at limit 1",
    )
  ).rows[0]!.id;
});

/** 验收 4 的设置：接收邮箱 ops、N = 10（默认是 15，验收显式设置）。 */
const configure = () =>
  withAdmin(app.db, (tx) =>
    saveAlertSettings(tx, {
      recipients: [OPS],
      digestMinutes: 10,
      expectedVersion: 1,
      updatedBy: adminId,
      at: T0,
    }),
  );

const outbox = async () =>
  (
    await owner.pool.query<{
      dedupe_key: string;
      template: string;
      status: string;
      recipients: string[];
    }>(
      `select dedupe_key, template, status, recipients from email_outbox
       where template like 'alert\\_%' order by created_at, dedupe_key`,
    )
  ).rows;
const alertState = async () =>
  (
    await owner.pool.query<{
      id: string;
      occurrences: number;
      digest_cursor: number;
      recovered_at: Date | null;
      notified_start_at: Date | null;
    }>(
      "select id, occurrences, digest_cursor, recovered_at, notified_start_at from system_alerts where kind = 'auth_timeout'",
    )
  ).rows[0];
/** Mailpit 里按到达顺序（旧的在前）的邮件。 */
const received = async () => [...(await mailpitMessages())].reverse();

describe('故障告警邮件的 20 分钟场景（验收 4）', () => {
  /**
   * 授权超时持续 20 分钟（分钟 0–19 每分钟一条未验证话单入库），tick 每分钟一次，跑到分钟 30。
   * 返回每个分钟的观察：事件累加之后、tick 之后的 occurrences / digest_cursor 与累计入发件箱、累计到达 Mailpit 的封数。
   */
  async function runScenario(quietMinutes: number) {
    await configure();
    const timeline: {
      minute: number;
      occurrences: number | undefined;
      cursor: number | undefined;
      recovered: boolean;
      queued: number;
      delivered: number;
    }[] = [];
    for (let m = 0; m <= 40; m++) {
      if (m < 20) await raiseAuthTimeout(m);
      await tickAt(m, { quietMinutes });
      const state = await alertState();
      timeline.push({
        minute: m,
        occurrences: state?.occurrences,
        cursor: state?.digest_cursor,
        recovered: state?.recovered_at != null,
        queued: (await outbox()).length,
        delivered: (await mailpitMessages()).length,
      });
    }
    return timeline;
  }

  it('a 20 minute authorization timeout sends one start, two digests and one recovery', async () => {
    const timeline = await runScenario(10);
    const at = (m: number) => timeline[m]!;

    // 设计表格逐行（tick 之后的状态）。
    expect(at(0)).toMatchObject({ occurrences: 1, cursor: 1, delivered: 1 });
    for (let m = 1; m <= 9; m++)
      expect(at(m)).toMatchObject({
        occurrences: m + 1,
        cursor: 1,
        delivered: 1,
      });
    expect(at(10)).toMatchObject({ occurrences: 11, cursor: 11, delivered: 2 });
    for (let m = 11; m <= 19; m++)
      expect(at(m)).toMatchObject({
        occurrences: m + 1,
        cursor: 11,
        delivered: 2,
      });
    expect(at(20)).toMatchObject({ occurrences: 20, cursor: 20, delivered: 3 });
    for (let m = 21; m <= 28; m++)
      expect(at(m)).toMatchObject({
        occurrences: 20,
        cursor: 20,
        recovered: false,
        delivered: 3,
      });
    // 分钟 29：29 − 19 ≥ 10，恢复，并发恢复邮件。
    expect(at(29)).toMatchObject({ recovered: true, delivered: 4 });
    // 之后（即使 20 > 20 不成立）什么也不再发。
    for (let m = 30; m <= 40; m++)
      expect(at(m)).toMatchObject({ recovered: true, delivered: 4 });
    // 发件箱和 Mailpit 里始终一一对应：没有排队未发的邮件。
    for (const row of timeline) expect(row.queued).toBe(row.delivered);

    // 发件箱：4 行，顺序与键。
    const rows = await outbox();
    const alertId = (await alertState())!.id;
    expect(rows.map((row) => [row.template, row.status])).toEqual([
      ['alert_start', 'sent'],
      ['alert_digest', 'sent'],
      ['alert_digest', 'sent'],
      ['alert_recovered', 'sent'],
    ]);
    expect(rows.map((row) => row.dedupe_key)).toEqual([
      `alert_start:${alertId}`,
      `alert_digest:${alertId}:1`,
      `alert_digest:${alertId}:11`,
      `alert_recovered:${alertId}`,
    ]);
    for (const row of rows) expect(row.recipients).toEqual([OPS]);

    // Mailpit：4 封，顺序、收件人、主题与正文要点。
    const messages = await received();
    expect(messages.map((message) => message.Subject)).toEqual([
      '【故障告警】1 项告警开始：授权超时',
      '【故障汇总】1 项告警仍在进行',
      '【故障汇总】1 项告警仍在进行',
      '【故障恢复】授权超时 已恢复，持续 29 分钟',
    ]);
    for (const message of messages)
      expect(message.To.map((to) => to.Address)).toEqual([OPS]);
    const bodies = await Promise.all(
      messages.map(async (message) => (await mailpitMessage(message.ID)).Text),
    );
    expect(bodies[0]).toContain(
      '开始时间：2026-10-29 09:00 北京时间（按话单到达时间记录）',
    );
    expect(bodies[0]).toContain(`${SITE}/admin/system-alerts`);
    expect(bodies[1]).toContain('持续 10 分钟');
    expect(bodies[1]).toContain('距上次通知新增 10 次，累计 11 次');
    expect(bodies[2]).toContain('持续 20 分钟');
    expect(bodies[2]).toContain('距上次通知新增 9 次，累计 20 次');
    expect(bodies[3]).toContain(
      '恢复：2026-10-29 09:29 北京时间（持续 29 分钟）',
    );
    expect(bodies[3]).toContain('累计 20 次，影响 20 通话');
    // 内容边界（决定 34）：没有号码、UUID、自由文本说明。
    for (const body of bodies.slice(1))
      expect(body).not.toMatch(/授权超时放行|[0-9a-f]{8}-[0-9a-f]{4}-/);
    expect(bodies.join('\n')).not.toMatch(/\d{11,}/);
  });

  it('a longer quiet window delays the recovery mail but not the count', async () => {
    const timeline = await runScenario(15);
    // 恢复推迟到分钟 34（19 + 15），邮件仍是 1 + 2 + 1。
    expect(timeline[33]).toMatchObject({ recovered: false, delivered: 3 });
    expect(timeline[34]).toMatchObject({ recovered: true, delivered: 4 });
    expect(timeline[40]).toMatchObject({ delivered: 4 });
    expect((await received()).map((message) => message.Subject)).toEqual([
      '【故障告警】1 项告警开始：授权超时',
      '【故障汇总】1 项告警仍在进行',
      '【故障汇总】1 项告警仍在进行',
      '【故障恢复】授权超时 已恢复，持续 34 分钟',
    ]);
  });

  it('does not send a digest without new events', async () => {
    await configure();
    await raiseAuthTimeout(0);
    await tickAt(0, { quietMinutes: 1000 });
    // 静默窗口很大（不恢复），N = 10：两个小时没有新事件也不发汇总。
    for (const m of [10, 11, 30, 60, 120])
      await tickAt(m, { quietMinutes: 1000 });
    expect((await received()).map((message) => message.Subject)).toEqual([
      '【故障告警】1 项告警开始：授权超时',
    ]);
    // 一个新事件之后，下一个 tick 发汇总（间隔早已满），新增 1。
    await raiseAuthTimeout(121);
    await tickAt(121, { quietMinutes: 1000 });
    const messages = await received();
    expect(messages).toHaveLength(2);
    expect((await mailpitMessage(messages[1]!.ID)).Text).toContain(
      '距上次通知新增 1 次，累计 2 次',
    );
  });

  it('two ticks at the same instant deliver each notice once', async () => {
    await configure();
    await raiseAuthTimeout(0);
    await Promise.all([tickAt(0), tickAt(0)]);
    expect(await outbox()).toHaveLength(1);
    expect(await mailpitMessages()).toHaveLength(1);
  });

  it('without SMTP settings the notices are queued and go out once SMTP is configured', async () => {
    await configure();
    await raiseAuthTimeout(0);
    expect(await tickAt(0, { mail: undefined })).toBeUndefined();
    expect(await outbox()).toMatchObject([
      { template: 'alert_start', status: 'pending' },
    ]);
    expect(await mailpitMessages()).toHaveLength(0);
    await tickAt(1);
    expect(await mailpitMessages()).toHaveLength(1);
    expect(await outbox()).toMatchObject([{ status: 'sent' }]);
  });

  it('mails all active admins when no recipient is configured', async () => {
    await raiseAuthTimeout(0);
    await tickAt(0);
    const [row] = await outbox();
    const admins = (
      await owner.pool.query<{ email: string }>(
        `select lower(u.email) as email from admins a join auth."user" u on u.id = a.auth_user_id
         where a.status = 'active' order by 1`,
      )
    ).rows.map((admin) => admin.email);
    expect(row!.recipients).toEqual(admins);
    const [message] = await mailpitMessages();
    expect(message!.To.map((to) => to.Address).sort()).toEqual(admins);
  });
});

describe('历史告警与开始即恢复', () => {
  it('a backfilled open alert recovers without a recovery mail', async () => {
    // 迁移 0020 回填后的未恢复旧告警：notify = false，开始已标记通知，恢复未通知。
    const legacy = randomUUID();
    await owner.pool.query(
      `insert into system_alerts (id, kind, description, started_at, affected_calls, subject_key,
         last_seen_at, notify, notified_start_at, notified_recovered_at)
       values ($1, 'raw_archive_failed', '原始话单归档 2022-05 失败（export）：x', $2, 3, 'archive:2022-05',
         $2, false, $2, null)`,
      [legacy, minute(-600)],
    );
    // 同一 tick 里一条新的、要发邮件的告警：证明过滤只排除旧告警，没有把一切都挡掉。
    await configure();
    await raiseAuthTimeout(0);
    await tickAt(1);
    expect((await outbox()).map((row) => row.template)).toEqual([
      'alert_start',
    ]);
    // 旧告警被恢复（真实恢复路径），再 tick 两次：不入发件箱，不发邮件。
    await withSystem(app.db, (tx) =>
      recoverAlert(tx, {
        kind: 'raw_archive_failed',
        subjectKey: 'archive:2022-05',
        at: minute(2),
      }),
    );
    await tickAt(3, { quietMinutes: 1000 });
    await tickAt(4, { quietMinutes: 1000 });
    const { rows } = await owner.pool.query<{
      recovered_at: Date | null;
      notified_recovered_at: Date | null;
    }>(
      'select recovered_at, notified_recovered_at from system_alerts where id = $1',
      [legacy],
    );
    expect(rows[0]).toMatchObject({
      recovered_at: minute(2),
      notified_recovered_at: null,
    });
    expect((await outbox()).map((row) => row.template)).toEqual([
      'alert_start',
    ]);
    expect(await mailpitMessages()).toHaveLength(1);
  });

  it('an alert that recovers before its start mail is sent produces no mail at all', async () => {
    await configure();
    await raiseAuthTimeout(0);
    // tick 之前就恢复了（静默窗口 1 分钟，分钟 2 的 tick 先恢复再认领）。
    await tickAt(2, { quietMinutes: 1 });
    await tickAt(3, { quietMinutes: 1 });
    expect(await outbox()).toEqual([]);
    expect(await mailpitMessages()).toHaveLength(0);
    expect(await alertState()).toMatchObject({
      notified_start_at: null,
    });
    expect((await alertState())!.recovered_at).not.toBeNull();
  });
});

describe('notify-tick 的事务', () => {
  it('rolls back recoveries and claims together when queueing fails, yet still dispatches the outbox', async () => {
    // 开着一条等着被静默恢复的旧事件告警，和一条等着发开始邮件的新告警。
    await raiseAuthTimeout(0);
    await withSystem(app.db, (tx) =>
      raiseAlert(tx, {
        kind: 'partition_failed',
        subjectKey: 'partition-maintenance',
        description: '分区维护失败',
        at: minute(14),
      }),
    );
    // 与告警无关、早已在发件箱里的一封邮件（余额提醒之类）。
    const queued = await withSystem(app.db, (tx) =>
      enqueueEmail(tx, {
        dedupeKey: `test:${randomUUID()}`,
        template: 'test',
        params: { sentAt: T0.toISOString() },
        recipients: [OPS],
        at: T0,
      }),
    );
    // 接收邮箱为空时要读管理员邮箱：让这个函数不存在，入队就会失败。
    await owner.pool.query(
      'alter function alert_admin_emails() rename to alert_admin_emails_off',
    );
    try {
      await expect(tickAt(15)).rejects.toThrow();
    } finally {
      await owner.pool.query(
        'alter function alert_admin_emails_off() rename to alert_admin_emails',
      );
    }
    // 第 1 步的恢复（fs-authorize 静默 15 分钟）和第 2 步的认领都随事务回滚了。
    expect(await alertState()).toMatchObject({
      recovered_at: null,
      notified_start_at: null,
    });
    const { rows } = await owner.pool.query(
      'select 1 from system_alerts where notified_start_at is not null',
    );
    expect(rows).toEqual([]);
    expect(await outbox()).toEqual([]);
    // 失败没有拖住发件箱：那封无关的邮件照常发出。
    const { rows: sent } = await owner.pool.query<{ status: string }>(
      'select status from email_outbox where id = $1',
      [queued.id],
    );
    expect(sent[0]!.status).toBe('sent');
    expect(await mailpitMessages()).toHaveLength(1);
    // 下一分钟恢复正常：恢复和认领一起落地。
    await tickAt(16);
    expect(await alertState()).toMatchObject({ notified_start_at: null });
    expect((await alertState())!.recovered_at).not.toBeNull();
    expect((await outbox()).map((row) => row.template)).toEqual([
      'alert_start',
    ]);
  });
});
