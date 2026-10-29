import type {} from '../../../packages/db/test/global-setup.js';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { appendLedgerEntry, createTenant, withAdmin } from '@fs-billing/db';
import { money } from '@fs-billing/rating';
import { adminId, connections } from '../../../packages/db/test/support.js';
import { createMailTransport, dispatchOutbox } from './mail.js';
import {
  clearMailpit,
  mailpitMessage,
  mailpitMessages,
  mailpitSettings,
} from '../test/mail-support.js';

const { app, owner } = connections();

// 余额通知经触发器入发件箱，再由分发器经 Mailpit 真实发出（设计「验收标准对应计划测试」1、2）。
// 入队时间是数据库时钟；分发用固定的假时钟，所以每一步先把这个租户的待发邮件改到假时钟之前。
const T0 = new Date('2026-10-29T01:00:00.000Z');

beforeEach(async () => {
  await clearMailpit();
  await owner.pool.query(
    "update email_outbox set status = 'skipped', skip_reason = 'test cleanup', sent_at = null, locked_until = null where status in ('pending', 'sending', 'failed', 'sent')",
  );
});
afterEach(async () => {
  await clearMailpit();
});

async function tenantWith(options: {
  threshold: string;
  overdraft: string;
  emails: string[];
}) {
  const code = `W${randomUUID().replaceAll('-', '').slice(0, 10).toUpperCase()}`;
  const { tenant } = await createTenant({
    db: app.db,
    actor: { id: await adminId(owner), name: '王敏' },
    creatorEmail: 'creator@example.test',
    request: {
      code,
      name: `示例客户 ${code}`,
      currency: 'CNY',
      contactName: '',
      contactPhone: '',
      remark: '',
      settings: {
        lowBalanceThreshold: options.threshold,
        overdraftLimit: options.overdraft,
        emails: options.emails,
      },
      initialRates: { kind: 'blank' },
    },
  });
  return { id: tenant.id, code, name: `示例客户 ${code}` };
}

let sequence = 0;
async function move(tenantId: string, amount: string) {
  const key = `worker-balance:${++sequence}:${randomUUID()}`;
  await withAdmin(app.db, async (tx) =>
    amount.startsWith('-')
      ? appendLedgerEntry(
          tx,
          { id: tenantId, currency: 'CNY' },
          {
            kind: 'call_charge',
            amount: money('CNY', amount),
            occurredAt: T0,
            note: key,
            idempotencyKey: key,
          },
        )
      : appendLedgerEntry(
          tx,
          { id: tenantId, currency: 'CNY' },
          {
            kind: 'credit_recharge',
            amount: money('CNY', amount),
            adminId: await adminId(owner),
            note: key,
            idempotencyKey: key,
          },
        ),
  );
}

/** 一次分发 tick：把该租户的待发邮件改到假时钟之前，再真的发到 Mailpit。 */
async function tick(tenantId: string) {
  await owner.pool.query(
    "update email_outbox set next_attempt_at = $2, created_at = $2 where tenant_id = $1 and status = 'pending'",
    [tenantId, new Date(T0.getTime() - 60_000)],
  );
  const settings = mailpitSettings();
  const transport = createMailTransport(settings);
  try {
    return await dispatchOutbox(app.db, {
      transport,
      settings,
      now: () => T0,
    });
  } finally {
    transport.close();
  }
}
const inbox = async () =>
  (await mailpitMessages()).map((message) => message.Subject).reverse();

describe('余额通知经 Mailpit 发出', () => {
  it('delivers the two balance notices through Mailpit', async () => {
    const tenant = await tenantWith({
      threshold: '100',
      overdraft: '100',
      emails: ['Finance@Example.test', 'cfo@example.test'],
    });
    await move(tenant.id, '120');
    // 120 → 80 → 50 → 150 → 90：恰好两封，累计 0、1、1、1、2。
    const steps: [string, number][] = [
      ['-40', 1],
      ['-30', 1],
      ['100', 1],
      ['-60', 2],
    ];
    for (const [delta, expected] of steps) {
      await move(tenant.id, delta);
      await tick(tenant.id);
      expect(await inbox()).toHaveLength(expected);
    }
    const messages = (await mailpitMessages()).reverse();
    expect(messages.map((message) => message.Subject)).toEqual([
      `【余额不足】${tenant.name} 余额 CNY 80`,
      `【余额不足】${tenant.name} 余额 CNY 90`,
    ]);
    for (const message of messages)
      expect(message.To.map((to) => to.Address).sort()).toEqual([
        'cfo@example.test',
        'finance@example.test',
      ]);
    const detail = await mailpitMessage(messages[1]!.ID);
    expect(detail.Text).toContain(`租户：${tenant.code}（${tenant.name}）`);
    expect(detail.Text).toContain('当前余额：CNY 90');
    expect(detail.Text).toContain('提醒阈值：CNY 100');
    expect(detail.Text).toContain('可用额度：CNY 190');

    // 发出的两封各记一条 balance_alert_deliveries（余额是触发器写的字符串快照）。
    const { rows } = await owner.pool.query(
      `select kind, balance::text, recipients from balance_alert_deliveries
       where tenant_id = $1 order by balance`,
      [tenant.id],
    );
    expect(rows).toEqual([
      {
        kind: 'low_balance',
        balance: '80',
        recipients: ['finance@example.test', 'cfo@example.test'],
      },
      {
        kind: 'low_balance',
        balance: '90',
        recipients: ['finance@example.test', 'cfo@example.test'],
      },
    ]);
  });

  it('delivers the suspension notice through Mailpit', async () => {
    const tenant = await tenantWith({
      threshold: '0',
      overdraft: '100',
      emails: ['finance@example.test'],
    });
    await move(tenant.id, '120');
    for (const delta of ['-219', '-1', '-5']) {
      // −99、−100、−105：只有越过可用额度 0 的那一笔发邮件，在途通话继续扣费不重发。
      await move(tenant.id, delta);
      await tick(tenant.id);
    }
    const messages = await mailpitMessages();
    expect(messages).toHaveLength(1);
    expect(messages[0]!.Subject).toBe(
      `【已停机】${tenant.name} 可用额度已用完`,
    );
    expect(messages[0]!.To.map((to) => to.Address)).toEqual([
      'finance@example.test',
    ]);
    const detail = await mailpitMessage(messages[0]!.ID);
    expect(detail.Text).toContain('当前余额：CNY -100');
    expect(detail.Text).toContain('透支额度：CNY 100');
    const { rows } = await owner.pool.query(
      `select kind, balance::text from balance_alert_deliveries where tenant_id = $1`,
      [tenant.id],
    );
    expect(rows).toEqual([{ kind: 'suspended', balance: '-100' }]);
  });

  it('skipped notices are never sent', async () => {
    const tenant = await tenantWith({
      threshold: '100',
      overdraft: '100',
      emails: [],
    });
    await move(tenant.id, '120');
    await move(tenant.id, '-40');
    expect(await tick(tenant.id)).toMatchObject({ claimed: 0, sent: 0 });
    expect(await mailpitMessages()).toEqual([]);
  });
});
