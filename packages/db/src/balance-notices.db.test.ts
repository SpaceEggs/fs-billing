import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { authorize, money, parseDialedNumber, rate } from '@fs-billing/rating';
import { renderMail } from '@fs-billing/shared';
import {
  adminId,
  adminTransaction,
  backendPid,
  connections,
  deferred,
  pgError,
  waitForTenantLock,
} from '../test/support.js';
import {
  balanceNoticeDedupeKey,
  readBalanceNoticeState,
  syncBalanceNoticeState,
} from './balance-notices.js';
import { withAdmin, withSystem, withTenant } from './client.js';
import { appendLedgerEntry } from './ledger.js';
import { loadRatingTenant } from './rates.js';
import { raiseEmailFailed } from './outbox.js';
import {
  createTenant,
  disableTenant,
  enableTenant,
  updateTenantSettings,
} from './admin/tenants.js';

const { app, owner } = connections();

/** 本文件造的余额通知：共用的测试库里不留给后面的文件（被 balance_alert_deliveries 引用的已发送行删不掉，保留）。 */
async function cleanUp() {
  await owner.pool.query(
    "update email_outbox set status = 'skipped', skip_reason = 'test cleanup', sent_at = null, locked_until = null where template like 'balance\\_%' and status in ('pending', 'sending', 'failed')",
  );
  await owner.pool.query(
    "delete from email_outbox o where o.template like 'balance\\_%' and not exists (select 1 from balance_alert_deliveries d where d.outbox_id = o.id)",
  );
}
afterAll(cleanUp);

/** 余额通知用例的租户：CNY，阈值 100，透支额度 100，通知邮箱一个。 */
interface Options {
  readonly threshold?: string;
  readonly overdraft?: string;
  readonly emails?: string[];
  /** 开户后充值到这个余额（不触发通知：状态已按开户余额同步）。 */
  readonly balance?: string;
}

const RECIPIENT = 'billing-ops@example.test';

async function actor() {
  return { id: await adminId(owner), name: '王敏' };
}

async function setup(options: Options = {}) {
  const code = `N${randomUUID().replaceAll('-', '').slice(0, 10).toUpperCase()}`;
  const { tenant } = await createTenant({
    db: app.db,
    actor: await actor(),
    creatorEmail: 'creator@example.test',
    request: {
      code,
      name: `余额通知 ${code}`,
      currency: 'CNY',
      contactName: '',
      contactPhone: '',
      remark: '',
      settings: {
        lowBalanceThreshold: options.threshold ?? '100',
        overdraftLimit: options.overdraft ?? '100',
        emails: options.emails ?? [RECIPIENT],
      },
      initialRates: { kind: 'blank' },
    },
  });
  if (options.balance !== undefined) await move(tenant.id, options.balance);
  return { id: tenant.id, code };
}

it('records suspension transitions and clears the time on recovery', async () => {
  const tenant = await setup({ balance: '10' });
  const read = async () =>
    (
      await owner.pool.query<{ suspended_at: Date | null }>(
        'select suspended_at from balance_notice_state where tenant_id = $1',
        [tenant.id],
      )
    ).rows[0]!.suspended_at;
  expect(await read()).toBeNull();
  await move(tenant.id, '-110');
  const first = await read();
  expect(first).toBeInstanceOf(Date);
  await move(tenant.id, '1');
  expect(await read()).toBeNull();
  await owner.pool.query('select pg_sleep(0.01)');
  await move(tenant.id, '-1');
  const second = await read();
  expect(second).toBeInstanceOf(Date);
  expect(second!.getTime()).toBeGreaterThan(first!.getTime());
});

let sequence = 0;
/** 一笔流水：正数是充值，负数是通话扣费。 */
async function move(tenantId: string, amount: string) {
  const key = `balance-notices:${++sequence}:${randomUUID()}`;
  await withAdmin(app.db, async (tx) =>
    amount.startsWith('-')
      ? appendLedgerEntry(
          tx,
          { id: tenantId, currency: 'CNY' },
          {
            kind: 'call_charge',
            amount: money('CNY', amount),
            occurredAt: new Date('2026-10-29T01:00:00Z'),
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

interface Notice {
  dedupe_key: string;
  template: string;
  status: string;
  skip_reason: string | null;
  recipients: string[];
  params: Record<string, unknown>;
}
async function notices(tenantId: string): Promise<Notice[]> {
  const { rows } = await owner.pool.query<Notice>(
    `select dedupe_key, template, status, skip_reason, recipients, params
     from email_outbox where tenant_id = $1 order by created_at, dedupe_key`,
    [tenantId],
  );
  return rows;
}
const stateOf = async (tenantId: string) =>
  withSystem(app.db, (tx) => readBalanceNoticeState(tx, tenantId));
const flags = async (tenantId: string) => {
  const state = await stateOf(tenantId);
  return {
    low: state?.lowActive,
    suspended: state?.suspendedActive,
    lowSeq: state?.lowSeq,
    suspendedSeq: state?.suspendedSeq,
  };
};
const templates = async (tenantId: string) =>
  (await notices(tenantId)).map((notice) => notice.template);

describe('余额提醒', () => {
  it('queues one notice per crossing: 120, 80, 50, 150, 90', async () => {
    const tenant = await setup({ balance: '120' });
    expect(await notices(tenant.id)).toEqual([]);
    expect(await flags(tenant.id)).toMatchObject({ low: false, lowSeq: 0 });

    await move(tenant.id, '-40'); // 80：越线
    expect(await templates(tenant.id)).toEqual(['balance_low']);
    expect(await flags(tenant.id)).toMatchObject({ low: true, lowSeq: 1 });

    await move(tenant.id, '-30'); // 50：已通知过，不再发
    expect(await templates(tenant.id)).toEqual(['balance_low']);

    await move(tenant.id, '100'); // 150：回到线上，重新上膛，不发邮件
    expect(await templates(tenant.id)).toEqual(['balance_low']);
    expect(await flags(tenant.id)).toMatchObject({ low: false, lowSeq: 1 });

    await move(tenant.id, '-60'); // 90：第二次越线
    const queued = await notices(tenant.id);
    expect(queued.map((notice) => notice.dedupe_key)).toEqual([
      balanceNoticeDedupeKey('balance_low', tenant.id, 1),
      balanceNoticeDedupeKey('balance_low', tenant.id, 2),
    ]);
    expect(queued.map((notice) => notice.status)).toEqual([
      'pending',
      'pending',
    ]);
    expect(queued.map((notice) => notice.recipients)).toEqual([
      [RECIPIENT],
      [RECIPIENT],
    ]);
    // 金额是字符串快照（模板和 completeEmail 都要求），形状符合 balance_low 的 strict 校验。
    expect(queued[1]!.params).toEqual({
      tenantCode: tenant.code,
      tenantName: `余额通知 ${tenant.code}`,
      currency: 'CNY',
      balance: '90',
      overdraftLimit: '100',
      threshold: '100',
      available: '190',
    });
    expect(await flags(tenant.id)).toMatchObject({ low: true, lowSeq: 2 });
    for (const notice of queued) {
      const rendered = renderMail('balance_low', notice.params);
      expect(rendered.subject).toContain(`余额通知 ${tenant.code}`);
      expect(rendered.text).toContain('当前余额：CNY');
    }
  });

  it('does not fire at exactly the threshold', async () => {
    const tenant = await setup({ balance: '120' });
    await move(tenant.id, '-20'); // 恰好 100
    expect(await notices(tenant.id)).toEqual([]);
    expect(await flags(tenant.id)).toMatchObject({ low: false });

    await move(tenant.id, '-0.01'); // 99.99
    expect(await templates(tenant.id)).toEqual(['balance_low']);
    expect(await flags(tenant.id)).toMatchObject({ low: true });

    await move(tenant.id, '0.01'); // 回到恰好 100：重新上膛
    expect(await flags(tenant.id)).toMatchObject({ low: false });
    await move(tenant.id, '-0.01');
    expect(await templates(tenant.id)).toEqual(['balance_low', 'balance_low']);
  });

  it('a threshold of zero disables the low balance reminder', async () => {
    const tenant = await setup({ threshold: '0', balance: '50' });
    await move(tenant.id, '-120'); // −70，仍在透支额度内
    expect(await notices(tenant.id)).toEqual([]);
    expect(await flags(tenant.id)).toMatchObject({
      low: false,
      suspended: false,
    });
  });

  it('crossing both lines at once sends only the suspension notice', async () => {
    const tenant = await setup({ balance: '120' });
    await move(tenant.id, '-220'); // 120 → −100：同时越过 100 与可用额度 0
    const queued = await notices(tenant.id);
    expect(queued.map((notice) => notice.template)).toEqual([
      'balance_suspended',
    ]);
    // 低余额视为已触发，序号不动；随后不会再补一封。
    expect(await flags(tenant.id)).toMatchObject({
      low: true,
      lowSeq: 0,
      suspended: true,
      suspendedSeq: 1,
    });
    await move(tenant.id, '-1');
    expect(await templates(tenant.id)).toEqual(['balance_suspended']);
  });
});

describe('停机通知', () => {
  it('queues one suspension notice when balance plus overdraft reaches zero', async () => {
    const tenant = await setup({ threshold: '0', balance: '120' });
    await move(tenant.id, '-219.99'); // −99.99，可用额度 0.01
    expect(await notices(tenant.id)).toEqual([]);
    await move(tenant.id, '-0.01'); // −100，可用额度 0
    const queued = await notices(tenant.id);
    expect(queued.map((notice) => notice.template)).toEqual([
      'balance_suspended',
    ]);
    // 停机通知的 params 形状：strict，没有 threshold / available。
    expect(queued[0]!.params).toEqual({
      tenantCode: tenant.code,
      tenantName: `余额通知 ${tenant.code}`,
      currency: 'CNY',
      balance: '-100.00',
      overdraftLimit: '100',
    });
    expect(
      renderMail('balance_suspended', queued[0]!.params).subject,
    ).toContain('已停机');
  });

  it('does not repeat while the tenant stays suspended', async () => {
    const tenant = await setup({ threshold: '0', balance: '120' });
    await move(tenant.id, '-220');
    await move(tenant.id, '-1'); // 在途通话继续扣到 −101
    await move(tenant.id, '-5');
    expect(await templates(tenant.id)).toEqual(['balance_suspended']);
    expect(await flags(tenant.id)).toMatchObject({
      suspended: true,
      suspendedSeq: 1,
    });
  });

  it('notifies again after a top-up and a second drop', async () => {
    const tenant = await setup({ threshold: '0', balance: '120' });
    await move(tenant.id, '-220'); // −100：第一封
    await move(tenant.id, '-1'); // −101：不重发
    await move(tenant.id, '50'); // −51：可用额度 49 > 0，重新上膛
    expect(await flags(tenant.id)).toMatchObject({ suspended: false });
    expect(await templates(tenant.id)).toEqual(['balance_suspended']);
    await move(tenant.id, '-49'); // −100：第二封
    const queued = await notices(tenant.id);
    expect(queued.map((notice) => notice.dedupe_key)).toEqual([
      balanceNoticeDedupeKey('balance_suspended', tenant.id, 1),
      balanceNoticeDedupeKey('balance_suspended', tenant.id, 2),
    ]);
  });

  it('a suspension notice is queued exactly when available credit is not above zero', async () => {
    const tenant = await setup({
      threshold: '0',
      overdraft: '0',
      balance: '5',
    });
    for (const [delta, expected] of [
      ['-4.99', 0], // 0.01
      ['-0.01', 1], // 0
      ['0.01', 1], // 0.01：重新上膛
      ['-0.01', 2], // 0
    ] as const) {
      await move(tenant.id, delta);
      expect(
        (await templates(tenant.id)).filter(
          (template) => template === 'balance_suspended',
        ),
      ).toHaveLength(expected);
    }
  });

  it('authorize rejects for insufficient balance while available credit is below one minute but no suspension notice is queued', async () => {
    // 租户 0.05 元/分钟，无透支额度：可用额度 0.03 不够打一分钟，授权已拒绝，但还没到「已停机」线。
    const tenant = await setup({
      threshold: '100',
      overdraft: '0',
      balance: '1',
    });
    const ratingTenant = async () => {
      const loaded = (await withSystem(app.db, (tx) =>
        loadRatingTenant(tx, tenant.code),
      ))!;
      // 余额、透支额度取自数据库；费率表在内存里放一条 86 前缀 0.05 元/分钟。
      return {
        ...loaded,
        rates: {
          currency: 'CNY' as const,
          versions: [
            {
              effectiveFrom: new Date(0),
              entries: [
                {
                  prefix: '86',
                  country: '中国',
                  iso: '',
                  description: '',
                  perMinute: rate('CNY', '0.05'),
                },
              ],
            },
          ],
        },
      } as typeof loaded;
    };
    const at = new Date('2026-10-29T01:00:00Z');
    const dialed = parseDialedNumber('8613800138000')!;
    const decide = async () => authorize(await ratingTenant(), dialed, at);

    await move(tenant.id, '-0.97'); // 0.03
    expect(await decide()).toEqual({ allowed: false, reason: '余额不足' });
    expect(await templates(tenant.id)).not.toContain('balance_suspended');
    expect(await flags(tenant.id)).toMatchObject({ suspended: false });

    await move(tenant.id, '-0.03'); // 0：已停机
    expect(await decide()).toEqual({ allowed: false, reason: '余额不足' });
    expect(await templates(tenant.id)).toContain('balance_suspended');
  });
});

describe('收件人与租户状态', () => {
  it('an empty recipient list is skipped and does not re-arm', async () => {
    const tenant = await setup({ emails: [], balance: '120' });
    await move(tenant.id, '-40'); // 80：越线，没有收件人
    const queued = await notices(tenant.id);
    expect(queued).toHaveLength(1);
    expect(queued[0]).toMatchObject({
      template: 'balance_low',
      status: 'skipped',
      skip_reason: 'no_recipients',
      recipients: [],
    });
    // 状态照常前进：继续往下不再重复入队。
    expect(await flags(tenant.id)).toMatchObject({ low: true, lowSeq: 1 });
    await move(tenant.id, '-30');
    expect(await notices(tenant.id)).toHaveLength(1);
  });

  it('recipients that are not plain addresses are dropped and an all-invalid list is skipped', async () => {
    const tenant = await setup({ balance: '120' });
    // 设置接口会拒绝这些值；这里模拟手工改库的旧数据。
    await owner.pool.query(
      `update balance_alert_settings set emails = $2 where tenant_id = $1`,
      [
        tenant.id,
        [
          ' Ops@Example.Test ',
          'a@b.test, c@d.test',
          'ops@example.test',
          'Name <n@e.test>',
        ],
      ],
    );
    await move(tenant.id, '-40');
    expect((await notices(tenant.id))[0]).toMatchObject({
      status: 'pending',
      recipients: ['ops@example.test'],
    });
    await owner.pool.query(
      `update balance_alert_settings set emails = $2 where tenant_id = $1`,
      [tenant.id, ['a@b.test, c@d.test']],
    );
    await move(tenant.id, '100'); // 180：重新上膛
    await move(tenant.id, '-90'); // 90
    expect((await notices(tenant.id))[1]).toMatchObject({
      status: 'skipped',
      skip_reason: 'invalid_recipients',
      recipients: [],
    });
  });

  it('the SQL recipient filter agrees with the settings validation', async () => {
    const corpus = [
      'a@example.com',
      'A.B+tag@Example.COM',
      "o'brien@example.com",
      'first.last@sub.example.co.uk',
      'x@y',
      'x@y.c',
      '.a@example.com',
      'a..b@example.com',
      'a@-example.com',
      'a b@example.com',
      'a@example.com, b@example.com',
      'Name <a@example.com>',
      '<a@example.com>',
      'a@@example.com',
      'a@example..com',
      'ünï@example.com',
      '用户@example.com',
      'a;b@example.com',
      'a@example.com;',
      'a"b@example.com',
      '',
      '   ',
      'plain',
    ];
    const { rows } = await owner.pool.query<{ kept: string[] }>(
      'select balance_notice_recipients($1::text[]) as kept',
      [corpus],
    );
    const expected = [
      ...new Set(
        corpus
          .map((entry) => entry.trim().toLowerCase())
          .filter((entry) => z.email().safeParse(entry).success),
      ),
    ];
    expect(rows[0]!.kept).toEqual(expected);
  });

  it('a disabled tenant keeps its state and sends nothing', async () => {
    const tenant = await setup({ balance: '120' });
    const admin = await actor();
    await disableTenant({ db: app.db, actor: admin, tenantId: tenant.id });

    await move(tenant.id, '-40'); // 80：停用期间越线
    expect(
      (await notices(tenant.id)).map(({ template, status, skip_reason }) => ({
        template,
        status,
        skip_reason,
      })),
    ).toEqual([
      {
        template: 'balance_low',
        status: 'skipped',
        skip_reason: 'tenant_disabled',
      },
    ]);
    expect(await flags(tenant.id)).toMatchObject({ low: true, lowSeq: 1 });

    // 重新启用后不补发，也不重复：状态已经是「已通知」。
    await enableTenant({ db: app.db, actor: admin, tenantId: tenant.id });
    await move(tenant.id, '-10');
    expect(await notices(tenant.id)).toHaveLength(1);
    // 回到线上再降下去，才会真的发。
    await move(tenant.id, '100');
    await move(tenant.id, '-100');
    expect((await notices(tenant.id)).map((notice) => notice.status)).toEqual([
      'skipped',
      'pending',
    ]);
  });

  it('only the tenant notification mailboxes are addressed', async () => {
    const tenant = await setup({
      emails: ['One@Example.test', 'two@example.test', 'one@example.test'],
      balance: '120',
    });
    await move(tenant.id, '-40');
    expect((await notices(tenant.id))[0]!.recipients).toEqual([
      'one@example.test',
      'two@example.test',
    ]);
  });
});

describe('设置变更', () => {
  const save = async (
    tenantId: string,
    request: {
      overdraftLimit: string;
      lowBalanceThreshold: string;
      emails: string[];
    },
  ) =>
    updateTenantSettings({
      db: app.db,
      actor: await actor(),
      tenantId,
      request,
    });

  it('changing the threshold syncs silently', async () => {
    const tenant = await setup({ balance: '120' });
    await move(tenant.id, '-40'); // 80：已通知
    expect(await notices(tenant.id)).toHaveLength(1);

    // 阈值降到 50：80 在线上，静默重新上膛。
    await save(tenant.id, {
      overdraftLimit: '100',
      lowBalanceThreshold: '50',
      emails: [RECIPIENT],
    });
    expect(await flags(tenant.id)).toMatchObject({ low: false, lowSeq: 1 });
    // 阈值升到 200：80 在线下，静默记为已通知，不补发。
    await save(tenant.id, {
      overdraftLimit: '100',
      lowBalanceThreshold: '200',
      emails: [RECIPIENT],
    });
    expect(await flags(tenant.id)).toMatchObject({ low: true, lowSeq: 1 });
    expect(await notices(tenant.id)).toHaveLength(1);

    // 回到阈值之上再降下去才会再发。
    await move(tenant.id, '150'); // 230
    expect(await flags(tenant.id)).toMatchObject({ low: false });
    await move(tenant.id, '-60'); // 170
    expect(await templates(tenant.id)).toEqual(['balance_low', 'balance_low']);
  });

  it('changing the overdraft limit syncs the suspension state silently', async () => {
    const tenant = await setup({ threshold: '0', balance: '-90' });
    expect(await flags(tenant.id)).toMatchObject({ suspended: false });
    // 透支额度降到 50：可用额度 −40，静默记为已停机，不发停机通知。
    await save(tenant.id, {
      overdraftLimit: '50',
      lowBalanceThreshold: '0',
      emails: [RECIPIENT],
    });
    expect(await flags(tenant.id)).toMatchObject({
      suspended: true,
      suspendedSeq: 0,
    });
    // 升回 200：可用额度 110，静默重新上膛。
    await save(tenant.id, {
      overdraftLimit: '200',
      lowBalanceThreshold: '0',
      emails: [RECIPIENT],
    });
    expect(await flags(tenant.id)).toMatchObject({ suspended: false });
    expect(await notices(tenant.id)).toEqual([]);
  });

  it('a new tenant starts with a state row and sends nothing at creation', async () => {
    const tenant = await setup({ threshold: '100', overdraft: '0' });
    // 余额 0，阈值 100：已在线下、可用额度 0，但开户当刻不发邮件。
    expect(await notices(tenant.id)).toEqual([]);
    expect(await flags(tenant.id)).toMatchObject({
      low: true,
      suspended: true,
      lowSeq: 0,
      suspendedSeq: 0,
    });
    await move(tenant.id, '500');
    expect(await flags(tenant.id)).toMatchObject({
      low: false,
      suspended: false,
    });
    expect(await notices(tenant.id)).toEqual([]);
  });

  it('saving new notification mailboxes recovers the rejected-recipient alert', async () => {
    const tenant = await setup({ balance: '120' });
    await withSystem(app.db, (tx) =>
      raiseEmailFailed(tx, {
        tenantId: tenant.id,
        description: '收件人被拒',
      }),
    );
    const open = () =>
      owner.pool.query(
        `select 1 from system_alerts where kind = 'email_failed' and subject_key = $1 and recovered_at is null`,
        [`recipient:${tenant.id}`],
      );
    expect((await open()).rowCount).toBe(1);
    // 只改阈值不碰邮箱：告警不动。
    await save(tenant.id, {
      overdraftLimit: '100',
      lowBalanceThreshold: '90',
      emails: [RECIPIENT],
    });
    expect((await open()).rowCount).toBe(1);
    await save(tenant.id, {
      overdraftLimit: '100',
      lowBalanceThreshold: '90',
      emails: ['new-ops@example.test'],
    });
    expect((await open()).rowCount).toBe(0);
  });
});

describe('并发与幂等', () => {
  it('a rerun of the same transaction queues one notice', async () => {
    const tenant = await setup({ balance: '120' });
    const charge = (fail: boolean) =>
      adminTransaction(app.db, async (tx) => {
        await appendLedgerEntry(
          tx,
          { id: tenant.id, currency: 'CNY' },
          {
            kind: 'call_charge',
            amount: money('CNY', '-40'),
            occurredAt: new Date('2026-10-29T01:00:00Z'),
            note: 'rerun',
            idempotencyKey: `rerun:${tenant.id}`,
          },
        );
        if (fail) throw new Error('提交前崩溃');
      });
    await expect(charge(true)).rejects.toThrow('提交前崩溃');
    // 回滚：流水、状态、邮件一起回滚。
    expect(await notices(tenant.id)).toEqual([]);
    expect(await flags(tenant.id)).toMatchObject({ low: false, lowSeq: 0 });
    await charge(false);
    await charge(false); // 幂等键相同：流水不重复，余额不变，不再入队
    expect(await templates(tenant.id)).toEqual(['balance_low']);
    expect(await flags(tenant.id)).toMatchObject({ low: true, lowSeq: 1 });
  });

  /** 等到有别的后端被 `blockerPid` 堵住（pg_blocking_pids），返回被堵的后端；轮询，不靠睡眠猜时机。 */
  async function waitForBlockedBy(blockerPid: number): Promise<number> {
    for (let attempt = 0; attempt < 500; attempt++) {
      const { rows } = await owner.pool.query<{ pid: number }>(
        'select pid from pg_stat_activity where $1 = any (pg_blocking_pids(pid))',
        [blockerPid],
      );
      if (rows[0]) return rows[0].pid;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(`没有后端被连接 ${blockerPid} 堵住`);
  }

  /** 两个标志与「最终余额 + 最终设置」重新算出来的一致（序号另行断言）。 */
  async function expectFlagsMatchBalance(tenantId: string) {
    const { rows } = await owner.pool.query<{
      low: boolean;
      suspended: boolean;
    }>(
      `select coalesce(s.threshold, 0) > 0 and b.balance < coalesce(s.threshold, 0) as low,
              b.balance + t.overdraft_limit <= 0 as suspended
       from tenants t join tenant_balances b on b.tenant_id = t.id
       left join balance_alert_settings s on s.tenant_id = t.id
       where t.id = $1`,
      [tenantId],
    );
    expect(await flags(tenantId)).toMatchObject(rows[0]!);
  }

  const chargeIn = (
    tx: Parameters<Parameters<typeof adminTransaction>[1]>[0],
    tenantId: string,
    amount: string,
    key: string,
  ) =>
    appendLedgerEntry(
      tx,
      { id: tenantId, currency: 'CNY' },
      {
        kind: 'call_charge',
        amount: money('CNY', amount),
        occurredAt: new Date('2026-10-29T01:00:00Z'),
        note: key,
        idempotencyKey: `${key}:${tenantId}`,
      },
    );

  it('concurrent charges crossing the threshold queue one notice', async () => {
    const tenant = await setup({ balance: '105' });
    const first = deferred();
    const release = deferred();
    const slow = adminTransaction(app.db, async (tx) => {
      await chargeIn(tx, tenant.id, '-10', 'slow');
      first.resolve();
      await release.promise;
    });
    await first.promise;
    // 第二笔在租户锁上排队，等第一笔提交后看到 low_active = true。
    const secondPid = deferred<number>();
    const second = adminTransaction(app.db, async (tx) => {
      secondPid.resolve(await backendPid(tx));
      await chargeIn(tx, tenant.id, '-10', 'fast');
    });
    await waitForTenantLock(owner, await secondPid.promise, tenant.id);
    release.resolve();
    await Promise.all([slow, second]);
    expect(await templates(tenant.id)).toEqual(['balance_low']);
    expect(await flags(tenant.id)).toMatchObject({ low: true, lowSeq: 1 });
  });

  it('a settings save waits for a transaction holding the balance row and then sees its balance', async () => {
    const tenant = await setup({ balance: '120' }); // 阈值 100
    // A 是只持余额行锁、不持租户锁的写入者（rebuild_tenant_balances 就是这样）：先锁住余额行，再把余额改到 50。
    const a = await owner.pool.connect();
    try {
      await a.query('begin');
      const {
        rows: [self],
      } = await a.query<{ pid: number }>('select pg_backend_pid() as pid');
      await a.query(
        'select balance from tenant_balances where tenant_id = $1 for update',
        [tenant.id],
      );
      await a.query(
        'update tenant_balances set balance = 50 where tenant_id = $1',
        [tenant.id],
      );
      // B 把阈值改成 80：同步函数要对同一行 FOR UPDATE，必须等 A 提交。
      let finished = false;
      const save = updateTenantSettings({
        db: app.db,
        actor: await actor(),
        tenantId: tenant.id,
        request: {
          overdraftLimit: '100',
          lowBalanceThreshold: '80',
          emails: [RECIPIENT],
        },
      }).finally(() => {
        finished = true;
      });
      const blocked = await waitForBlockedBy(self!.pid);
      expect(blocked).not.toBe(self!.pid);
      expect(finished).toBe(false);
      await a.query('commit');
      await save;
      // B 读到的是 A 提交后的余额 50（陈旧的 120 会得到 low = false）：低于新阈值 80，静默记为已通知；
      // 邮件只有 A 的触发器在旧阈值 100 下发的那一封。
      expect(await flags(tenant.id)).toMatchObject({
        low: true,
        suspended: false,
        lowSeq: 1,
      });
      expect(await templates(tenant.id)).toEqual(['balance_low']);
      await expectFlagsMatchBalance(tenant.id);
    } finally {
      await a.query('rollback').catch(() => undefined);
      a.release();
    }
  });

  it('a charge and a settings save in either order end with flags matching the final balance and settings', async () => {
    const request = {
      overdraftLimit: '100',
      lowBalanceThreshold: '200',
      emails: [RECIPIENT],
    };
    // 设置先拿租户锁：同步后 120 < 200，低余额记为已通知（静默）；扣费排队，随后 80 不再通知。
    const first = await setup({ balance: '120' });
    const saved = deferred();
    const releaseSave = deferred();
    const settingsFirst = adminTransaction(app.db, async (tx) => {
      await updateTenantSettings({
        db: tx,
        actor: await actor(),
        tenantId: first.id,
        request,
      });
      saved.resolve();
      await releaseSave.promise;
    });
    await saved.promise;
    const chargePid = deferred<number>();
    const chargeSecond = adminTransaction(app.db, async (tx) => {
      chargePid.resolve(await backendPid(tx));
      await chargeIn(tx, first.id, '-40', 'after-save');
    });
    await waitForTenantLock(owner, await chargePid.promise, first.id);
    releaseSave.resolve();
    await Promise.all([settingsFirst, chargeSecond]);
    expect(await notices(first.id)).toEqual([]);
    expect(await flags(first.id)).toMatchObject({ low: true, lowSeq: 0 });
    await expectFlagsMatchBalance(first.id);

    // 扣费先拿租户锁：120 → 80 在阈值 100 下越线发一封；设置排队，随后把阈值改成 200，状态仍是已通知，不再发。
    const second = await setup({ balance: '120' });
    const charged = deferred();
    const releaseCharge = deferred();
    const chargeHolderPid = deferred<number>();
    const chargeFirst = adminTransaction(app.db, async (tx) => {
      chargeHolderPid.resolve(await backendPid(tx));
      await chargeIn(tx, second.id, '-40', 'before-save');
      charged.resolve();
      await releaseCharge.promise;
    });
    await charged.promise;
    const settingsSecond = updateTenantSettings({
      db: app.db,
      actor: await actor(),
      tenantId: second.id,
      request,
    });
    // 设置保存被扣费事务堵住：被堵的后端等的是它持有的租户锁。
    await waitForBlockedBy(await chargeHolderPid.promise);
    releaseCharge.resolve();
    await Promise.all([chargeFirst, settingsSecond]);
    expect(await templates(second.id)).toEqual(['balance_low']);
    expect(await flags(second.id)).toMatchObject({ low: true, lowSeq: 1 });
    await expectFlagsMatchBalance(second.id);
  });

  it('rebuild_tenant_balances waits for an in-flight charge and leaves one notice and consistent flags', async () => {
    const tenant = await setup({ balance: '120' });
    const written = deferred();
    const release = deferred();
    const holderPid = deferred<number>();
    // 扣费事务写完流水（缓存余额行被它的触发器更新并加锁，已越线入队）后先不提交。
    const inFlight = adminTransaction(app.db, async (tx) => {
      holderPid.resolve(await backendPid(tx));
      await chargeIn(tx, tenant.id, '-40', 'in-flight');
      written.resolve();
      await release.promise;
    });
    await written.promise;
    // 重算只持余额行锁、不持租户锁：处理到这个租户时在余额行上排队。
    const rebuild = owner.pool.query('call rebuild_tenant_balances(NULL)');
    await waitForBlockedBy(await holderPid.promise);
    release.resolve();
    await Promise.all([inFlight, rebuild]);
    expect(await templates(tenant.id)).toEqual(['balance_low']);
    expect(await flags(tenant.id)).toMatchObject({ low: true, lowSeq: 1 });
    await expectFlagsMatchBalance(tenant.id);
    // 重算看到了这笔流水：缓存余额与流水合计一致。
    const { rows } = await owner.pool.query(
      'select count(*)::int as n from balance_discrepancies where tenant_id = $1',
      [tenant.id],
    );
    expect(rows).toEqual([{ n: 0 }]);
  });

  it('rebuild_tenant_balances queues notices like any other balance change', async () => {
    const tenant = await setup({ balance: '120' });
    // 人为弄脏缓存余额（模拟漂移）：先改到 80 触发一次，再让重算修回 120。
    await owner.pool.query(
      'update tenant_balances set balance = 80 where tenant_id = $1',
      [tenant.id],
    );
    expect(await templates(tenant.id)).toEqual(['balance_low']);
    await owner.pool.query('call rebuild_tenant_balances(NULL)');
    expect(await flags(tenant.id)).toMatchObject({ low: false });
    expect(await templates(tenant.id)).toEqual(['balance_low']);
  });
});

describe('权限', () => {
  it('only operators can sync and tenants cannot read or write notice state', async () => {
    const tenant = await setup({ balance: '120' });
    const other = await setup({ balance: '120' });
    // 租户身份不能调同步函数。
    expect(
      await pgError(
        withTenant(app.db, tenant.id, (tx) =>
          syncBalanceNoticeState(tx, tenant.id),
        ),
      ),
    ).toMatchObject({ code: '42501' });
    // 租户身份读不到状态行（staff_only），也不能写。
    const visible = await withTenant(app.db, tenant.id, (tx) =>
      readBalanceNoticeState(tx, tenant.id),
    );
    expect(visible).toBeUndefined();
    expect(
      await pgError(
        withTenant(app.db, tenant.id, (tx) =>
          tx.execute(sql`update balance_notice_state set low_active = true`),
        ),
      ),
    ).toMatchObject({ code: '42501' });
    // 租户读不到别人的余额通知发件箱行（email_outbox 的 staff_only）。
    await move(other.id, '-40');
    const rows = await withTenant(app.db, tenant.id, (tx) =>
      tx.execute(sql`select 1 from email_outbox`),
    );
    expect(rows.rows).toEqual([]);
    // 内部函数不对应用角色开放。
    expect(
      await pgError(
        withAdmin(app.db, (tx) =>
          tx.execute(
            sql`select enqueue_balance_notice(${tenant.id}::uuid, 'balance_low', 99, 1, 1)`,
          ),
        ),
      ),
    ).toMatchObject({ code: '42501' });
    expect(
      await pgError(
        withAdmin(app.db, (tx) =>
          tx.execute(sql`select balance_notice_recipients(array['a@b.test'])`),
        ),
      ),
    ).toMatchObject({ code: '42501' });
  });

  it('the rendered notice of one tenant carries none of another tenant data', async () => {
    const a = await setup({ balance: '120' });
    const b = await setup({ balance: '120' });
    await move(a.id, '-40');
    await move(b.id, '-35');
    const [noticeA] = await notices(a.id);
    const rendered = renderMail('balance_low', noticeA!.params);
    expect(rendered.text).toContain(a.code);
    expect(rendered.text).not.toContain(b.code);
    expect(rendered.html).not.toContain(b.code);
  });
});
