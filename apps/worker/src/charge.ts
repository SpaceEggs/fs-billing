import { and, eq } from 'drizzle-orm';
import {
  appendLedgerEntry,
  callChargeKey,
  lockTenants,
  schema,
  withSystem,
  type Db,
} from '@fs-billing/db';
import { money, priceCall, rate } from '@fs-billing/rating';
import { chargeJobSchema } from '@fs-billing/shared';

/** 接通时刻的费率由入库保存为快照；任务按该费率计价，流水与余额在同一事务提交。 */
export async function chargeCdr(db: Db, input: unknown): Promise<void> {
  const job = chargeJobSchema.parse(input);
  await withSystem(db, async (tx) => {
    await lockTenants(tx, [job.tenantId]);
    const [row] = await tx
      .select({
        rate: schema.cdrs.rate,
        durationSeconds: schema.cdrs.durationSeconds,
        answeredAt: schema.cdrs.answeredAt,
        currency: schema.tenants.currency,
      })
      .from(schema.cdrs)
      .innerJoin(schema.tenants, eq(schema.tenants.id, schema.cdrs.tenantId))
      .where(
        and(
          eq(schema.cdrs.callUuid, job.callUuid),
          eq(schema.cdrs.tenantId, job.tenantId),
        ),
      );
    if (!row) throw new Error(`话单 ${job.callUuid} 不存在`);
    if (row.answeredAt === null) return;
    if (row.rate === null) throw new Error(`话单 ${job.callUuid} 缺少费率快照`);
    const priced = priceCall(row.durationSeconds, rate(row.currency, row.rate));
    if (priced.charge.value.isZero()) return;
    await appendLedgerEntry(
      tx,
      { id: job.tenantId, currency: row.currency },
      {
        kind: 'call_charge',
        amount: money(row.currency, priced.charge.value.neg().toFixed()),
        occurredAt: row.answeredAt,
        note: `通话扣费 ${job.callUuid}`,
        idempotencyKey: callChargeKey(job.callUuid),
      },
    );
  });
}
