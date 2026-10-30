import { describe, expect, it } from 'vitest';
import { scratchDatabase } from '../test/scratch.js';
import { readReceivableTotals } from './admin/receivables.js';
import { queueAlertNotices } from './alert-notify.js';
import { countAlertsInWindow, countOpenAlerts } from './alert-list.js';
import { recoverQuietAlerts } from './alerts.js';
import { withAdmin, withSystem } from './client.js';
import { seedDatabase } from './seed.js';
import { SEED_ALERT_PLAN } from './seed-alerts.js';

const scratch = scratchDatabase({ seed: true });

const outboxCount = async () =>
  (
    await scratch.owner.pool.query<{ n: number }>(
      'select count(*)::int as n from email_outbox',
    )
  ).rows[0]!.n;

describe('系统告警与待收款的开发种子（阶段 9 PR 8）', () => {
  it('seeds the five alerts of the design draft in their real form', async () => {
    const { rows } = await scratch.owner.pool.query<{
      id: string;
      kind: string;
      subject_key: string;
      tenant_code: string | null;
      open: boolean;
      affected_calls: number;
    }>(
      `select a.id, a.kind, a.subject_key, t.code as tenant_code,
              a.recovered_at is null as open, a.affected_calls
       from system_alerts a left join tenants t on t.id = a.tenant_id
       order by a.started_at desc`,
    );
    expect(rows).toHaveLength(5);
    expect(rows.map((row) => row.id)).toEqual(
      SEED_ALERT_PLAN.map((alert) => alert.id),
    );
    expect(rows.map((row) => [row.kind, row.open])).toEqual([
      ['auth_timeout', true],
      ['cdr_failed', false],
      ['email_failed', false],
      ['auth_timeout', false],
      ['email_failed', false],
    ]);
    // 设计稿的「话单推送延迟 / 队列积压」没有对应检测（决定 36）：话单处理失败用真实的保存失败形态。
    expect(rows[1]?.subject_key).toBe('cdr-save');
    expect(rows[0]?.subject_key).toBe('fs-authorize');
    expect(rows[2]?.subject_key).toMatch(/^recipient:[0-9a-f-]{36}$/);
    expect(rows[2]?.tenant_code).toBe('GZT007');
    expect(rows[3]?.affected_calls).toBe(23);
  });

  it('counts two alerts in 24 hours and one open, like the draft overview', async () => {
    const counts = await withSystem(scratch.app.db, async (tx) => ({
      last24h: await countAlertsInWindow(tx, { window: '24h' }),
      last30d: await countAlertsInWindow(tx, { window: '30d' }),
      open: await countOpenAlerts(tx),
    }));
    expect(counts).toEqual({ last24h: 2, last30d: 5, open: 1 });
  });

  it('marks every seeded alert as history: no notify, start and recovery already notified', async () => {
    const { rows } = await scratch.owner.pool.query<{
      notify: boolean;
      start_marked: boolean;
      recovery_marked: boolean;
    }>(
      `select notify, notified_start_at = started_at as start_marked,
              notified_recovered_at is not distinct from recovered_at as recovery_marked
       from system_alerts`,
    );
    expect(rows).toHaveLength(5);
    for (const row of rows)
      expect(row).toEqual({
        notify: false,
        start_marked: true,
        recovery_marked: true,
      });
  });

  it('queues no mail at seed time, at the next notify-tick, or when the open alert recovers', async () => {
    expect(await outboxCount()).toBe(0);
    const now = new Date();
    const later = (minutes: number) =>
      new Date(now.getTime() + minutes * 60_000);
    const first = await withSystem(scratch.app.db, (tx) =>
      queueAlertNotices(tx, { at: later(1) }),
    );
    expect(first).toMatchObject({ started: 0, digested: 0, recovered: 0 });
    // 进行中的 fs-authorize 告警被静默窗口恢复：notify = false，不发恢复邮件。
    const recovered = await withSystem(scratch.app.db, (tx) =>
      recoverQuietAlerts(tx, { quietMinutes: 10, at: later(60) }),
    );
    expect(recovered).toBe(1);
    const second = await withSystem(scratch.app.db, (tx) =>
      queueAlertNotices(tx, { at: later(61) }),
    );
    expect(second).toMatchObject({ started: 0, digested: 0, recovered: 0 });
    expect(await outboxCount()).toBe(0);
  });

  it('seeds the draft receivable totals and stays idempotent', async () => {
    const totals = await withAdmin(scratch.app.db, (tx) =>
      readReceivableTotals(tx, { status: 'pending' }),
    );
    expect(totals.totals).toEqual({ CNY: '6300', USD: '1700' });
    const before = await scratch.owner.pool.query<{ n: number }>(
      'select count(*)::int as n from system_alerts',
    );
    await seedDatabase(scratch.owner.db);
    const after = await scratch.owner.pool.query<{ n: number }>(
      'select count(*)::int as n from system_alerts',
    );
    expect(after.rows[0]?.n).toBe(before.rows[0]?.n);
    expect(await outboxCount()).toBe(0);
  });
});
