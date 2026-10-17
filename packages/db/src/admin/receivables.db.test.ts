import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  adminConfirmPaymentResponseSchema,
  adminReversePaymentResponseSchema,
  adminVoidReceivableResponseSchema,
  auditPayloadSchema,
} from '@fs-billing/shared';
import { money } from '@fs-billing/rating';
import {
  adminId,
  connections,
  createTenant,
  deferred,
  pgError,
} from '../../test/support.js';
import { lockTenants, withAdmin, withTenant } from '../client.js';
import { appendLedgerEntry } from '../ledger.js';
import {
  receivables,
  receivableSettlementReversals,
  receivableVoids,
} from '../schema.js';
import {
  confirmPayment,
  reversePayment,
  voidReceivable,
} from './receivables.js';

const { app, owner } = connections();
let actor: { id: string; name: string };
beforeAll(async () => {
  actor = { id: await adminId(owner), name: '王敏' };
});

function beijingDate() {
  return new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

async function fixture(currency: 'CNY' | 'USD' = 'CNY') {
  const tenant = await createTenant(app, currency);
  const credit = await withAdmin(app.db, (tx) =>
    appendLedgerEntry(tx, tenant, {
      kind: 'credit_recharge',
      amount: money(currency, '500'),
      note: '内部赊账备注',
      adminId: actor.id,
      idempotencyKey: randomUUID(),
    }),
  );
  const input = { db: app.db, actor, ledgerEntryId: credit.id };
  const confirm = (expectedLatestSettlementId: string | null = null) =>
    confirmPayment({
      ...input,
      request: {
        expectedLatestSettlementId,
        receivedOn: beijingDate(),
        note: '全额银行转账',
      },
    });
  const reverse = (settlementId: string) =>
    reversePayment({ ...input, request: { settlementId, reason: '误确认' } });
  const voidCredit = (adjustmentLedgerEntryId: string) =>
    voidReceivable({
      ...input,
      request: { adjustmentLedgerEntryId, reason: '重复赊账' },
    });
  const state = async () =>
    (
      await withAdmin(app.db, (tx) =>
        tx
          .select()
          .from(receivables)
          .where(eq(receivables.ledgerEntryId, credit.id)),
      )
    )[0]!;
  return { tenant, credit, input, confirm, reverse, voidCredit, state };
}

async function adjustment(
  f: Awaited<ReturnType<typeof fixture>>,
  amount = '-500',
  at?: string,
) {
  return withAdmin(owner.db, async (tx) => {
    await lockTenants(tx, [f.tenant.id]);
    const { rows } = await tx.execute<{ id: string }>(sql`
      with instant as materialized (select coalesce(${at ?? null}::timestamptz, clock_timestamp()) as moment)
      insert into ledger_entries (tenant_id, kind, amount, note, created_by, idempotency_key, created_at, occurred_at)
      select ${f.tenant.id}, 'adjustment', ${amount}::numeric, '人工冲正', ${actor.id}, ${randomUUID()}, moment, moment from instant returning id
    `);
    return rows[0]!.id;
  });
}

async function counts(f: Awaited<ReturnType<typeof fixture>>) {
  return z
    .object({
      settlements: z.number().int(),
      reversals: z.number().int(),
      voids: z.number().int(),
      audits: z.number().int(),
      balance: z.string(),
    })
    .parse(
      (
        await owner.pool.query(
          `select
    (select count(*)::int from receivable_settlements where ledger_entry_id = $1) as settlements,
    (select count(*)::int from receivable_settlement_reversals where tenant_id = $2) as reversals,
    (select count(*)::int from receivable_voids where tenant_id = $2) as voids,
    (select count(*)::int from operation_logs where tenant_id = $2) as audits,
    (select balance::text from tenant_balances where tenant_id = $2) as balance`,
          [f.credit.id, f.tenant.id],
        )
      ).rows[0],
    );
}

describe('admin receivable event services against Postgres', () => {
  it.each(['CNY', 'USD'] as const)(
    'confirms, reverses and reconfirms %s without changing the ledger or balance',
    async (currency) => {
      const f = await fixture(currency);
      expect(await f.state()).toMatchObject({
        status: 'pending',
        latestSettlementId: null,
      });
      const confirmed = adminConfirmPaymentResponseSchema.parse(
        await f.confirm(),
      );
      expect(await f.state()).toMatchObject({
        status: 'received',
        settlementId: confirmed.settlementId,
        latestSettlementId: confirmed.settlementId,
        settlementNote: '全额银行转账',
        confirmedBy: actor.id,
      });
      await expect(f.confirm(randomUUID())).rejects.toMatchObject({
        code: 'ALREADY_RECEIVED',
      });
      adminReversePaymentResponseSchema.parse(
        await f.reverse(confirmed.settlementId),
      );
      expect(await f.state()).toMatchObject({
        status: 'pending',
        settlementId: null,
        latestSettlementId: confirmed.settlementId,
      });
      await expect(f.reverse(confirmed.settlementId)).rejects.toMatchObject({
        code: 'SETTLEMENT_CONFLICT',
      });
      await expect(f.confirm()).rejects.toMatchObject({
        code: 'SETTLEMENT_CONFLICT',
      });
      const reconfirmed = await f.confirm(confirmed.settlementId);
      expect(reconfirmed.settlementId).not.toBe(confirmed.settlementId);
      await expect(f.reverse(confirmed.settlementId)).rejects.toMatchObject({
        code: 'SETTLEMENT_CONFLICT',
      });
      expect(await f.state()).toMatchObject({
        status: 'received',
        latestSettlementId: reconfirmed.settlementId,
        settlementId: reconfirmed.settlementId,
      });
      expect(await counts(f)).toEqual({
        settlements: 2,
        reversals: 1,
        voids: 0,
        audits: 3,
        balance: '500',
      });
      expect(
        (
          await owner.pool.query(
            'select kind, amount::text, note from ledger_entries where id = $1',
            [f.credit.id],
          )
        ).rows,
      ).toEqual([
        { kind: 'credit_recharge', amount: '500', note: '内部赊账备注' },
      ]);
      const logs = z
        .array(
          z.object({
            id: z.uuid(),
            admin_id: z.uuid(),
            created_at: z.date(),
            tenant_id: z.uuid(),
            action: z.string(),
            details: z.object({
              actor: z.unknown(),
              target: z.unknown(),
              content: z.unknown(),
            }),
          }),
        )
        .parse(
          (
            await owner.pool.query(
              'select * from operation_logs where tenant_id = $1 order by created_at, id',
              [f.tenant.id],
            )
          ).rows,
        );
      expect(logs.map((log) => log.action)).toEqual([
        'receivable_confirm',
        'receivable_payment_reverse',
        'receivable_confirm',
      ]);
      for (const log of logs) {
        expect(log.admin_id).toBe(actor.id);
        expect(
          auditPayloadSchema.parse({
            id: log.id,
            actor: log.details.actor,
            occurredAt: log.created_at.toISOString(),
            tenantId: log.tenant_id,
            target: log.details.target,
            action: log.action,
            content: log.details.content,
          }),
        ).toMatchObject({
          actor,
          tenantId: f.tenant.id,
          target: { kind: 'receivable', id: f.credit.id },
          content: { amount: '500', currency },
        });
      }
    },
  );

  it('uses a fresh event timestamp after an older outer transaction waits', async () => {
    const f = await fixture();
    const started = deferred();
    const continueTx = deferred<string>();
    const oldTransaction = withAdmin(app.db, async (tx) => {
      await tx.execute(sql`select now()`);
      started.resolve();
      const expected = await continueTx.promise;
      return confirmPayment({
        ...f.input,
        db: tx,
        request: {
          expectedLatestSettlementId: expected,
          receivedOn: beijingDate(),
          note: '',
        },
      });
    });
    await started.promise;
    try {
      const first = await f.confirm();
      await f.reverse(first.settlementId);
      continueTx.resolve(first.settlementId);
      const second = await oldTransaction;
      expect(await f.state()).toMatchObject({
        status: 'received',
        latestSettlementId: second.settlementId,
        settlementId: second.settlementId,
      });
    } finally {
      continueTx.resolve(randomUUID());
      await oldTransaction.catch(() => undefined);
    }
  });

  it('serializes concurrent confirmations and concurrent reversals without duplicate audits', async () => {
    const f = await fixture();
    const confirmations = await Promise.allSettled([f.confirm(), f.confirm()]);
    expect(confirmations.filter((r) => r.status === 'fulfilled')).toHaveLength(
      1,
    );
    expect(confirmations.filter((r) => r.status === 'rejected')).toMatchObject([
      { reason: { code: 'ALREADY_RECEIVED' } },
    ]);
    const current = await f.state();
    const reversals = await Promise.allSettled([
      f.reverse(current.settlementId!),
      f.reverse(current.settlementId!),
    ]);
    expect(reversals.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(reversals.filter((r) => r.status === 'rejected')).toMatchObject([
      { reason: { code: 'SETTLEMENT_CONFLICT' } },
    ]);
    expect(await counts(f)).toEqual({
      settlements: 1,
      reversals: 1,
      voids: 0,
      audits: 2,
      balance: '500',
    });
  });

  it('requires current tokens and rejects another credit settlement on reversal', async () => {
    const f = await fixture();
    const other = await fixture();
    const confirmed = await other.confirm();
    await expect(f.confirm(randomUUID())).rejects.toMatchObject({
      code: 'SETTLEMENT_CONFLICT',
    });
    await expect(f.reverse(confirmed.settlementId)).rejects.toMatchObject({
      code: 'SETTLEMENT_CONFLICT',
    });
    expect(await counts(f)).toMatchObject({
      settlements: 0,
      reversals: 0,
      audits: 0,
    });
  });

  it('rejects receipt dates before the Beijing credit date and future dates', async () => {
    const f = await fixture();
    await expect(
      confirmPayment({
        ...f.input,
        request: {
          expectedLatestSettlementId: null,
          receivedOn: '2000-01-01',
          note: '',
        },
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    await expect(
      confirmPayment({
        ...f.input,
        request: {
          expectedLatestSettlementId: null,
          receivedOn: '2099-01-01',
          note: '',
        },
      }),
    ).rejects.toThrow();
    expect(await counts(f)).toMatchObject({ settlements: 0, audits: 0 });
  });

  it('returns NOT_FOUND for missing and non-credit entries', async () => {
    const f = await fixture();
    const adj = await adjustment(f);
    for (const id of [randomUUID(), adj]) {
      await expect(
        confirmPayment({
          ...f.input,
          ledgerEntryId: id,
          request: {
            expectedLatestSettlementId: null,
            receivedOn: beijingDate(),
            note: '',
          },
        }),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    }
  });

  it('rolls back the event when audit validation fails and rolls back a nested service with its outer transaction', async () => {
    const f = await fixture();
    await expect(
      confirmPayment({
        ...f.input,
        actor: { ...actor, name: '' },
        request: {
          expectedLatestSettlementId: null,
          receivedOn: beijingDate(),
          note: '',
        },
      }),
    ).rejects.toThrow();
    await expect(
      withAdmin(app.db, async (tx) => {
        await confirmPayment({
          ...f.input,
          db: tx,
          request: {
            expectedLatestSettlementId: null,
            receivedOn: beijingDate(),
            note: '',
          },
        });
        throw new Error('abort outer transaction');
      }),
    ).rejects.toThrow('abort outer transaction');
    expect(await counts(f)).toEqual({
      settlements: 0,
      reversals: 0,
      voids: 0,
      audits: 0,
      balance: '500',
    });
  });

  it('does not automatically close a credit on adjustment; void requires reversal first and wins error precedence', async () => {
    const f = await fixture();
    const first = await f.confirm();
    const adj = await adjustment(f);
    expect(await f.state()).toMatchObject({ status: 'received' });
    await expect(f.voidCredit(randomUUID())).rejects.toMatchObject({
      code: 'ALREADY_RECEIVED',
    });
    await f.reverse(first.settlementId);
    adminVoidReceivableResponseSchema.parse(await f.voidCredit(adj));
    expect(await f.state()).toMatchObject({
      status: 'voided',
      latestSettlementId: first.settlementId,
      adjustmentLedgerEntryId: adj,
      voidedBy: actor.id,
      voidReason: '重复赊账',
    });
    await expect(f.confirm()).rejects.toMatchObject({
      code: 'RECEIVABLE_VOIDED',
    });
    await expect(f.reverse(randomUUID())).rejects.toMatchObject({
      code: 'RECEIVABLE_VOIDED',
    });
    await expect(f.voidCredit(randomUUID())).rejects.toMatchObject({
      code: 'RECEIVABLE_VOIDED',
    });
    expect(await counts(f)).toEqual({
      settlements: 1,
      reversals: 1,
      voids: 1,
      audits: 3,
      balance: '0',
    });
    await adjustment(f, '500');
    expect(await f.state()).toMatchObject({ status: 'voided' });
  });

  it('rolls back reversals and voids when their audit cannot be written', async () => {
    const f = await fixture();
    const confirmed = await f.confirm();
    const invalidActor = { ...actor, name: '' };
    await expect(
      reversePayment({
        ...f.input,
        actor: invalidActor,
        request: { settlementId: confirmed.settlementId, reason: '误确认' },
      }),
    ).rejects.toThrow();
    expect(await f.state()).toMatchObject({ status: 'received' });
    expect(await counts(f)).toMatchObject({ reversals: 0, audits: 1 });

    await f.reverse(confirmed.settlementId);
    const adj = await adjustment(f);
    await expect(
      voidReceivable({
        ...f.input,
        actor: invalidActor,
        request: { adjustmentLedgerEntryId: adj, reason: '重复赊账' },
      }),
    ).rejects.toThrow();
    expect(await f.state()).toMatchObject({ status: 'pending' });
    expect(await counts(f)).toEqual({
      settlements: 1,
      reversals: 1,
      voids: 0,
      audits: 2,
      balance: '0',
    });
  });

  it('rejects wrong amount, kind, tenant, missing adjustment and an earlier adjustment', async () => {
    const f = await fixture();
    const other = await fixture();
    const ids = [
      randomUUID(),
      f.credit.id,
      await adjustment(f, '-499.9999'),
      await adjustment(other),
      await adjustment(f, '-500', '2000-01-01T00:00:00Z'),
    ];
    for (const id of ids)
      await expect(f.voidCredit(id)).rejects.toMatchObject({
        code: 'RECEIVABLE_REVERSAL_MISMATCH',
      });
    expect(await counts(f)).toMatchObject({ voids: 0, audits: 0 });
  });

  it('compares exact PostgreSQL timestamp precision and rejects equal creation times', async () => {
    const f = await fixture();
    const exact = (
      await owner.pool.query<{ stamp: string }>(
        'select created_at::text as stamp from ledger_entries where id=$1',
        [f.credit.id],
      )
    ).rows[0]!.stamp;
    const equal = await adjustment(f, '-500', exact);
    await expect(f.voidCredit(equal)).rejects.toMatchObject({
      code: 'RECEIVABLE_REVERSAL_MISMATCH',
    });
    const later = (
      await owner.pool.query<{ stamp: string }>(
        "select (created_at + interval '1 microsecond')::text as stamp from ledger_entries where id=$1",
        [f.credit.id],
      )
    ).rows[0]!.stamp;
    const adj = await adjustment(f, '-500', later);
    await f.voidCredit(adj);
    expect(await f.state()).toMatchObject({
      status: 'voided',
      adjustmentLedgerEntryId: adj,
    });
  });

  it('rejects reused adjustments and conservatively rejects opposite later or equal-time adjustments', async () => {
    const f = await fixture();
    const secondCredit = await withAdmin(app.db, (tx) =>
      appendLedgerEntry(tx, f.tenant, {
        kind: 'credit_recharge',
        amount: money('CNY', '500'),
        note: '',
        adminId: actor.id,
        idempotencyKey: randomUUID(),
      }),
    );
    const adj = await adjustment(f);
    await f.voidCredit(adj);
    await expect(
      voidReceivable({
        ...f.input,
        ledgerEntryId: secondCredit.id,
        request: { adjustmentLedgerEntryId: adj, reason: '复用' },
      }),
    ).rejects.toMatchObject({ code: 'RECEIVABLE_REVERSAL_MISMATCH' });
    for (const sameTime of [false, true]) {
      const g = await fixture();
      const candidate = await adjustment(g);
      const stamp = (
        await owner.pool.query<{ stamp: string }>(
          'select created_at::text as stamp from ledger_entries where id=$1',
          [candidate],
        )
      ).rows[0]!.stamp;
      await adjustment(g, '500', sameTime ? stamp : undefined);
      await expect(g.voidCredit(candidate)).rejects.toMatchObject({
        code: 'RECEIVABLE_REVERSAL_MISMATCH',
      });
      expect(await counts(g)).toMatchObject({ voids: 0, audits: 0 });
    }
  });

  it('concurrent voids produce one event and one complete audit', async () => {
    const f = await fixture();
    const adj = await adjustment(f);
    const results = await Promise.allSettled([
      f.voidCredit(adj),
      f.voidCredit(adj),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'rejected')).toMatchObject([
      { reason: { code: 'RECEIVABLE_VOIDED' } },
    ]);
    expect(await counts(f)).toEqual({
      settlements: 0,
      reversals: 0,
      voids: 1,
      audits: 1,
      balance: '0',
    });
    const { rows } = await owner.pool.query<{ details: unknown }>(
      'select details from operation_logs where tenant_id=$1',
      [f.tenant.id],
    );
    expect(rows).toMatchObject([
      {
        details: {
          actor,
          target: { kind: 'receivable', id: f.credit.id },
          content: {
            ledgerEntryId: f.credit.id,
            adjustmentLedgerEntryId: adj,
            reason: '重复赊账',
            amount: '500',
            currency: 'CNY',
          },
        },
      },
    ]);
  });

  it('new event tables and invoker view remain isolated by tenant and reject customer writes', async () => {
    const f = await fixture();
    const other = await fixture();
    const confirmed = await f.confirm();
    await f.reverse(confirmed.settlementId);
    await f.voidCredit(await adjustment(f));
    expect(
      await withTenant(app.db, other.tenant.id, (tx) =>
        tx.select().from(receivableSettlementReversals),
      ),
    ).toEqual([]);
    expect(
      await withTenant(app.db, other.tenant.id, (tx) =>
        tx.select().from(receivableVoids),
      ),
    ).toEqual([]);
    expect(
      await withTenant(app.db, f.tenant.id, (tx) =>
        tx.select().from(receivableVoids),
      ),
    ).toHaveLength(1);
    expect(
      await withTenant(app.db, other.tenant.id, (tx) =>
        tx.select().from(receivables),
      ),
    ).toMatchObject([{ ledgerEntryId: other.credit.id, status: 'pending' }]);
    expect(
      (
        await pgError(
          withTenant(app.db, f.tenant.id, async (tx) => {
            await lockTenants(tx, [f.tenant.id]);
            return tx.insert(receivableSettlementReversals).values({
              tenantId: f.tenant.id,
              settlementId: confirmed.settlementId,
              reason: '禁止',
              reversedBy: actor.id,
            });
          }),
        )
      ).code,
    ).toBe('42501');
    expect(await app.db.select().from(receivableVoids)).toEqual([]);
  });

  it('requires tenant locks, enforces event FKs/uniques and rejects owner mutations', async () => {
    const f = await fixture();
    const other = await fixture();
    const confirmed = await f.confirm();
    expect(
      (
        await pgError(
          withAdmin(app.db, (tx) =>
            tx.insert(receivableSettlementReversals).values({
              tenantId: f.tenant.id,
              settlementId: confirmed.settlementId,
              reason: '无锁',
              reversedBy: actor.id,
            }),
          ),
        )
      ).code,
    ).toBe('55000');
    const insert = (tenantId: string) =>
      withAdmin(app.db, async (tx) => {
        await lockTenants(tx, [tenantId]);
        return tx.insert(receivableSettlementReversals).values({
          tenantId,
          settlementId: confirmed.settlementId,
          reason: '数据库约束',
          reversedBy: actor.id,
        });
      });
    expect((await pgError(insert(other.tenant.id))).code).toBe('23503');
    await f.reverse(confirmed.settlementId);
    expect((await pgError(insert(f.tenant.id))).code).toBe('23505');
    const adj = await adjustment(f);
    await f.voidCredit(adj);
    for (const table of [
      'receivable_settlement_reversals',
      'receivable_voids',
    ]) {
      for (const statement of [
        `update ${table} set reason='changed' where tenant_id=$1`,
        `delete from ${table} where tenant_id=$1`,
      ])
        expect(
          (await pgError(owner.pool.query(statement, [f.tenant.id]))).code,
        ).toBe('42501');
      expect((await pgError(owner.pool.query(`truncate ${table}`))).code).toBe(
        '42501',
      );
    }
  });

  it('enforces void credit and adjustment uniqueness, kind and tenant FKs in Postgres', async () => {
    const f = await fixture();
    const other = await fixture();
    const adj = await adjustment(f);
    const otherAdj = await adjustment(other);
    const insert = (ledgerEntryId: string, adjustmentLedgerEntryId: string) =>
      withAdmin(app.db, async (tx) => {
        await lockTenants(tx, [f.tenant.id]);
        return tx.insert(receivableVoids).values({
          tenantId: f.tenant.id,
          ledgerEntryId,
          adjustmentLedgerEntryId,
          reason: '数据库约束',
          voidedBy: actor.id,
        });
      });
    expect((await pgError(insert(adj, adj))).code).toBe('23503');
    expect((await pgError(insert(f.credit.id, f.credit.id))).code).toBe(
      '23503',
    );
    expect((await pgError(insert(other.credit.id, adj))).code).toBe('23503');
    expect((await pgError(insert(f.credit.id, otherAdj))).code).toBe('23503');
    expect(
      (
        await pgError(
          withAdmin(app.db, (tx) =>
            tx.insert(receivableVoids).values({
              tenantId: f.tenant.id,
              ledgerEntryId: f.credit.id,
              adjustmentLedgerEntryId: adj,
              reason: '无锁',
              voidedBy: actor.id,
            }),
          ),
        )
      ).code,
    ).toBe('55000');
    await f.voidCredit(adj);
    const secondAdj = await adjustment(f);
    expect(await pgError(insert(f.credit.id, secondAdj))).toMatchObject({
      code: '23505',
      constraint: 'receivable_voids_ledger_entry_id_key',
    });
    const secondCredit = await withAdmin(app.db, (tx) =>
      appendLedgerEntry(tx, f.tenant, {
        kind: 'credit_recharge',
        amount: money('CNY', '500'),
        note: '',
        adminId: actor.id,
        idempotencyKey: randomUUID(),
      }),
    );
    expect(await pgError(insert(secondCredit.id, adj))).toMatchObject({
      code: '23505',
      constraint: 'receivable_voids_adjustment_ledger_entry_id_key',
    });
    expect(await f.state()).toMatchObject({
      status: 'voided',
      adjustmentLedgerEntryId: adj,
    });
  });

  it('rejects direct SQL voiding of received credits and all later events or mutations after voiding', async () => {
    const f = await fixture();
    const confirmed = await f.confirm();
    const adj = await adjustment(f);
    const insertVoid = () =>
      withAdmin(app.db, async (tx) => {
        await lockTenants(tx, [f.tenant.id]);
        return tx.execute(sql`
          insert into receivable_voids (tenant_id, ledger_entry_id, adjustment_ledger_entry_id, reason, voided_by)
          values (${f.tenant.id}, ${f.credit.id}, ${adj}, '直接 SQL 作废', ${actor.id})
        `);
      });
    expect(await pgError(insertVoid())).toMatchObject({
      code: '23514',
      constraint: 'receivable_voids_pending',
    });
    expect(
      await pgError(
        withTenant(app.db, f.tenant.id, async (tx) => {
          await lockTenants(tx, [f.tenant.id]);
          return tx.execute(sql`
            insert into receivable_voids (tenant_id, ledger_entry_id, adjustment_ledger_entry_id, reason, voided_by)
            values (${f.tenant.id}, ${f.credit.id}, ${adj}, '禁止', ${actor.id})
          `);
        }),
      ),
    ).toMatchObject({ code: '42501' });
    expect(await f.state()).toMatchObject({ status: 'received' });
    await f.reverse(confirmed.settlementId);
    await insertVoid();

    const insertEvent = (statement: ReturnType<typeof sql>) =>
      withAdmin(app.db, async (tx) => {
        await lockTenants(tx, [f.tenant.id]);
        return tx.execute(statement);
      });
    expect(
      await pgError(
        insertEvent(sql`
          insert into receivable_settlements (tenant_id, ledger_entry_id, received_on, confirmed_by)
          values (${f.tenant.id}, ${f.credit.id}, ${beijingDate()}, ${actor.id})
        `),
      ),
    ).toMatchObject({
      code: '23514',
      constraint: 'receivable_settlements_pending',
    });
    expect(
      await pgError(
        insertEvent(sql`
          insert into receivable_settlement_reversals (tenant_id, settlement_id, reason, reversed_by)
          values (${f.tenant.id}, ${confirmed.settlementId}, '作废后撤销', ${actor.id})
        `),
      ),
    ).toMatchObject({
      code: '23514',
      constraint: 'receivable_settlement_reversals_not_voided',
    });
    for (const statement of [
      "update ledger_entries set note = 'changed' where id = $1",
      'delete from ledger_entries where id = $1',
      "update receivable_settlements set note = 'changed' where ledger_entry_id = $1",
      'delete from receivable_settlements where ledger_entry_id = $1',
    ]) {
      expect(
        (await pgError(owner.pool.query(statement, [f.credit.id]))).code,
      ).toBe('42501');
    }
    expect(await f.state()).toMatchObject({
      status: 'voided',
      adjustmentLedgerEntryId: adj,
      latestSettlementId: confirmed.settlementId,
    });
    expect(await counts(f)).toMatchObject({
      settlements: 1,
      reversals: 1,
      voids: 1,
    });
  });

  it.each(['CNY', 'USD'] as const)(
    'rejects direct SQL linking a CNY credit to another tenant adjustment in %s',
    async (currency) => {
      const f = await fixture('CNY');
      const other = await fixture(currency);
      const adj = await adjustment(other);
      expect(
        await pgError(
          withAdmin(app.db, async (tx) => {
            await lockTenants(tx, [f.tenant.id]);
            return tx.execute(sql`
              insert into receivable_voids (tenant_id, ledger_entry_id, adjustment_ledger_entry_id, reason, voided_by)
              values (${f.tenant.id}, ${f.credit.id}, ${adj}, '其他租户或币种', ${actor.id})
            `);
          }),
        ),
      ).toMatchObject({ code: '23503' });
      expect(
        await pgError(
          owner.pool.query('update tenants set currency = $1 where id = $2', [
            currency === 'CNY' ? 'USD' : 'CNY',
            other.tenant.id,
          ]),
        ),
      ).toMatchObject({ code: '23514' });
      expect(await f.state()).toMatchObject({ status: 'pending' });
      expect(await counts(f)).toMatchObject({ voids: 0 });
    },
  );

  it('serializes direct SQL confirmation against voiding with the existing tenant lock', async () => {
    const f = await fixture();
    const adj = await adjustment(f);
    const statements = [
      sql`
        insert into receivable_settlements (tenant_id, ledger_entry_id, received_on, confirmed_by)
        values (${f.tenant.id}, ${f.credit.id}, ${beijingDate()}, ${actor.id})
      `,
      sql`
        insert into receivable_voids (tenant_id, ledger_entry_id, adjustment_ledger_entry_id, reason, voided_by)
        values (${f.tenant.id}, ${f.credit.id}, ${adj}, '并发作废', ${actor.id})
      `,
    ];
    const results = await Promise.all(
      statements.map((statement) =>
        withAdmin(app.db, async (tx) => {
          await lockTenants(tx, [f.tenant.id]);
          await tx.execute(statement);
          return 'inserted';
        }).catch(async (error: unknown) => {
          if (!(error instanceof Error)) throw error;
          return pgError(Promise.reject(error));
        }),
      ),
    );
    expect(results.filter((result) => result === 'inserted')).toHaveLength(1);
    expect(results.filter((result) => result !== 'inserted')).toMatchObject([
      { code: '23514' },
    ]);
    const persisted = await counts(f);
    expect(persisted.settlements + persisted.voids).toBe(1);
    expect(await f.state()).toMatchObject({
      status: persisted.voids === 1 ? 'voided' : 'received',
    });
  });
});
