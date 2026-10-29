import type {} from '../../../packages/db/test/global-setup.js';
import { randomUUID } from 'node:crypto';
import { Writable } from 'node:stream';
import type { PgBoss } from 'pg-boss';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  inject,
  it,
  vi,
} from 'vitest';
import {
  claimDueEmails,
  connect,
  enqueueEmail,
  mailBackoffSeconds,
  raiseAlert,
  raiseEmailFailed,
  withSystem,
  type EnqueueEmailInput,
} from '@fs-billing/db';
import {
  connections,
  createTenant,
} from '../../../packages/db/test/support.js';
import type { MailSettings } from './config.js';
import {
  createMailTransport,
  dispatchOutbox,
  type MailTransport,
} from './mail.js';
import {
  NOTIFY_CRON,
  NOTIFY_TIMEZONE,
  runNotifyTick,
  startNotifyJobs,
} from './notify.js';
import { runMailRequeue, runMailTest } from './mail-cli.js';
import { NOTIFY_QUEUE, createBoss, installQueue } from './queue.js';
import {
  clearMailpit,
  mailpitMessage,
  mailpitMessages,
  mailpitSettings,
  startFakeSmtp,
  type FakeSmtp,
  type FakeSmtpScript,
} from '../test/mail-support.js';

const { app, owner } = connections();

const T0 = new Date('2026-10-29T01:00:00.000Z');
const after = (base: Date, seconds: number) =>
  new Date(base.getTime() + seconds * 1000);
let now = T0;
const clock = () => now;

beforeEach(async () => {
  now = T0;
  await clearMailpit();
  await owner.pool.query(
    "update email_outbox set status = 'skipped', skip_reason = 'test cleanup', sent_at = null, locked_until = null where status in ('pending', 'sending', 'failed', 'sent')",
  );
  await owner.pool.query('delete from system_alerts');
});

const enqueue = (overrides: Partial<EnqueueEmailInput> = {}) =>
  withSystem(app.db, (tx) =>
    enqueueEmail(tx, {
      dedupeKey: `test:${randomUUID()}`,
      template: 'test',
      params: { sentAt: T0.toISOString() },
      recipients: ['ops@example.test'],
      at: T0,
      ...overrides,
    }),
  );
const row = async (id: string) =>
  (
    await owner.pool.query<{
      status: string;
      attempts: number;
      next_attempt_at: Date;
      last_error: string | null;
      accepted: string[] | null;
      rejected: string[] | null;
      sent_at: Date | null;
    }>('select * from email_outbox where id = $1', [id])
  ).rows[0]!;
const alerts = async (kind = 'email_failed') =>
  (
    await owner.pool.query<{
      subject_key: string;
      tenant_id: string | null;
      notify: boolean;
      occurrences: number;
      description: string;
      recovered_at: Date | null;
    }>(
      'select subject_key, tenant_id, notify, occurrences, description, recovered_at from system_alerts where kind = $1 order by subject_key',
      [kind],
    )
  ).rows;

const settings = (overrides: Partial<MailSettings> = {}) =>
  mailpitSettings(overrides);
/** 用真实 nodemailer 连接 `target` 发一轮；发完关闭连接。 */
async function dispatch(
  transport: MailTransport,
  overrides: Partial<MailSettings> = {},
) {
  try {
    return await dispatchOutbox(app.db, {
      transport,
      settings: settings(overrides),
      now: clock,
    });
  } finally {
    transport.close();
  }
}
const toMailpit = (overrides: Partial<MailSettings> = {}) =>
  dispatch(createMailTransport(settings(overrides)), overrides);
const failing = (error: object): MailTransport => ({
  send: () => Promise.reject(Object.assign(new Error('injected'), error)),
  close: () => undefined,
});

describe('经 Mailpit 发送', () => {
  it('delivers a balance notice through Mailpit and records the delivery', async () => {
    const tenant = await createTenant(app, 'CNY');
    const queued = await enqueue({
      template: 'balance_low',
      tenantId: tenant.id,
      recipients: ['Finance@Example.test', 'cfo@example.test'],
      params: {
        tenantCode: tenant.code,
        tenantName: '华东 <b>示例</b> 公司',
        currency: 'CNY',
        balance: '80.00',
        threshold: '100.00',
        overdraftLimit: '100.00',
        available: '180.00',
      },
    });
    expect(await toMailpit()).toEqual({
      claimed: 1,
      sent: 1,
      retried: 0,
      failed: 0,
      released: 0,
    });
    const [message] = await mailpitMessages();
    expect(message).toMatchObject({
      MessageID: `${queued.id}@fs-billing`,
      Subject: '【余额不足】华东 <b>示例</b> 公司 余额 CNY 80.00',
      From: { Name: 'FS-Billing 计费系统', Address: 'billing@example.test' },
    });
    expect(message!.To.map((to) => to.Address).sort()).toEqual([
      'cfo@example.test',
      'finance@example.test',
    ]);
    const detail = await mailpitMessage(message!.ID);
    expect(detail.Text).toContain(`租户：${tenant.code}`);
    expect(detail.Text).toContain('当前余额：CNY 80.00');
    expect(detail.HTML).toContain('&lt;b&gt;示例&lt;/b&gt;');
    expect(detail.HTML).not.toContain('<b>示例</b>');
    expect(await row(queued.id)).toMatchObject({
      status: 'sent',
      attempts: 1,
      sent_at: T0,
      accepted: ['finance@example.test', 'cfo@example.test'],
      rejected: [],
    });
    const { rows } = await owner.pool.query(
      'select kind, balance::text, recipients, outbox_id from balance_alert_deliveries where tenant_id = $1',
      [tenant.id],
    );
    expect(rows).toEqual([
      {
        kind: 'low_balance',
        balance: '80.00',
        recipients: ['finance@example.test', 'cfo@example.test'],
        outbox_id: queued.id,
      },
    ]);
    // 已 sent 的邮件不会再发。
    expect(await toMailpit()).toMatchObject({ claimed: 0 });
    expect(await mailpitMessages()).toHaveLength(1);
  });

  it('sends every template with a site link and the right subject', async () => {
    const tenant = await createTenant(app, 'USD');
    const at = T0.toISOString();
    const tenantParams = {
      tenantCode: tenant.code,
      tenantName: '海外示例',
      currency: 'USD',
      balance: '-100.36',
      overdraftLimit: '100.00',
    };
    await Promise.all([
      enqueue({ template: 'test' }),
      enqueue({
        template: 'balance_suspended',
        tenantId: tenant.id,
        params: tenantParams,
      }),
      enqueue({
        template: 'alert_start',
        params: {
          alerts: [
            {
              kind: 'auth_timeout',
              description: '授权超时放行',
              startedAt: at,
            },
          ],
        },
      }),
      enqueue({
        template: 'alert_digest',
        params: {
          alerts: [
            {
              kind: 'auth_timeout',

              startedAt: at,
              durationMinutes: 10,
              added: 9,
              total: 10,
              topTenants: [tenant.code],
            },
          ],
        },
      }),
      enqueue({
        template: 'alert_recovered',
        params: {
          alerts: [
            {
              kind: 'auth_timeout',
              startedAt: at,
              recoveredAt: after(T0, 1800).toISOString(),
              durationMinutes: 30,
              total: 20,
              affectedCalls: 20,
            },
          ],
        },
      }),
    ]);
    const summary = await toMailpit({ siteUrl: 'http://127.0.0.1:5173' });
    expect(summary).toMatchObject({ claimed: 5, sent: 5, failed: 0 });
    const messages = await mailpitMessages();
    expect(messages.map((message) => message.Subject).sort()).toEqual(
      [
        '【测试邮件】FS-Billing',
        '【已停机】海外示例 可用额度已用完',
        '【故障告警】1 项告警开始：授权超时',
        '【故障汇总】1 项告警仍在进行',
        '【故障恢复】授权超时 已恢复，持续 30 分钟',
      ].sort(),
    );
    const start = messages.find((m) => m.Subject.startsWith('【故障告警】'))!;
    expect((await mailpitMessage(start.ID)).Text).toContain(
      'http://127.0.0.1:5173/admin/system-alerts',
    );
    // 停机通知也记入 deliveries。
    const { rows } = await owner.pool.query(
      'select kind from balance_alert_deliveries where tenant_id = $1',
      [tenant.id],
    );
    expect(rows).toEqual([{ kind: 'suspended' }]);
  });

  it('two dispatchers send each message once', async () => {
    for (let i = 0; i < 8; i++) await enqueue();
    const [a, b] = await Promise.all([toMailpit(), toMailpit()]);
    expect(a.claimed + b.claimed).toBe(8);
    expect(a.sent + b.sent).toBe(8);
    const messages = await mailpitMessages();
    expect(messages).toHaveLength(8);
    expect(new Set(messages.map((message) => message.MessageID)).size).toBe(8);
  });

  it('sends at most MAIL_RATE_PER_MINUTE per tick, oldest first', async () => {
    const queued = [];
    for (let i = 0; i < 5; i++)
      queued.push(await enqueue({ at: after(T0, i) }));
    now = after(T0, 10);
    for (const expected of [2, 2, 1]) {
      expect(await toMailpit({ ratePerTick: 2 })).toMatchObject({
        claimed: expected,
        sent: expected,
      });
    }
    expect(await mailpitMessages()).toHaveLength(5);
    const states = await Promise.all(queued.map((q) => row(q.id)));
    expect(states.every((state) => state.status === 'sent')).toBe(true);
    expect(await toMailpit()).toMatchObject({ claimed: 0 });
  });

  it("a crashed dispatcher's message is resent after the lease with the same Message-ID", async () => {
    const queued = await enqueue();
    // 分发器认领后在发送前崩溃：没有结果写回，租约 2 分钟。
    await withSystem(app.db, (tx) =>
      claimDueEmails(tx, { limit: 10, now: T0 }),
    );
    now = after(T0, 60);
    expect(await toMailpit()).toMatchObject({ claimed: 0 });
    expect(await mailpitMessages()).toHaveLength(0);
    now = after(T0, 121);
    expect(await toMailpit()).toMatchObject({ claimed: 1, sent: 1 });
    expect(await row(queued.id)).toMatchObject({ status: 'sent', attempts: 2 });
    expect((await mailpitMessages()).map((m) => m.MessageID)).toEqual([
      `${queued.id}@fs-billing`,
    ]);
  });

  it('gives up on a mail whose lease expired after the last allowed attempt, without sending', async () => {
    const queued = await enqueue();
    await owner.pool.query(
      "update email_outbox set status = 'sending', attempts = 6, locked_until = $2 where id = $1",
      [queued.id, T0],
    );
    now = after(T0, 10);
    expect(await toMailpit({ maxAttempts: 6 })).toMatchObject({
      claimed: 1,
      sent: 0,
      failed: 1,
    });
    expect(await mailpitMessages()).toHaveLength(0);
    expect(await row(queued.id)).toMatchObject({
      status: 'failed',
      attempts: 7,
    });
    expect(await alerts()).toMatchObject([
      { subject_key: 'smtp', notify: false },
    ]);
  });

  it('fails a mail whose snapshot no longer renders, and says so in an alert', async () => {
    const queued = await enqueue({
      template: 'balance_low',
      params: { oops: 1 },
    });
    expect(await toMailpit()).toMatchObject({ claimed: 1, sent: 0, failed: 1 });
    expect(await mailpitMessages()).toHaveLength(0);
    expect(await row(queued.id)).toMatchObject({
      status: 'failed',
      last_error: '模板渲染失败：快照不符合模板要求',
    });
    expect((await alerts())[0]!.description).toContain('无法渲染');
  });
});

describe('重试、告警与恢复', () => {
  it('retries with backoff and opens an email_failed alert only when it gives up', async () => {
    const queued = await enqueue();
    const down = () =>
      failing({ code: 'ESOCKET', originalCode: 'ECONNREFUSED' });
    for (let attempt = 1; attempt <= 6; attempt++) {
      const summary = await dispatch(down());
      const state = await row(queued.id);
      expect(state.attempts).toBe(attempt);
      if (attempt < 6) {
        expect(summary).toMatchObject({ claimed: 1, retried: 1, failed: 0 });
        expect(state).toMatchObject({ status: 'pending' });
        expect(state.next_attempt_at).toEqual(
          after(now, mailBackoffSeconds(attempt)),
        );
        // 重试期间不开告警（连接偶发失败不算故障）。
        expect(await alerts()).toEqual([]);
        // 退避没到不会再试。
        now = after(now, mailBackoffSeconds(attempt) - 1);
        expect(await dispatch(down())).toMatchObject({ claimed: 0 });
        now = state.next_attempt_at;
      } else {
        expect(summary).toMatchObject({ claimed: 1, retried: 0, failed: 1 });
        expect(state).toMatchObject({ status: 'failed' });
      }
    }
    // 1 + 5 + 15 + 60 + 180 分钟之后放弃。
    expect(now).toEqual(after(T0, 261 * 60));
    const [alert] = await alerts();
    expect(alert).toMatchObject({
      subject_key: 'smtp',
      tenant_id: null,
      notify: false,
      occurrences: 1,
    });
    expect(alert!.description).toContain('已放弃');
    expect(alert!.description).toContain('ESOCKET');
    expect(alert!.description).not.toContain('ops@example.test');
    // failed 不会自动再试。
    now = after(now, 86400);
    expect(await dispatch(down())).toMatchObject({ claimed: 0 });
  });

  it('recovers the smtp alert on the next success and a requeued mail goes out', async () => {
    const queued = await enqueue({ template: 'test' });
    await owner.pool.query(
      "update email_outbox set status = 'failed', attempts = 6, last_error = 'old' where id = $1",
      [queued.id],
    );
    await withSystem(app.db, (tx) =>
      raiseEmailFailed(tx, { description: '连接失败，已放弃', at: T0 }),
    );
    now = after(T0, 3600);
    expect((await alerts())[0]!.recovered_at).toBeNull();
    expect(await toMailpit()).toMatchObject({ claimed: 0 });
    const code = await runMailRequeue(
      ['--id', queued.id],
      { APP_DATABASE_URL: inject('appUrl') },
      { stdout: sink().stream, stderr: sink().stream },
      clock,
    );
    expect(code).toBe(0);
    expect(await row(queued.id)).toMatchObject({
      status: 'pending',
      attempts: 0,
    });
    expect(await toMailpit()).toMatchObject({ claimed: 1, sent: 1 });
    expect(await row(queued.id)).toMatchObject({ status: 'sent', attempts: 1 });
    expect((await alerts())[0]!.recovered_at).toEqual(now);
  });

  it('an authentication failure opens the alert at once, keeps retrying and never prints the credentials', async () => {
    const queued = await enqueue();
    const bad = () =>
      failing({
        code: 'EAUTH',
        responseCode: 535,
        response: '535 5.7.8 Login fail',
      });
    expect(await dispatch(bad())).toMatchObject({ retried: 1, failed: 0 });
    expect(await row(queued.id)).toMatchObject({
      status: 'pending',
      attempts: 1,
    });
    let [alert] = await alerts();
    expect(alert).toMatchObject({
      subject_key: 'smtp',
      notify: false,
      occurrences: 1,
    });
    expect(alert!.description).toContain(
      'SMTP 认证失败，请检查 SMTP_USER / SMTP_PASS',
    );
    // 管理员改好环境变量之前每次尝试都累加；改好后下一封成功即恢复。
    now = after(T0, 60);
    expect(await dispatch(bad())).toMatchObject({ retried: 1 });
    [alert] = await alerts();
    expect(alert).toMatchObject({ occurrences: 2, recovered_at: null });
    now = after(now, 300);
    expect(await toMailpit()).toMatchObject({ sent: 1 });
    [alert] = await alerts();
    expect(alert!.recovered_at).toEqual(now);
    expect(await row(queued.id)).toMatchObject({ status: 'sent', attempts: 3 });
  });

  it('a rejected login from a real SMTP server is classified and alerted without leaking the password', async () => {
    const server = await startFakeSmtp({ auth: '535 5.7.8 Login fail' });
    try {
      await enqueue();
      const overrides = {
        port: server.port,
        user: 'sender',
        pass: 'placeholder-auth-code',
      };
      await dispatch(createMailTransport(settings(overrides)), overrides);
      const [alert] = await alerts();
      expect(alert!.description).toContain('SMTP_USER / SMTP_PASS');
      expect(alert!.description).toContain('535');
      expect(JSON.stringify(alert)).not.toContain('placeholder-auth-code');
      expect(server.messages()).toBe(0);
    } finally {
      await server.close();
    }
  });
});

describe('收件人被拒', () => {
  let server: FakeSmtp | undefined;
  afterEach(async () => {
    await server?.close();
    server = undefined;
  });
  const viaFake = async (script: FakeSmtpScript) => {
    server = await startFakeSmtp(script);
    return dispatch(createMailTransport(settings({ port: server.port })), {
      port: server.port,
    });
  };
  const balanceParams = (tenantCode: string) => ({
    tenantCode,
    tenantName: '示例',
    currency: 'CNY',
    balance: '50.00',
    threshold: '100.00',
    overdraftLimit: '100.00',
    available: '150.00',
  });

  it('fails a tenant mail whose recipients are all rejected and alerts that tenant, not smtp', async () => {
    const tenant = await createTenant(app, 'CNY');
    const queued = await enqueue({
      template: 'balance_low',
      tenantId: tenant.id,
      params: balanceParams(tenant.code),
      recipients: ['gone@example.test'],
    });
    const summary = await viaFake({
      rcpt: () => '550 5.1.1 <gone@example.test> no such user',
    });
    expect(summary).toMatchObject({ claimed: 1, sent: 0, failed: 1 });
    expect(await row(queued.id)).toMatchObject({
      status: 'failed',
      attempts: 1,
    });
    expect((await row(queued.id)).last_error).not.toContain(
      'gone@example.test',
    );
    const found = await alerts();
    expect(found).toMatchObject([
      {
        subject_key: `recipient:${tenant.id}`,
        tenant_id: tenant.id,
        notify: false,
      },
    ]);
    expect(found[0]!.description).not.toContain('gone@example.test');
    const { rows } = await owner.pool.query(
      'select 1 from balance_alert_deliveries where tenant_id = $1',
      [tenant.id],
    );
    expect(rows).toEqual([]);
  });

  it('fails a single-recipient tenant mail refused after DATA as a recipient problem and records that recipient', async () => {
    const tenant = await createTenant(app, 'CNY');
    const queued = await enqueue({
      template: 'balance_low',
      tenantId: tenant.id,
      params: balanceParams(tenant.code),
      recipients: ['gone@example.test'],
    });
    const summary = await viaFake({
      data: '550 The recipient may contain a non-existent account, please check the recipient address.',
    });
    expect(summary).toMatchObject({ claimed: 1, sent: 0, failed: 1 });
    expect(await row(queued.id)).toMatchObject({
      status: 'failed',
      rejected: ['gone@example.test'],
    });
    expect(await alerts()).toMatchObject([
      { subject_key: `recipient:${tenant.id}`, tenant_id: tenant.id },
    ]);
  });

  it('delivers to the accepted recipients, records the rejected ones and alerts the tenant', async () => {
    const tenant = await createTenant(app, 'CNY');
    const queued = await enqueue({
      template: 'balance_low',
      tenantId: tenant.id,
      params: balanceParams(tenant.code),
      recipients: ['ok@example.test', 'gone@example.test'],
    });
    const summary = await viaFake({
      rcpt: (address) =>
        address === 'gone@example.test' ? '550 5.1.1 no such user' : '250 ok',
    });
    expect(summary).toMatchObject({ sent: 1, failed: 0 });
    expect(await row(queued.id)).toMatchObject({
      status: 'sent',
      accepted: ['ok@example.test'],
      rejected: ['gone@example.test'],
    });
    expect(await alerts()).toMatchObject([
      { subject_key: `recipient:${tenant.id}`, tenant_id: tenant.id },
    ]);
    const { rows } = await owner.pool.query(
      'select recipients from balance_alert_deliveries where outbox_id = $1',
      [queued.id],
    );
    // 记录的是 SMTP 实际接收的地址。
    expect(rows).toEqual([{ recipients: ['ok@example.test'] }]);
  });

  it('a rejected administrator mail has no tenant: recipient:admin, not smtp', async () => {
    const queued = await enqueue({ recipients: ['gone@example.test'] });
    await viaFake({ rcpt: () => '550 5.1.1 no such user' });
    expect(await alerts()).toMatchObject([
      { subject_key: 'recipient:admin', tenant_id: null, notify: false },
    ]);
    // 被拒的地址记在 rejected 列（nodemailer 抛的 EENVELOPE 上带着）。
    expect((await row(queued.id)).rejected).toEqual(['gone@example.test']);
  });

  it('a partly rejected administrator mail is sent, alerts recipient:admin and survives later successes', async () => {
    const partial = await enqueue({
      recipients: ['ok@example.test', 'gone@example.test'],
    });
    const summary = await viaFake({
      rcpt: (address) =>
        address === 'gone@example.test' ? '550 5.1.1 no such user' : '250 ok',
    });
    expect(summary).toMatchObject({ sent: 1, failed: 0 });
    expect(await row(partial.id)).toMatchObject({
      status: 'sent',
      rejected: ['gone@example.test'],
    });
    expect(await alerts()).toMatchObject([{ subject_key: 'recipient:admin' }]);
    // 下一封成功的邮件恢复 smtp 告警，但不会清掉 recipient:admin。
    now = after(T0, 60);
    await enqueue({ at: now });
    await toMailpit();
    const [alert] = await alerts();
    expect(alert).toMatchObject({
      subject_key: 'recipient:admin',
      recovered_at: null,
    });
    // 7 天后由 tick 恢复。
    now = after(T0, 7 * 86400);
    await runNotifyTick(app.db, {
      mail: undefined,
      quietMinutes: 10,
      now: clock,
    });
    expect((await alerts())[0]!.recovered_at).toEqual(now);
  });

  it('retries a recipient the server only deferred', async () => {
    const queued = await enqueue();
    const summary = await viaFake({ rcpt: () => '450 4.2.0 mailbox busy' });
    expect(summary).toMatchObject({ retried: 1, failed: 0 });
    expect(await row(queued.id)).toMatchObject({ status: 'pending' });
    expect(await alerts()).toEqual([]);
  });

  it('a message-level 5xx from a real server fails the mail and opens a smtp alert', async () => {
    // 分类表在 mail.test.ts；这里确认分类结果真的驱动了发件箱状态。
    const queued = await enqueue();
    const summary = await viaFake({ data: '554 5.7.1 spam suspected' });
    expect(summary).toMatchObject({ failed: 1 });
    expect(await row(queued.id)).toMatchObject({ status: 'failed' });
    expect(await alerts()).toMatchObject([{ subject_key: 'smtp' }]);
  });
});

describe('租约与停止', () => {
  const okResult = (to: readonly string[]) => ({
    accepted: to,
    rejected: [],
    response: '250 ok',
  });

  it('stops sending before the lease runs out and releases the rest without counting the attempt', async () => {
    const queued = [];
    for (let i = 0; i < 5; i++)
      queued.push(await enqueue({ at: after(T0, i) }));
    const viaSlow: string[] = [];
    // 每封要 60 秒（假时钟）；租约 120 秒、预算 3 × 5 秒：第三封开始前 120 + 15 ≥ 120，停。
    const slow: MailTransport = {
      send: (message) => {
        viaSlow.push(message.messageId);
        now = after(now, 60);
        return Promise.resolve(okResult(message.to));
      },
      close: () => undefined,
    };
    now = after(T0, 10);
    const summary = await dispatch(slow, { ratePerTick: 5 });
    expect(summary).toEqual({
      claimed: 5,
      sent: 2,
      retried: 0,
      failed: 0,
      released: 3,
    });
    const states = await Promise.all(queued.map((q) => row(q.id)));
    expect(states.map((state) => [state.status, state.attempts])).toEqual([
      ['sent', 1],
      ['sent', 1],
      ['pending', 0],
      ['pending', 0],
      ['pending', 0],
    ]);
    // 下一轮把释放的三封发完，Mailpit 里恰好这三封：没有重复发送。
    expect(await toMailpit()).toMatchObject({ claimed: 3, sent: 3 });
    const delivered = (await mailpitMessages()).map((m) => m.MessageID);
    expect(delivered.sort()).toEqual(
      queued
        .slice(2)
        .map((q) => `${q.id}@fs-billing`)
        .sort(),
    );
    expect(viaSlow).toEqual(
      queued.slice(0, 2).map((q) => `<${q.id}@fs-billing>`),
    );
  });

  it('the lease grows with SMTP_TIMEOUT_MS so one slow send still fits', async () => {
    const queued = await enqueue();
    let seenLease = 0;
    const probe: MailTransport = {
      send: async (message) => {
        const state = await row(queued.id);
        const { rows } = await owner.pool.query<{ lease: number }>(
          'select extract(epoch from locked_until - $2::timestamptz)::int as lease from email_outbox where id = $1',
          [queued.id, T0],
        );
        seenLease = rows[0]!.lease;
        expect(state.status).toBe('sending');
        return okResult(message.to);
      },
      close: () => undefined,
    };
    await dispatch(probe, { timeoutMs: 120_000 });
    // 3 × 120 秒预算 + 60 秒 = 420 秒，小于 notify-tick 任务的 600 秒过期。
    expect(seenLease).toBe(420);
  });

  it('a send that outlives its lease does not overwrite the newer claim that sent the mail', async () => {
    const queued = await enqueue();
    // 旧处理者发送得很慢：期间租约到期，另一个分发器重新认领并真的发给了 Mailpit。
    const slow: MailTransport = {
      send: async (message) => {
        now = after(T0, 121);
        expect(await toMailpit()).toMatchObject({ claimed: 1, sent: 1 });
        return {
          accepted: ['stale-writer@example.test'],
          rejected: [],
          response: `250 ${message.messageId}`,
        };
      },
      close: () => undefined,
    };
    const summary = await dispatch(slow);
    expect(summary).toMatchObject({ claimed: 1, sent: 0 });
    expect(await row(queued.id)).toMatchObject({
      status: 'sent',
      attempts: 2,
      accepted: ['ops@example.test'],
    });
    expect(await mailpitMessages()).toHaveLength(1);
  });

  it('a stale failure does not raise an alert or touch the newer claim', async () => {
    const queued = await enqueue();
    const slow: MailTransport = {
      send: async () => {
        now = after(T0, 121);
        await toMailpit();
        throw Object.assign(new Error('late'), {
          code: 'EAUTH',
          responseCode: 535,
        });
      },
      close: () => undefined,
    };
    const summary = await dispatch(slow);
    expect(summary).toMatchObject({ claimed: 1, sent: 0 });
    expect(await row(queued.id)).toMatchObject({ status: 'sent', attempts: 2 });
    expect(await alerts()).toEqual([]);
  });

  it('stops between mails on the shutdown signal and releases the unsent claims', async () => {
    const queued = [];
    for (let i = 0; i < 3; i++)
      queued.push(await enqueue({ at: after(T0, i) }));
    const controller = new AbortController();
    const stopping: MailTransport = {
      send: (message) => {
        controller.abort();
        return Promise.resolve(okResult(message.to));
      },
      close: () => undefined,
    };
    now = after(T0, 10);
    const summary = await dispatchOutbox(app.db, {
      transport: stopping,
      settings: settings(),
      now: clock,
      signal: controller.signal,
    });
    expect(summary).toEqual({
      claimed: 3,
      sent: 1,
      retried: 0,
      failed: 0,
      released: 2,
    });
    const states = await Promise.all(queued.map((q) => row(q.id)));
    expect(states.map((state) => [state.status, state.attempts])).toEqual([
      ['sent', 1],
      ['pending', 0],
      ['pending', 0],
    ]);
    // 已经收到停止信号时一封也不发。
    expect(
      await dispatchOutbox(app.db, {
        transport: stopping,
        settings: settings(),
        now: clock,
        signal: controller.signal,
      }),
    ).toMatchObject({ claimed: 2, sent: 0, released: 2 });
  });
});

describe('notify-tick', () => {
  it('recovers event alerts after ALERT_QUIET_MINUTES and dispatches the outbox', async () => {
    await withSystem(app.db, async (tx) => {
      await raiseAlert(tx, {
        kind: 'auth_timeout',
        subjectKey: 'fs-authorize',
        description: '授权超时放行',
        calls: 1,
        at: T0,
      });
    });
    // 本用例只测静默窗口和分发：让这条告警不发通知邮件（告警邮件的行为在 notify.db.test.ts），
    // 认领数就只取决于这里入队的那一封。
    await owner.pool.query('update system_alerts set notify = false');
    const queued = await enqueue();
    const tick = (minutes: number, quietMinutes: number, mail = settings()) => {
      now = after(T0, minutes * 60);
      return runNotifyTick(app.db, { mail, quietMinutes, now: clock });
    };
    // 差一分钟不到窗口：不恢复，但邮件照发。
    expect(await tick(9, 10)).toMatchObject({ claimed: 1, sent: 1 });
    expect((await alerts('auth_timeout'))[0]!.recovered_at).toBeNull();
    expect((await row(queued.id)).status).toBe('sent');
    // 窗口 15 分钟时第 10 分钟仍不恢复（配置真的生效），第 15 分钟恢复。
    await tick(10, 15);
    expect((await alerts('auth_timeout'))[0]!.recovered_at).toBeNull();
    await tick(15, 15);
    expect((await alerts('auth_timeout'))[0]!.recovered_at).toEqual(
      after(T0, 15 * 60),
    );
  });

  it('recovers recipient alerts seven days after the last rejection', async () => {
    const tenant = await createTenant(app, 'CNY');
    await withSystem(app.db, (tx) =>
      raiseEmailFailed(tx, {
        tenantId: tenant.id,
        description: '拒收',
        at: T0,
      }),
    );
    const day = 86400;
    now = after(T0, 7 * day - 60);
    await runNotifyTick(app.db, {
      mail: undefined,
      quietMinutes: 10,
      now: clock,
    });
    expect((await alerts())[0]!.recovered_at).toBeNull();
    now = after(T0, 7 * day);
    await runNotifyTick(app.db, {
      mail: undefined,
      quietMinutes: 10,
      now: clock,
    });
    expect((await alerts())[0]!.recovered_at).toEqual(now);
  });

  it('without SMTP settings mail stays queued while alerts still recover', async () => {
    const queued = await enqueue();
    now = after(T0, 3600);
    expect(
      await runNotifyTick(app.db, {
        mail: undefined,
        quietMinutes: 10,
        now: clock,
      }),
    ).toBeUndefined();
    expect((await row(queued.id)).status).toBe('pending');
    expect(await mailpitMessages()).toHaveLength(0);
  });
});

describe('命令行', () => {
  it('mail:test sends one test mail through Mailpit', async () => {
    const out = sink();
    const code = await runMailTest(
      ['--', '--to', 'qa@example.test'],
      {
        SMTP_HOST: settings().host,
        SMTP_PORT: String(settings().port),
        SMTP_SECURE: 'false',
        MAIL_FROM: 'billing@example.test',
      },
      { stdout: out.stream, stderr: sink().stream },
    );
    expect(code).toBe(0);
    expect(out.text()).toContain('发送成功');
    const [message] = await mailpitMessages();
    expect(message).toMatchObject({ Subject: '【测试邮件】FS-Billing' });
    expect(message!.To.map((to) => to.Address)).toEqual(['qa@example.test']);
    expect((await mailpitMessage(message!.ID)).Text).toContain('SMTP 配置可用');
  });

  it('mail:test reports a refused connection as retryable', async () => {
    const err = sink();
    const closed = await startFakeSmtp();
    const { port } = closed;
    await closed.close();
    const code = await runMailTest(
      ['--to', 'qa@example.test'],
      {
        SMTP_HOST: '127.0.0.1',
        SMTP_PORT: String(port),
        SMTP_SECURE: 'false',
        MAIL_FROM: 'billing@example.test',
        SMTP_TIMEOUT_MS: '2000',
      },
      { stdout: sink().stream, stderr: err.stream },
    );
    expect(code).toBe(1);
    expect(err.text()).toContain('可重试');
  });

  it('mail:requeue puts failed mail back by time and leaves other states alone', async () => {
    const failed = await enqueue({ at: after(T0, 100) });
    const old = await enqueue({ at: T0 });
    const pending = await enqueue({ at: after(T0, 100) });
    await owner.pool.query(
      "update email_outbox set status = 'failed', attempts = 6 where id = any($1)",
      [[failed.id, old.id]],
    );
    const out = sink();
    const code = await runMailRequeue(
      ['--since', '2026-10-29T01:01:00Z'],
      { APP_DATABASE_URL: inject('appUrl') },
      { stdout: out.stream, stderr: sink().stream },
      () => after(T0, 7200),
    );
    expect(code).toBe(0);
    expect(out.text()).toContain('已放回 1 封');
    expect(await row(failed.id)).toMatchObject({
      status: 'pending',
      attempts: 0,
    });
    expect((await row(old.id)).status).toBe('failed');
    expect((await row(pending.id)).status).toBe('pending');
  });
});

describe('定时任务', () => {
  const queueConnection = connect(inject('appUrl'), {
    max: 2,
    connectionTimeoutMillis: 1000,
  });
  const boss: PgBoss = createBoss(queueConnection.db);
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  beforeAll(async () => {
    await installQueue(owner);
    await boss.start();
  });
  afterAll(async () => {
    await boss.unschedule(NOTIFY_QUEUE).catch(() => undefined);
    await boss.stop();
    await queueConnection.pool.end();
  });

  it('registers a one minute Beijing schedule on an exclusive queue and the handler dispatches the outbox', async () => {
    await owner.pool.query('delete from pgboss.job where name = $1', [
      NOTIFY_QUEUE,
    ]);
    await startNotifyJobs(boss, app.db, {
      mail: settings(),
      quietMinutes: 10,
      logger: log,
    });
    expect(NOTIFY_CRON).toBe('* * * * *');
    expect(await boss.getSchedules(NOTIFY_QUEUE)).toMatchObject([
      { cron: NOTIFY_CRON, timezone: NOTIFY_TIMEZONE },
    ]);
    expect(await boss.getQueue(NOTIFY_QUEUE)).toMatchObject({
      policy: 'exclusive',
      retryLimit: 0,
    });
    // 这里用真实时钟：入队时间默认数据库 now()，job 由手工 send 触发（真实 cron 触发由阶段 9 PR 5 证明）。
    const queued = await withSystem(app.db, (tx) =>
      enqueueEmail(tx, {
        dedupeKey: `test:${randomUUID()}`,
        template: 'test',
        params: { sentAt: new Date().toISOString() },
        recipients: ['ops@example.test'],
      }),
    );
    await boss.send(NOTIFY_QUEUE);
    await expect
      .poll(async () => (await row(queued.id)).status, { timeout: 20_000 })
      .toBe('sent');
    expect(await mailpitMessages()).toHaveLength(1);
    expect(log.error).not.toHaveBeenCalled();
  });
});

function sink() {
  let text = '';
  const stream = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      text += chunk.toString('utf8');
      callback();
    },
  });
  return { stream, text: () => text };
}
