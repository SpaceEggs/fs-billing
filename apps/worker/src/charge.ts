import { chargeCall, lockTenants, withSystem, type Db } from '@fs-billing/db';
import { chargeJobSchema } from '@fs-billing/shared';

/**
 * 接通时刻的费率由入库保存为快照；任务按该费率计价，流水与余额在同一事务提交。
 * 计价与写流水在 packages/db 的 chargeCall，未归属话单的分配与这里共用。
 */
export async function chargeCdr(db: Db, input: unknown): Promise<void> {
  const job = chargeJobSchema.parse(input);
  await withSystem(db, async (tx) => {
    await lockTenants(tx, [job.tenantId]);
    await chargeCall(tx, job);
  });
}
