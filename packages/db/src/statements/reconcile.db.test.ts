import { beforeAll, describe, expect, it } from 'vitest';
import { adminId, connections, pgError } from '../../test/support.js';
import {
  ensureStatementPartitions,
  statementCall,
  statementLedger,
  statementTenant,
} from '../../test/statements.js';
import { withAdmin, withSystem } from '../client.js';
import {
  generateStatement,
  reconcileTenantStatements,
  regenerateStatement,
  readStatement,
} from './index.js';

const { app, owner } = connections();
let administrator: string;
beforeAll(async () => {
  administrator = await adminId(owner);
  await ensureStatementPartitions(app);
});

const snapshot = { isolationLevel: 'repeatable read' } as const;
const generate = (tenant: string, month: string) =>
  withSystem(app.db, (tx) => generateStatement(tx, tenant, month), snapshot);
const reconcile = (tenant: string) =>
  withSystem(app.db, (tx) => reconcileTenantStatements(tx, tenant), snapshot);
const read = (tenant: string, month: string) =>
  withAdmin(app.db, (tx) => readStatement(tx, tenant, month));
const alerts = async (tenant: string) =>
  (
    await owner.pool.query<{
      description: string;
      affected_calls: number;
      recovered: boolean;
    }>(
      `select description, affected_calls, recovered_at is not null as recovered
       from system_alerts where tenant_id = $1 and kind = 'statement_mismatch'
       order by started_at, description`,
      [tenant],
    )
  ).rows;

/** 8、9 月都有账单、账本一致的租户。 */
async function reconciledTenant() {
  const tenant = await statementTenant(owner, {
    createdAt: '2026-08-01 08:00:00',
  });
  await statementLedger(
    owner,
    tenant.id,
    'recharge',
    '100',
    '2026-08-02 09:00:00',
    {
      adminId: administrator,
    },
  );
  await statementCall(owner, tenant.id, {
    answeredAt: '2026-08-10 10:00:00',
    charge: '2',
  });
  await statementCall(owner, tenant.id, {
    answeredAt: '2026-09-10 10:00:00',
    charge: '3',
  });
  await generate(tenant.id, '2026-08-01');
  await generate(tenant.id, '2026-09-01');
  return tenant;
}

describe('账单核对（验收标准 2）', () => {
  it('marks a statement ok when closing and opening equal the ledger', async () => {
    const tenant = await reconciledTenant();
    const result = await reconcile(tenant.id);
    expect(result.statements.map((s) => [s.month, s.status, s.diff])).toEqual([
      ['2026-08-01', 'ok', '0'],
      ['2026-09-01', 'ok', '0'],
    ]);
    expect(result).toMatchObject({
      missing: [],
      alertsOpened: 0,
      alertsUpdated: 0,
      alertsRecovered: 0,
    });
    const stored = (await read(tenant.id, '2026-09-01'))!;
    expect(stored).toMatchObject({
      reconcileStatus: 'ok',
      reconcileDiff: '0',
    });
    expect(stored.reconciledAt).toBeInstanceOf(Date);
    expect(await alerts(tenant.id)).toEqual([]);
  });

  it('checks the seeded ABC001 statements against the ledger', async () => {
    const abc001 = (
      await owner.pool.query<{ id: string }>(
        "select id from tenants where code = 'ABC001'",
      )
    ).rows[0]!.id;
    const result = await reconcile(abc001);
    expect(result.statements.map((s) => [s.month, s.status])).toEqual([
      ['2026-08-01', 'ok'],
      ['2026-09-01', 'ok'],
    ]);
    expect(result.missing).toEqual([]);
  });

  it('flags a call charge written after generation as stale and opens one alert', async () => {
    const tenant = await reconciledTenant();
    // 9 月的一通电话，扣费在生成之后才补写。
    await statementCall(owner, tenant.id, {
      answeredAt: '2026-09-20 10:00:00',
      charge: '4',
      ledgerCreatedAt: 'now',
    });
    const result = await reconcile(tenant.id);
    expect(
      result.statements.map((s) => [s.month, s.status, s.diff, s.lateEntries]),
    ).toEqual([
      ['2026-08-01', 'ok', '0', 0],
      ['2026-09-01', 'stale', '-4', 1],
    ]);
    expect(result).toMatchObject({ alertsOpened: 1 });
    const stored = (await read(tenant.id, '2026-09-01'))!;
    expect(stored).toMatchObject({
      reconcileStatus: 'stale',
      reconcileDiff: '-4',
    });
    expect(await alerts(tenant.id)).toEqual([
      {
        description: `${tenant.code} 2026-09 账单与流水不一致（stale），差额 -4`,
        affected_calls: 1,
        recovered: false,
      },
    ]);
  });

  it('marks the following month stale when its opening balance no longer matches', async () => {
    const tenant = await reconciledTenant();
    await statementCall(owner, tenant.id, {
      answeredAt: '2026-08-20 10:00:00',
      charge: '1',
      ledgerCreatedAt: 'now',
    });
    const result = await reconcile(tenant.id);
    expect(result.statements.map((s) => [s.month, s.status, s.diff])).toEqual([
      ['2026-08-01', 'stale', '-1'],
      ['2026-09-01', 'stale', '-1'],
    ]);
    expect(await alerts(tenant.id)).toHaveLength(2);
    // 只重新生成 8 月：8 月恢复，9 月的期初仍过期。
    await withAdmin(
      app.db,
      (tx) =>
        regenerateStatement(tx, tenant.id, '2026-08-01', {
          expectedVersion: 1,
          adminId: administrator,
        }),
      snapshot,
    );
    const after = await reconcile(tenant.id);
    expect(after.statements.map((s) => [s.month, s.status])).toEqual([
      ['2026-08-01', 'ok'],
      ['2026-09-01', 'stale'],
    ]);
    expect(after).toMatchObject({ alertsRecovered: 1, alertsOpened: 0 });
  });

  it('flags a closing that differs without late entries as inconsistent', async () => {
    const tenant = await reconciledTenant();
    // 生成之前就已写入、却不在账单里的流水：补推解释不了，说明账单或账本被绕过应用改过。
    await statementLedger(
      owner,
      tenant.id,
      'gift',
      '7',
      '2026-09-15 10:00:00',
      {
        adminId: administrator,
        createdAt: '2026-09-15 10:00:00',
      },
    );
    const result = await reconcile(tenant.id);
    expect(
      result.statements.map((s) => [s.month, s.status, s.diff, s.lateEntries]),
    ).toEqual([
      ['2026-08-01', 'ok', '0', 0],
      ['2026-09-01', 'inconsistent', '7', 0],
    ]);
    expect(await alerts(tenant.id)).toEqual([
      {
        description: `${tenant.code} 2026-09 账单与流水不一致（inconsistent），差额 7`,
        affected_calls: 0,
        recovered: false,
      },
    ]);
  });

  it('opens one alert per tenant and month across reruns, updating it when the difference changes', async () => {
    const tenant = await reconciledTenant();
    await statementCall(owner, tenant.id, {
      answeredAt: '2026-09-20 10:00:00',
      charge: '4',
      ledgerCreatedAt: 'now',
    });
    expect((await reconcile(tenant.id)).alertsOpened).toBe(1);
    expect(await reconcile(tenant.id)).toMatchObject({
      alertsOpened: 0,
      alertsUpdated: 0,
      alertsRecovered: 0,
    });
    // 又迟到一笔：差额变了，仍是同一条告警，描述与影响笔数更新。
    await statementCall(owner, tenant.id, {
      answeredAt: '2026-09-21 10:00:00',
      charge: '1',
      ledgerCreatedAt: 'now',
    });
    expect(await reconcile(tenant.id)).toMatchObject({
      alertsOpened: 0,
      alertsUpdated: 1,
    });
    const open = await alerts(tenant.id);
    expect(open).toHaveLength(1);
    expect(open[0]).toEqual({
      description: `${tenant.code} 2026-09 账单与流水不一致（stale），差额 -5`,
      affected_calls: 2,
      recovered: false,
    });
  });

  it('recovers the alert after regeneration', async () => {
    const tenant = await reconciledTenant();
    await statementCall(owner, tenant.id, {
      answeredAt: '2026-09-20 10:00:00',
      charge: '4',
      ledgerCreatedAt: 'now',
    });
    await reconcile(tenant.id);
    expect((await alerts(tenant.id))[0]!.recovered).toBe(false);
    const regenerated = await withAdmin(
      app.db,
      (tx) =>
        regenerateStatement(tx, tenant.id, '2026-09-01', {
          expectedVersion: 1,
          adminId: administrator,
        }),
      snapshot,
    );
    // 重新生成把核对状态复位；告警在下一轮核对通过时恢复。
    expect(regenerated.statement).toMatchObject({
      reconcileStatus: 'unchecked',
    });
    expect((await alerts(tenant.id))[0]!.recovered).toBe(false);
    const result = await reconcile(tenant.id);
    expect(result).toMatchObject({ alertsRecovered: 1, alertsOpened: 0 });
    expect(await alerts(tenant.id)).toEqual([
      expect.objectContaining({ recovered: true }),
    ]);
    expect((await read(tenant.id, '2026-09-01'))!.reconcileStatus).toBe('ok');
    // 恢复之后再核对仍是 ok，不开新告警。
    expect((await reconcile(tenant.id)).alertsOpened).toBe(0);
  });

  it('reports a missing statement, opens an alert and recovers it once the statement exists', async () => {
    const tenant = await statementTenant(owner, {
      createdAt: '2026-08-01 08:00:00',
    });
    await generate(tenant.id, '2026-08-01');
    // 9 月应有而没有。
    const result = await reconcile(tenant.id);
    expect(result.missing.slice(0, 1)).toEqual(['2026-09-01']);
    expect(result.statements.map((s) => s.status)).toEqual(['ok']);
    const open = await alerts(tenant.id);
    expect(open.map((a) => a.description)).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/ 2026-09 账单与流水不一致（missing）$/),
      ]),
    );
    await generate(tenant.id, '2026-09-01');
    const later = await reconcile(tenant.id);
    expect(later.alertsRecovered).toBeGreaterThanOrEqual(1);
    expect(
      (await alerts(tenant.id)).find((a) =>
        a.description.includes(' 2026-09 '),
      ),
    ).toMatchObject({ recovered: true });
  });

  it('checks details-deleted months against the ledger without the breakdown gap', async () => {
    const tenant = await reconciledTenant();
    await owner.pool.query(
      'update monthly_statements set details_deleted = true where tenant_id = $1 and month = $2',
      [tenant.id, '2026-09-01'],
    );
    // 流水完整，所以话单已删除的月份仍然检查期初与期末；只有明细缺口不再检查（核对本来就不看话单）。
    const ok = await reconcile(tenant.id);
    expect(ok.statements.map((s) => s.status)).toEqual(['ok', 'ok']);
    await statementLedger(
      owner,
      tenant.id,
      'gift',
      '7',
      '2026-09-15 10:00:00',
      {
        adminId: administrator,
        createdAt: '2026-09-15 10:00:00',
      },
    );
    const bad = await reconcile(tenant.id);
    expect(bad.statements.map((s) => s.status)).toEqual(['ok', 'inconsistent']);
    // 核对列可写，其余仍冻结。
    expect(await read(tenant.id, '2026-09-01')).toMatchObject({
      detailsDeleted: true,
      reconcileStatus: 'inconsistent',
    });
  });

  it('system_alerts accepts statement_mismatch and still rejects unknown kinds', async () => {
    const tenant = await statementTenant(owner);
    await owner.pool.query(
      `insert into system_alerts (tenant_id, kind, description) values ($1, 'statement_mismatch', 'x')`,
      [tenant.id],
    );
    for (const kind of [
      'cdr_failed',
      'partition_failed',
      'auth_timeout',
      'email_failed',
    ]) {
      await owner.pool.query(
        `insert into system_alerts (tenant_id, kind, description) values ($1, $2, 'x')`,
        [tenant.id, kind],
      );
    }
    expect(
      await pgError(
        owner.pool.query(
          `insert into system_alerts (tenant_id, kind, description) values ($1, 'other', 'x')`,
          [tenant.id],
        ),
      ),
    ).toMatchObject({ code: '23514', constraint: 'system_alerts_kind_check' });
  });
});
