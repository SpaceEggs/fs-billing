import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  adminTransaction,
  connections,
  createTenant,
  deferred,
  pgError,
} from '../test/support.js';
import { withSystem, withTenant } from './client.js';
import {
  EmailAlertKeys,
  claimDueEmails,
  completeEmail,
  enqueueEmail,
  failEmail,
  mailBackoffSeconds,
  purgeEmailOutbox,
  raiseEmailFailed,
  recoverRecipientAlert,
  recoverSmtpAlert,
  recoverStaleRecipientAlerts,
  requeueFailedEmails,
  retryEmailLater,
} from './outbox.js';
import { emailOutbox } from './schema.js';

const { app, owner } = connections();

const T0 = new Date('2026-10-29T01:00:00.000Z');
const after = (base: Date, seconds: number) =>
  new Date(base.getTime() + seconds * 1000);
const system = <T>(fn: Parameters<typeof withSystem<T>>[1]) =>
  withSystem(app.db, fn);

// 发件箱是所有测试共用的：每个用例从没有待发邮件开始（已结束的行不影响认领，balance_alert_deliveries 引用的行不能删）。
beforeEach(async () => {
  await owner.pool.query(
    "update email_outbox set status = 'skipped', skip_reason = 'test cleanup', sent_at = null, locked_until = null where status in ('pending', 'sending', 'failed', 'sent')",
  );
  await owner.pool.query('delete from system_alerts');
});

const params = { n: 1 };
const enqueue = (overrides: Partial<Parameters<typeof enqueueEmail>[1]> = {}) =>
  system((tx) =>
    enqueueEmail(tx, {
      dedupeKey: `test:${randomUUID()}`,
      template: 'test',
      params,
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
      locked_until: Date | null;
      last_error: string | null;
      skip_reason: string | null;
      recipients: string[];
      sent_at: Date | null;
      accepted: string[] | null;
      rejected: string[] | null;
    }>('select * from email_outbox where id = $1', [id])
  ).rows[0]!;
const alerts = async () =>
  (
    await owner.pool.query<{
      subject_key: string;
      tenant_id: string | null;
      notify: boolean;
      occurrences: number;
      recovered_at: Date | null;
      description: string;
    }>(
      "select subject_key, tenant_id, notify, occurrences, recovered_at, description from system_alerts where kind = 'email_failed' order by subject_key",
    )
  ).rows;

describe('入队', () => {
  it('queues a pending mail with a normalized recipient snapshot', async () => {
    const queued = await enqueue({
      recipients: [
        ' Ops@Example.Test ',
        'ops@example.test',
        'b@example.test',
        '',
      ],
    });
    expect(queued).toMatchObject({ created: true, status: 'pending' });
    expect(await row(queued.id)).toMatchObject({
      status: 'pending',
      attempts: 0,
      recipients: ['ops@example.test', 'b@example.test'],
      next_attempt_at: T0,
    });
  });

  it('a rerun of the same transaction queues one mail', async () => {
    const dedupeKey = `balance_low:${randomUUID()}:1`;
    const first = await enqueue({ dedupeKey });
    const second = await enqueue({
      dedupeKey,
      recipients: ['other@example.test'],
    });
    expect(second).toEqual({ id: first.id, created: false, status: 'pending' });
    const { rows } = await owner.pool.query(
      'select recipients from email_outbox where dedupe_key = $1',
      [dedupeKey],
    );
    // 第二次入队不改快照。
    expect(rows).toEqual([{ recipients: ['ops@example.test'] }]);
  });

  it('records an empty recipient list as skipped without retrying', async () => {
    const queued = await enqueue({ recipients: [] });
    expect(queued).toMatchObject({ created: true, status: 'skipped' });
    expect(await row(queued.id)).toMatchObject({
      status: 'skipped',
      skip_reason: 'no_recipients',
    });
    const claimed = await system((tx) =>
      claimDueEmails(tx, { limit: 10, now: after(T0, 3600) }),
    );
    expect(claimed.map((email) => email.id)).not.toContain(queued.id);
  });

  it('records an explicit skip reason such as a disabled tenant', async () => {
    const queued = await enqueue({ skipReason: 'tenant_disabled' });
    expect(await row(queued.id)).toMatchObject({
      status: 'skipped',
      skip_reason: 'tenant_disabled',
    });
  });

  it('the table refuses rows that break the state invariants', async () => {
    const insert = (
      status: string,
      recipients: string[] = ['a@example.test'],
      template = 'test',
    ) =>
      owner.pool.query(
        `insert into email_outbox (dedupe_key, template, params, recipients, status)
         values ($1, $2, '{}', $3, $4)`,
        [randomUUID(), template, recipients, status],
      );
    expect(await pgError(insert('skipped'))).toMatchObject({
      code: '23514',
      constraint: 'email_outbox_skip_reason_check',
    });
    expect(await pgError(insert('sent'))).toMatchObject({
      code: '23514',
      constraint: 'email_outbox_sent_at_check',
    });
    expect(await pgError(insert('exploded'))).toMatchObject({ code: '23514' });
    expect(await pgError(insert('pending', []))).toMatchObject({
      constraint: 'email_outbox_recipients_check',
    });
    expect(
      await pgError(insert('pending', ['a@example.test'], 'newsletter')),
    ).toMatchObject({ code: '23514' });
  });
});

describe('认领与结果', () => {
  it('claims only due mail, oldest first, up to the limit, and counts the attempt', async () => {
    const early = await enqueue({ at: T0 });
    const later = await enqueue({ at: after(T0, 30) });
    const future = await enqueue({ at: after(T0, 600) });
    const claimed = await system((tx) =>
      claimDueEmails(tx, { limit: 10, now: after(T0, 60) }),
    );
    expect(claimed.map((email) => email.id)).toEqual([early.id, later.id]);
    expect(claimed.every((email) => email.attempts === 1)).toBe(true);
    expect(await row(early.id)).toMatchObject({
      status: 'sending',
      attempts: 1,
      locked_until: after(T0, 60 + 120),
    });
    expect((await row(future.id)).status).toBe('pending');
    // 限额：两封都到期，只拿最早的一封（前两封的租约还没到期，不会被重新认领）。
    const third = await enqueue({ at: after(T0, 61) });
    const fourth = await enqueue({ at: after(T0, 62) });
    const limited = await system((tx) =>
      claimDueEmails(tx, { limit: 1, now: after(T0, 100) }),
    );
    expect(limited.map((email) => email.id)).toEqual([third.id]);
    expect((await row(fourth.id)).status).toBe('pending');
    expect((await row(future.id)).status).toBe('pending');
  });

  it("a crashed dispatcher's mail is claimed again only after the lease expires", async () => {
    const queued = await enqueue();
    await system((tx) => claimDueEmails(tx, { limit: 10, now: T0 }));
    // 租约 2 分钟：到期前别的分发器拿不到，到期后重新认领，次数继续累加。
    expect(
      await system((tx) =>
        claimDueEmails(tx, { limit: 10, now: after(T0, 119) }),
      ),
    ).toEqual([]);
    const again = await system((tx) =>
      claimDueEmails(tx, { limit: 10, now: after(T0, 121) }),
    );
    expect(again.map((email) => [email.id, email.attempts])).toEqual([
      [queued.id, 2],
    ]);
  });

  it('two dispatchers claim different rows', async () => {
    const [a, b] = await Promise.all([enqueue(), enqueue()]);
    const firstClaimed = deferred();
    const release = deferred();
    const first = adminTransaction(app.db, async (tx) => {
      const claimed = await claimDueEmails(tx, { limit: 1, now: T0 });
      firstClaimed.resolve();
      await release.promise;
      return claimed;
    });
    await firstClaimed.promise;
    // 第一个事务还没提交，第二个跳过它锁住的行。
    const second = await adminTransaction(app.db, (tx) =>
      claimDueEmails(tx, { limit: 1, now: T0 }),
    );
    release.resolve();
    const claimedByFirst = await first;
    expect(claimedByFirst).toHaveLength(1);
    expect(second).toHaveLength(1);
    expect(new Set([claimedByFirst[0]!.id, second[0]!.id])).toEqual(
      new Set([a.id, b.id]),
    );
  });

  it('retries with the backoff schedule and fails when told to', async () => {
    const queued = await enqueue();
    let now = T0;
    const offsets: number[] = [];
    for (let attempt = 1; attempt <= 5; attempt++) {
      const [email] = await system((tx) =>
        claimDueEmails(tx, { limit: 1, now }),
      );
      expect(email!.attempts).toBe(attempt);
      expect(
        await system((tx) =>
          retryEmailLater(tx, email!, { error: 'ECONNECTION', now }),
        ),
      ).toBe(true);
      const state = await row(queued.id);
      expect(state).toMatchObject({
        status: 'pending',
        locked_until: null,
        last_error: 'ECONNECTION',
      });
      offsets.push((state.next_attempt_at.getTime() - now.getTime()) / 60000);
      // 退避没到不会被认领。
      expect(
        await system((tx) =>
          claimDueEmails(tx, {
            limit: 1,
            now: after(now, mailBackoffSeconds(attempt) - 1),
          }),
        ),
      ).toEqual([]);
      now = state.next_attempt_at;
    }
    expect(offsets).toEqual([1, 5, 15, 60, 180]);
    await system((tx) => claimDueEmails(tx, { limit: 1, now }));
    expect(
      await system((tx) =>
        failEmail(tx, queued.id, {
          error: 'gave up',
          rejected: ['x@example.test'],
        }),
      ),
    ).toBe(true);
    expect(await row(queued.id)).toMatchObject({
      status: 'failed',
      attempts: 6,
      last_error: 'gave up',
      rejected: ['x@example.test'],
    });
  });

  it('completing a mail is final: a stale lease cannot overwrite it', async () => {
    const queued = await enqueue();
    const [email] = await system((tx) =>
      claimDueEmails(tx, { limit: 1, now: T0 }),
    );
    const done = await system((tx) =>
      completeEmail(tx, email!, {
        accepted: ['ops@example.test'],
        rejected: [],
        now: after(T0, 5),
      }),
    );
    expect(done).toBe(true);
    expect(await row(queued.id)).toMatchObject({
      status: 'sent',
      sent_at: after(T0, 5),
      accepted: ['ops@example.test'],
      locked_until: null,
    });
    // 第二次完成、失败、重试都落空，不改状态。
    expect(
      await system((tx) =>
        completeEmail(tx, email!, {
          accepted: ['x@example.test'],
          rejected: [],
          now: T0,
        }),
      ),
    ).toBe(false);
    expect(
      await system((tx) => failEmail(tx, queued.id, { error: 'late' })),
    ).toBe(false);
    expect(
      await system((tx) =>
        retryEmailLater(tx, email!, { error: 'late', now: T0 }),
      ),
    ).toBe(false);
    expect((await row(queued.id)).status).toBe('sent');
  });

  it('records a delivery for balance notices exactly once', async () => {
    const tenant = await createTenant(app, 'CNY');
    const queued = await enqueue({
      template: 'balance_low',
      tenantId: tenant.id,
      params: { balance: '80.00' },
    });
    const [email] = await system((tx) =>
      claimDueEmails(tx, { limit: 1, now: T0 }),
    );
    const result = {
      accepted: ['ops@example.test'],
      rejected: [],
      balance: '80.00',
      now: after(T0, 3),
    };
    expect(await system((tx) => completeEmail(tx, email!, result))).toBe(true);
    expect(await system((tx) => completeEmail(tx, email!, result))).toBe(false);
    const { rows } = await owner.pool.query(
      'select kind, balance::text, recipients, sent_at, outbox_id from balance_alert_deliveries where tenant_id = $1',
      [tenant.id],
    );
    expect(rows).toEqual([
      {
        kind: 'low_balance',
        balance: '80.00',
        recipients: ['ops@example.test'],
        sent_at: after(T0, 3),
        outbox_id: queued.id,
      },
    ]);
  });

  it('requeues failed mail with a fresh attempt budget, by id or by time', async () => {
    const a = await enqueue({ at: T0 });
    const b = await enqueue({ at: after(T0, 86400) });
    const c = await enqueue({ at: after(T0, 86400) });
    await owner.pool.query(
      "update email_outbox set status = 'failed', attempts = 6, last_error = 'x' where id = any($1)",
      [[a.id, b.id]],
    );
    const now = after(T0, 2 * 86400);
    expect(
      await system((tx) => requeueFailedEmails(tx, { id: c.id }, now)),
    ).toBe(0);
    expect(
      await system((tx) => requeueFailedEmails(tx, { id: a.id }, now)),
    ).toBe(1);
    expect(await row(a.id)).toMatchObject({
      status: 'pending',
      attempts: 0,
      next_attempt_at: now,
    });
    expect(
      await system((tx) =>
        requeueFailedEmails(tx, { since: after(T0, 3600) }, now),
      ),
    ).toBe(1);
    expect((await row(b.id)).status).toBe('pending');
    // 没有 failed 的行了，再来一次是 0。
    expect(
      await system((tx) => requeueFailedEmails(tx, { since: T0 }, now)),
    ).toBe(0);
  });
});

describe('email_failed 告警', () => {
  it('raises smtp and recipient alerts without sending mail, and recovers smtp on the next success', async () => {
    const tenant = await createTenant(app, 'CNY');
    await system(async (tx) => {
      await raiseEmailFailed(tx, { description: 'SMTP 认证失败', at: T0 });
      await raiseEmailFailed(tx, {
        description: 'SMTP 认证失败',
        at: after(T0, 60),
      });
      await raiseEmailFailed(tx, {
        tenantId: tenant.id,
        description: '收件人被拒',
        at: T0,
      });
    });
    expect(await alerts()).toMatchObject([
      {
        subject_key: EmailAlertKeys.recipient(tenant.id),
        tenant_id: tenant.id,
        notify: false,
        occurrences: 1,
      },
      {
        subject_key: EmailAlertKeys.smtp,
        tenant_id: null,
        notify: false,
        occurrences: 2,
      },
    ]);
    expect(await system((tx) => recoverSmtpAlert(tx, after(T0, 120)))).toBe(1);
    expect(await system((tx) => recoverSmtpAlert(tx, after(T0, 180)))).toBe(0);
    const [recipient, smtp] = await alerts();
    expect(smtp!.recovered_at).toEqual(after(T0, 120));
    expect(recipient!.recovered_at).toBeNull();
  });

  it('recovers a recipient alert after seven days without a new rejection', async () => {
    const tenant = await createTenant(app, 'CNY');
    const other = await createTenant(app, 'CNY');
    await system(async (tx) => {
      await raiseEmailFailed(tx, {
        tenantId: tenant.id,
        description: '拒收',
        at: T0,
      });
      await raiseEmailFailed(tx, {
        tenantId: other.id,
        description: '拒收',
        at: after(T0, 86400),
      });
      await raiseEmailFailed(tx, { description: '连接失败', at: T0 });
    });
    const day = 86400;
    // 差一秒满 7 天不恢复。
    expect(
      await system((tx) =>
        recoverStaleRecipientAlerts(tx, { at: after(T0, 7 * day - 1) }),
      ),
    ).toBe(0);
    // 满 7 天：只恢复最近一次拒收已满 7 天的；smtp 告警不受这个窗口影响。
    expect(
      await system((tx) =>
        recoverStaleRecipientAlerts(tx, { at: after(T0, 7 * day) }),
      ),
    ).toBe(1);
    expect(
      await system((tx) =>
        recoverStaleRecipientAlerts(tx, { at: after(T0, 8 * day) }),
      ),
    ).toBe(1);
    const state = new Map(
      (await alerts()).map((a) => [a.subject_key, a.recovered_at]),
    );
    expect(state.get(EmailAlertKeys.recipient(tenant.id))).not.toBeNull();
    expect(state.get(EmailAlertKeys.recipient(other.id))).not.toBeNull();
    expect(state.get(EmailAlertKeys.smtp)).toBeNull();
  });

  it('a new rejection restarts the seven day window', async () => {
    const tenant = await createTenant(app, 'CNY');
    const day = 86400;
    await system(async (tx) => {
      await raiseEmailFailed(tx, {
        tenantId: tenant.id,
        description: '拒收',
        at: T0,
      });
      await raiseEmailFailed(tx, {
        tenantId: tenant.id,
        description: '又拒收',
        at: after(T0, 5 * day),
      });
    });
    expect(
      await system((tx) =>
        recoverStaleRecipientAlerts(tx, { at: after(T0, 8 * day) }),
      ),
    ).toBe(0);
    expect(
      await system((tx) =>
        recoverStaleRecipientAlerts(tx, { at: after(T0, 12 * day) }),
      ),
    ).toBe(1);
  });

  it('recovers a tenant recipient alert when the tenant mailbox list is changed', async () => {
    const tenant = await createTenant(app, 'CNY');
    await system((tx) =>
      raiseEmailFailed(tx, {
        tenantId: tenant.id,
        description: '拒收',
        at: T0,
      }),
    );
    expect(
      await system((tx) => recoverRecipientAlert(tx, randomUUID(), T0)),
    ).toBe(0);
    expect(
      await system((tx) => recoverRecipientAlert(tx, tenant.id, after(T0, 10))),
    ).toBe(1);
  });
});

describe('权限与清理', () => {
  it('a tenant can neither read nor write the outbox or purge it', async () => {
    const tenant = await createTenant(app, 'CNY');
    const queued = await enqueue({ tenantId: tenant.id });
    const visible = await withTenant(app.db, tenant.id, (tx) =>
      tx.select({ id: emailOutbox.id }).from(emailOutbox),
    );
    expect(visible).toEqual([]);
    expect(
      await pgError(
        withTenant(app.db, tenant.id, (tx) =>
          enqueueEmail(tx, {
            dedupeKey: `tenant:${randomUUID()}`,
            template: 'test',
            params,
            recipients: ['a@example.test'],
          }),
        ),
      ),
    ).toMatchObject({ code: '42501' });
    const updated = await withTenant(app.db, tenant.id, (tx) =>
      tx
        .update(emailOutbox)
        .set({ lastError: 'tampered' })
        .returning({ id: emailOutbox.id }),
    );
    expect(updated).toEqual([]);
    expect(
      await pgError(withTenant(app.db, tenant.id, purgeEmailOutbox)),
    ).toMatchObject({
      code: '42501',
    });
    expect((await row(queued.id)).last_error).toBeNull();
  });

  it('the application role cannot delete outbox rows directly', async () => {
    const queued = await enqueue();
    expect(
      await pgError(
        app.pool.query('delete from email_outbox where id = $1', [queued.id]),
      ),
    ).toMatchObject({ code: '42501' });
  });

  it('purges finished rows older than 180 days but keeps live, recent and delivery-referenced rows', async () => {
    const tenant = await createTenant(app, 'CNY');
    const make = (overrides: Parameters<typeof enqueue>[0] = {}) =>
      enqueue(overrides);
    const [oldSent, oldFailed, oldSkipped, recentSent, oldPending, referenced] =
      await Promise.all([
        make(),
        make(),
        make({ recipients: [] }),
        make(),
        make(),
        make({
          template: 'balance_low',
          tenantId: tenant.id,
          params: { balance: '1.00' },
        }),
      ]);
    await owner.pool.query(
      `update email_outbox set status = 'sent', sent_at = now() - interval '181 days' where id = $1`,
      [oldSent.id],
    );
    await owner.pool.query(
      `update email_outbox set status = 'failed', created_at = now() - interval '181 days' where id = $1`,
      [oldFailed.id],
    );
    await owner.pool.query(
      `update email_outbox set created_at = now() - interval '181 days' where id = any($1)`,
      [[oldSkipped.id, oldPending.id]],
    );
    await owner.pool.query(
      `update email_outbox set status = 'sent', sent_at = now() - interval '179 days' where id = $1`,
      [recentSent.id],
    );
    await owner.pool.query(
      `update email_outbox set status = 'sent', sent_at = now() - interval '200 days' where id = $1`,
      [referenced.id],
    );
    await owner.pool.query(
      `insert into balance_alert_deliveries (tenant_id, kind, balance, recipients, outbox_id)
       values ($1, 'low_balance', 1, '{ops@example.test}', $2)`,
      [tenant.id, referenced.id],
    );
    const removed = await system(purgeEmailOutbox);
    expect(removed).toBeGreaterThanOrEqual(3);
    const remaining = await owner.pool.query<{ id: string }>(
      'select id from email_outbox where id = any($1)',
      [
        [
          oldSent.id,
          oldFailed.id,
          oldSkipped.id,
          recentSent.id,
          oldPending.id,
          referenced.id,
        ],
      ],
    );
    expect(remaining.rows.map((r) => r.id).sort()).toEqual(
      [recentSent.id, oldPending.id, referenced.id].sort(),
    );
  });
});
