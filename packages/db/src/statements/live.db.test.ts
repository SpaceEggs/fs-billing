import { beforeAll, describe, expect, it } from 'vitest';
import { decimal } from '@fs-billing/rating';
import { adminId, connections } from '../../test/support.js';
import {
  ensureStatementPartitions,
  statementCall,
  statementLedger,
  statementTenant,
} from '../../test/statements.js';
import { withAdmin, withSystem, withTenant } from '../client.js';
import { NotFoundError } from '../errors.js';
import { readTenantUsageOverview } from '../usage.js';
import {
  computeStatement,
  currentStatementMonth,
  generateStatement,
  readLiveStatement,
} from './index.js';

const { app, owner } = connections();
let administrator: string;
beforeAll(async () => {
  administrator = await adminId(owner);
  await ensureStatementPartitions(app);
});

const snapshot = { isolationLevel: 'repeatable read' } as const;

describe('实时（进行中）月份', () => {
  it('matches the home month spend for the current month', async () => {
    const month = await withAdmin(app.db, (tx) => currentStatementMonth(tx));
    const tenant = await statementTenant(owner, {
      createdAt: '2026-07-01 08:00:00',
    });
    await statementLedger(
      owner,
      tenant.id,
      'recharge',
      '200',
      '2026-08-15 10:00:00',
      {
        adminId: administrator,
      },
    );
    // 本月月初后一秒的两笔扣费和一笔赠送，一定早于“现在”。
    await statementLedger(owner, tenant.id, 'gift', '10', `${month} 00:00:01`, {
      adminId: administrator,
    });
    await statementCall(owner, tenant.id, {
      answeredAt: `${month} 00:00:02`,
      minutes: '3',
      charge: '5.25',
    });
    await statementCall(owner, tenant.id, {
      answeredAt: `${month} 00:00:03`,
      minutes: '1',
      charge: '0.05',
    });

    const { live, home, viaTenant } = await withTenant(
      app.db,
      tenant.id,
      async (tx) => ({
        live: await readLiveStatement(tx, tenant.id, month),
        home: await readTenantUsageOverview(tx, tenant.id),
        viaTenant: await computeStatement(tx, tenant.id, month, {
          asOf: new Date(),
          opening: 'ledger',
        }),
      }),
    );
    expect(live).not.toBeNull();
    expect(live).toMatchObject({
      month,
      state: 'in_progress',
      statement: {
        openingBalance: '200',
        gift: '10',
        callCharges: '5.3',
        calls: 2,
        callMinutes: '4',
        closingBalance: '204.7',
        breakdownGap: '0',
      },
    });
    expect(decimal(live!.statement.callCharges).eq(home.monthSpend)).toBe(true);
    // 余额锚点与月初前流水合计得到同一个期初。
    expect(viaTenant.openingBalance).toBe(live!.statement.openingBalance);
    expect(live!.asOf.getTime()).toBeLessThanOrEqual(Date.now() + 1000);
  });

  it('honors a fixed asOf: later entries are not counted', async () => {
    const tenant = await statementTenant(owner, {
      createdAt: '2026-09-01 08:00:00',
    });
    await statementCall(owner, tenant.id, {
      answeredAt: '2026-09-10 10:00:00',
      charge: '1',
    });
    await statementCall(owner, tenant.id, {
      answeredAt: '2026-09-20 10:00:00',
      charge: '2',
    });
    // 以 9 月 15 日为“现在”，9 月就是进行中的月份。
    const live = await withAdmin(app.db, (tx) =>
      readLiveStatement(tx, tenant.id, '2026-09-01', {
        asOf: new Date('2026-09-15T12:00:00+08:00'),
      }),
    );
    expect(live).toMatchObject({
      state: 'in_progress',
      statement: { callCharges: '1', calls: 1, closingBalance: '-1' },
    });
    expect(live!.statement.days.map((d) => d.day)).toEqual(['2026-09-10']);
  });

  it('computes a pending month between midnight and generation', async () => {
    const tenant = await statementTenant(owner, {
      createdAt: '2026-08-20 08:00:00',
    });
    await statementLedger(
      owner,
      tenant.id,
      'recharge',
      '30',
      '2026-08-21 10:00:00',
      {
        adminId: administrator,
      },
    );
    await statementCall(owner, tenant.id, {
      answeredAt: '2026-09-10 10:00:00',
      minutes: '2',
      charge: '0.4',
    });
    const pending = await withAdmin(app.db, (tx) =>
      readLiveStatement(tx, tenant.id, '2026-09-01'),
    );
    expect(pending).toMatchObject({
      month: '2026-09-01',
      state: 'pending',
      statement: {
        openingBalance: '30',
        callCharges: '0.4',
        closingBalance: '29.6',
        calls: 1,
      },
    });
    // 生成之后月份有了账单行：不再实时计算，数字与生成一致。
    const generated = await withSystem(
      app.db,
      (tx) => generateStatement(tx, tenant.id, '2026-09-01'),
      snapshot,
    );
    if (generated.outcome !== 'created') throw new Error('期望新建账单');
    expect(generated.statement).toMatchObject(pending!.statement);
    expect(
      await withAdmin(app.db, (tx) =>
        readLiveStatement(tx, tenant.id, '2026-09-01'),
      ),
    ).toBeNull();
  });

  it('rejects an unknown tenant and a month after the current one', async () => {
    const tenant = await statementTenant(owner);
    await expect(
      withAdmin(app.db, (tx) =>
        readLiveStatement(
          tx,
          '00000000-0000-4000-8000-000000000000',
          '2026-09-01',
        ),
      ),
    ).rejects.toBeInstanceOf(NotFoundError);
    await expect(
      withAdmin(app.db, (tx) => readLiveStatement(tx, tenant.id, '2099-01-01')),
    ).rejects.toThrow('晚于当前北京月');
    const { rows } = await owner.pool.query(
      'select count(*)::int as n from monthly_statements where tenant_id = $1',
      [tenant.id],
    );
    expect(rows).toEqual([{ n: 0 }]);
  });

  it('is read only: a tenant identity can run it and nothing is written', async () => {
    const tenant = await statementTenant(owner, {
      createdAt: '2026-09-01 08:00:00',
    });
    const before = await owner.pool.query(
      'select (select count(*) from monthly_statements) as s, (select count(*) from monthly_statement_days) as d',
    );
    await withTenant(app.db, tenant.id, (tx) =>
      readLiveStatement(tx, tenant.id, '2026-09-01'),
    );
    const after = await owner.pool.query(
      'select (select count(*) from monthly_statements) as s, (select count(*) from monthly_statement_days) as d',
    );
    expect(after.rows).toEqual(before.rows);
  });
});
