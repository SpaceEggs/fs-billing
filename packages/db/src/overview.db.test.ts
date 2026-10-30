import { beforeAll, describe, expect, it } from 'vitest';
import { beijingTime } from '@fs-billing/rating';
import { scratchDatabase } from '../test/scratch.js';
import {
  statementCdr,
  statementLedger,
  statementTenant,
} from '../test/statements.js';
import { insertUnassigned } from '../test/unassigned.js';
import {
  alertsInWindow,
  countOpenAlerts,
  readAlertSummary,
} from './alert-list.js';
import { raiseAlert, recoverAlert } from './alerts.js';
import { withAdmin, withSystem } from './client.js';
import { getAdminOverview, readAdminOverview } from './overview.js';
import { ensureCdrPartitions } from './partitions.js';
import { listTenants } from './admin/tenants.js';
import { listReceivables, readReceivableTotals } from './admin/receivables.js';
import { readUnassignedSummary } from './unassigned/list.js';

/**
 * 概览（阶段 9 验收 5 的数据库层）。独立的、未播种的库 + 固定时钟：聚合的每个数字都能手算，
 * 北京日边界上下各放一条，而且没有随真实日期移动的种子数据（不会变成时间炸弹）。
 */
const database = scratchDatabase({ seed: false });
// 北京时间 2027-03-15 12:00。窗口：2027-02-14 至 2027-03-15 共 30 天，本月从 2027-03-01 起。
const NOW = new Date('2027-03-15T04:00:00.000Z');
const num = (text: string) => Number(text);
const ago = (hours: number) => new Date(NOW.getTime() - hours * 3_600_000);

let cny: { id: string; code: string };
let usd: { id: string; code: string };
let suspended: { id: string; code: string };
let low: { id: string; code: string };
let normal: { id: string; code: string };

beforeAll(async () => {
  const { app, owner } = database;
  await ensureCdrPartitions(owner.db, {
    moment: beijingTime('2027-03-01 00:00:00'),
    monthsAhead: 1,
  });
  cny = await statementTenant(owner, { currency: 'CNY' });
  usd = await statementTenant(owner, { currency: 'USD' });
  suspended = await statementTenant(owner, { currency: 'CNY' });
  low = await statementTenant(owner, { currency: 'CNY' });
  normal = await statementTenant(owner, { currency: 'CNY' });
  await statementTenant(owner, { currency: 'CNY', status: 'disabled' });
  await owner.pool.query(
    `insert into balance_alert_settings (tenant_id, threshold, emails) values ($1, 50, '{}')`,
    [low.id],
  );
  // 通话扣费：北京日边界两侧各一条；窗口第一天与它前一天的最后一秒；上月最后一秒与本月第一秒。
  const charge = (tenantId: string, at: string, amount: string) =>
    statementLedger(owner, tenantId, 'call_charge', amount, at);
  await charge(cny.id, '2027-03-15 00:00:00', '-1.5');
  await charge(cny.id, '2027-03-14 23:59:59', '-2');
  await charge(cny.id, '2027-03-01 00:00:00', '-3');
  await charge(cny.id, '2027-02-28 23:59:59', '-4');
  await charge(cny.id, '2027-02-14 00:00:00', '-7');
  await charge(cny.id, '2027-02-13 23:59:59', '-9'); // 窗口之外
  await charge(usd.id, '2027-03-15 10:00:00', '-0.5');
  await charge(usd.id, '2027-03-14 12:00:00', '-0.25');
  await charge(suspended.id, '2026-01-01 00:00:00', '-500'); // 很早以前：不在任何窗口，但让它停机
  // 话单分钟：只算今天（北京日）已接通的计费分钟。
  const call = (
    tenantId: string,
    answeredAt: string | null,
    minutes: string,
    startedAt?: string,
  ) =>
    statementCdr(owner, tenantId, {
      startedAt: startedAt ?? answeredAt ?? '2027-03-15 08:30:00',
      answeredAt,
      minutes,
    });
  await call(cny.id, '2027-03-15 08:00:00', '2');
  await call(cny.id, '2027-03-15 08:10:00', '2');
  await call(usd.id, '2027-03-15 09:00:00', '3');
  await call(cny.id, '2027-03-15 00:01:00', '5', '2027-03-14 23:58:00'); // 昨天开始、今天接通
  await call(cny.id, '2027-03-14 23:59:00', '7'); // 昨天接通
  await call(cny.id, null, '9'); // 未接通
  await call(cny.id, '2027-03-16 00:00:00', '11'); // 明天
  await insertUnassigned(owner, [
    { answeredAt: '2027-03-15 10:00:00' },
    { answeredAt: '2027-03-15 11:00:00' },
    {},
    { callUuid: null },
  ]);
  expect(app).toBeDefined();
});

const overview = () => getAdminOverview(database.app.db, { now: NOW });

describe('聚合口径', () => {
  it('sums spend, minutes and the thirty day series per currency in Beijing time', async () => {
    const result = await overview();
    expect(result.asOf).toBe('2027-03-15T04:00:00.000000Z');
    expect(num(result.metrics.todaySpend.CNY)).toBe(1.5);
    expect(num(result.metrics.todaySpend.USD)).toBe(0.5);
    // 本月 = 3 月 1 日 00:00 起：1.5 + 2 + 3；上月最后一秒不算。
    expect(num(result.metrics.monthSpend.CNY)).toBe(6.5);
    expect(num(result.metrics.monthSpend.USD)).toBe(0.75);
    // 今日分钟 = 2 + 2 + 3 + 5（昨天 23:58 开始、今天 00:01 接通的算今天）。
    expect(num(result.metrics.todayCallMinutes)).toBe(12);
    expect(num(result.metrics.todayCallMinutesByCurrency.CNY)).toBe(9);
    expect(num(result.metrics.todayCallMinutesByCurrency.USD)).toBe(3);
    expect(result.metrics.tenantCount).toBe(6);

    expect(result.dailySpend).toHaveLength(30);
    expect(result.dailySpend[0]?.date).toBe('2027-02-14');
    expect(result.dailySpend.at(-1)?.date).toBe('2027-03-15');
    const byDate = new Map(result.dailySpend.map((day) => [day.date, day]));
    const spend = (date: string) => [
      num(byDate.get(date)!.CNY),
      num(byDate.get(date)!.USD),
    ];
    expect(spend('2027-02-14')).toEqual([7, 0]);
    expect(spend('2027-02-28')).toEqual([4, 0]);
    expect(spend('2027-03-01')).toEqual([3, 0]);
    expect(spend('2027-03-14')).toEqual([2, 0.25]);
    expect(spend('2027-03-15')).toEqual([1.5, 0.5]);
    expect(spend('2027-02-20')).toEqual([0, 0]);
    // 窗口外的 -9 不出现；30 天的和 = 7 + 4 + 3 + 2 + 1.5。
    expect(result.dailySpend.reduce((sum, day) => sum + num(day.CNY), 0)).toBe(
      17.5,
    );
  });

  it('ignores pending validation failures without a call time when finding the latest call', async () => {
    const { rows } = await database.owner.pool.query<{ n: number }>(
      "select count(*)::int as n from unassigned_cdrs where status = 'pending' and coalesce(answered_at, started_at) is null",
    );
    expect(rows[0]?.n).toBe(1);
    expect((await overview()).attention.unassigned.latestAt).toBe(
      '2027-03-15T03:00:00.000000Z',
    );
  });

  it('takes the Beijing day, not the UTC day, at the boundary', async () => {
    // UTC 2027-03-14 16:30 = 北京 2027-03-15 00:30：今天已经是 3 月 15 日。
    const result = await getAdminOverview(database.app.db, {
      now: new Date('2027-03-14T16:30:00.000Z'),
    });
    expect(result.dailySpend.at(-1)?.date).toBe('2027-03-15');
    expect(num(result.metrics.todaySpend.CNY)).toBe(1.5);
    // 北京 2027-03-14 23:59:59（UTC 15:59:59）还是 14 日。
    const before = await getAdminOverview(database.app.db, {
      now: new Date('2027-03-14T15:59:59.000Z'),
    });
    expect(before.dailySpend.at(-1)?.date).toBe('2027-03-14');
    expect(num(before.metrics.todaySpend.CNY)).toBe(2);
    expect(num(before.metrics.todaySpend.USD)).toBe(0.25);
  });
});

describe('与对应页面同源', () => {
  it('uses the receivable, tenant, unassigned and alert functions of the pages', async () => {
    await withSystem(database.app.db, async (tx) => {
      await raiseAlert(tx, {
        kind: 'cdr_failed',
        subjectKey: 'open-one',
        description: '进行中',
        at: ago(30), // 开始早于 24 小时，但进行中的永远算
      });
      await raiseAlert(tx, {
        kind: 'cdr_failed',
        subjectKey: 'recovered-recent',
        description: '刚恢复',
        at: ago(5),
      });
      await recoverAlert(tx, {
        kind: 'cdr_failed',
        subjectKey: 'recovered-recent',
        at: ago(4),
      });
      await raiseAlert(tx, {
        kind: 'cdr_failed',
        subjectKey: 'recovered-old',
        description: '早就恢复',
        at: ago(60),
      });
      await recoverAlert(tx, {
        kind: 'cdr_failed',
        subjectKey: 'recovered-old',
        at: ago(50),
      });
    });
    const result = await overview();
    await withAdmin(database.app.db, async (tx) => {
      const receivables = await readReceivableTotals(tx, { status: 'pending' });
      expect(result.metrics.pendingReceivable).toEqual(receivables.totals);
      const page = await listReceivables({
        db: tx,
        query: { status: 'pending', page: 1, pageSize: 25 },
      });
      expect(result.metrics.pendingReceivable).toEqual(page.totals);

      const status = async (
        health: 'suspended' | 'overdraft' | 'low_balance',
      ) =>
        (
          await listTenants({
            db: tx,
            query: {
              status: health,
              page: 1,
              pageSize: 25,
              sort: 'status_currency_balance',
            },
          })
        ).pagination.total;
      expect(await status('suspended')).toBe(1);
      expect(result.metrics.suspendedTenants).toBe(1);
      expect(result.metrics.suspendedTenantsByCurrency.CNY).toBe(1);
      expect(result.metrics.suspendedTenantsByCurrency.USD).toBe(0);
      expect(result.attention.suspended.total).toBe(1);
      expect(result.attention.suspended.items.map((item) => item.id)).toEqual([
        suspended.id,
      ]);
      // 余额不足含透支中：overdraft（CNY 租户与 USD 租户）+ low_balance。
      expect(await status('overdraft')).toBe(2);
      expect(await status('low_balance')).toBe(1);
      expect(result.attention.lowBalance.total).toBe(3);
      expect(
        result.attention.lowBalance.items.map((item) => item.health).sort(),
      ).toEqual(['low_balance', 'overdraft', 'overdraft']);

      expect(result.attention.unassigned.pending).toBe(
        (await readUnassignedSummary(tx)).pending,
      );
      expect(result.attention.unassigned.pending).toBe(4);
      expect(result.attention.unassigned.latestAt).toBe(
        '2027-03-15T03:00:00.000000Z',
      );
      expect(result.attention.suspended.items[0]?.suspendedAt).not.toBeNull();
      expect(
        result.attention.lowBalance.items.find((item) => item.id === low.id)
          ?.threshold,
      ).toBe('50');

      const day = await alertsInWindow(tx, {
        window: '24h',
        now: NOW,
        pageSize: 100,
      });
      expect(result.attention.alerts.last24h).toBe(day.total);
      expect(day.total).toBe(2); // 进行中的 + 刚恢复的；早就恢复的不算
      expect(result.attention.alerts.open).toBe(await countOpenAlerts(tx));
      expect(
        result.attention.alerts.items.map((item) => item.description),
      ).toEqual(['进行中', '刚恢复']);
      expect(result.attention.alerts.last24h).toBe(
        (await readAlertSummary(tx, { now: NOW })).last24h,
      );
    });
  });

  it('reads every part from one snapshot', async () => {
    const outcome = await withAdmin(
      database.app.db,
      async (tx) => {
        const first = await readAdminOverview(tx, { now: NOW });
        // 快照之后别的连接提交了一条新告警：同一事务里再读，页面函数看到的仍是快照。
        await withSystem(database.owner.db, (other) =>
          raiseAlert(other, {
            kind: 'audit_failed',
            subjectKey: 'after-the-snapshot',
            description: '快照之后',
            at: ago(1),
          }),
        );
        return {
          first,
          open: await countOpenAlerts(tx),
          last24h: (await alertsInWindow(tx, { window: '24h', now: NOW }))
            .total,
          again: await readAdminOverview(tx, { now: NOW }),
        };
      },
      { isolationLevel: 'repeatable read' },
    );
    expect(outcome.open).toBe(outcome.first.attention.alerts.open);
    expect(outcome.last24h).toBe(outcome.first.attention.alerts.last24h);
    expect(outcome.again).toEqual(outcome.first);
    // 新开事务才看得到那条告警：差的是时间，不是口径。
    const later = await overview();
    expect(later.attention.alerts.open).toBe(
      outcome.first.attention.alerts.open + 1,
    );
    expect(later.attention.alerts.last24h).toBe(
      outcome.first.attention.alerts.last24h + 1,
    );
  });

  it('reflects suspension and recovery timestamps in the overview', async () => {
    const tenant = await statementTenant(database.owner, { currency: 'CNY' });
    const before = await overview();
    expect(
      before.attention.suspended.items.find((item) => item.id === tenant.id),
    ).toBeUndefined();
    await database.owner.pool.query(
      'update tenant_balances set balance = -100 where tenant_id = $1',
      [tenant.id],
    );
    const suspendedView = await overview();
    const item = suspendedView.attention.suspended.items.find(
      (entry) => entry.id === tenant.id,
    );
    const state = await database.owner.pool.query<{ suspended_at: Date }>(
      'select suspended_at from balance_notice_state where tenant_id = $1',
      [tenant.id],
    );
    expect(item?.suspendedAt).not.toBeNull();
    expect(new Date(item!.suspendedAt!).getTime()).toBe(
      state.rows[0]!.suspended_at.getTime(),
    );
    await database.owner.pool.query(
      'update tenant_balances set balance = -99 where tenant_id = $1',
      [tenant.id],
    );
    const recoveredView = await overview();
    expect(
      recoveredView.attention.suspended.items.find(
        (entry) => entry.id === tenant.id,
      ),
    ).toBeUndefined();
    expect(
      recoveredView.attention.lowBalance.items.find(
        (entry) => entry.id === tenant.id,
      )?.suspendedAt,
    ).toBeNull();
  });

  it('lists attention tenants in the same order as the tenant list', async () => {
    const result = await overview();
    const list = await listTenants({
      db: database.app.db,
      query: { page: 1, pageSize: 100, sort: 'status_currency_balance' },
    });
    const wanted = list.items.filter((item) =>
      ['overdraft', 'low_balance'].includes(item.health),
    );
    expect(result.attention.lowBalance.items.map((item) => item.id)).toEqual(
      wanted.slice(0, 5).map((item) => item.id),
    );
    expect(result.attention.lowBalance.items[0]).toMatchObject({
      balance: wanted[0]!.balance,
      availableBalance: wanted[0]!.availableBalance,
    });
    expect(normal.id).not.toBe(low.id);
  });
});
