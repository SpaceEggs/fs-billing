import { and, eq } from 'drizzle-orm';
import {
  appendLedgerEntry,
  callChargeKey,
  lockTenants,
  schema,
  withSystem,
  type Db,
} from '@fs-billing/db';
import { decimal, money } from '@fs-billing/rating';
import { chargeJobSchema } from '@fs-billing/shared';

/** 最小扣费处理器：任务只带标识，金额从已保存的计价快照读取；重复执行不重复扣费。 */
export async function chargeCdr(db: Db, input: unknown): Promise<void> {
  const job = chargeJobSchema.parse(input);
  await withSystem(db, async (tx) => {
    await lockTenants(tx, [job.tenantId]);
    const [row] = await tx
      .select({
        charge: schema.cdrs.charge,
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
    if (row.answeredAt === null || decimal(row.charge).isZero()) return;
    await appendLedgerEntry(
      tx,
      { id: job.tenantId, currency: row.currency },
      {
        kind: 'call_charge',
        amount: money(row.currency, decimal(row.charge).neg().toFixed()),
        occurredAt: row.answeredAt,
        note: `通话扣费 ${job.callUuid}`,
        idempotencyKey: callChargeKey(job.callUuid),
      },
    );
  });
}
