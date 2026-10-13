import { sql } from 'drizzle-orm';
import { lockTenants, withSystem, type Db } from '@fs-billing/db';
import type { PgBoss } from 'pg-boss';
import { CHARGE_QUEUE, RECONCILE_QUEUE, chargeQueue } from './queue.js';

export interface ReconcileOptions {
  minAgeMinutes: number;
  alertAttempts: number;
}

/** 只补应收费而无流水的话单；零费率、未接通不应产生负值流水。 */
export async function reconcileCharges(
  db: Db,
  boss: PgBoss,
  options: ReconcileOptions,
) {
  const missing = sql`c.charge > 0 AND NOT EXISTS (
    SELECT FROM ledger_entries l WHERE l.tenant_id = c.tenant_id
      AND l.kind = 'call_charge' AND l.idempotency_key = 'call:' || c.call_uuid::text
  ) AND c.received_at < now() - ${options.minAgeMinutes} * interval '1 minute'
    AND (c.reconciled_at IS NULL OR c.reconciled_at < now() - ${options.minAgeMinutes} * interval '1 minute')`;
  const candidates = await withSystem(db, (tx) =>
    tx.execute<{ tenant_id: string; call_uuid: string }>(
      sql`SELECT c.tenant_id, c.call_uuid FROM cdrs c WHERE ${missing}`,
    ),
  );
  for (const candidate of candidates.rows) {
    await withSystem(db, async (tx) => {
      // 沿用扣费所需的租户锁；拿锁后重查，多个实例不会累计同一次补投。
      await lockTenants(tx, [candidate.tenant_id]);
      const { rows } = await tx.execute<{
        reconcile_attempts: number;
        reconcile_alerted: boolean;
      }>(sql`
        SELECT c.reconcile_attempts, c.reconcile_alerted FROM cdrs c
        WHERE c.call_uuid = ${candidate.call_uuid} AND c.tenant_id = ${candidate.tenant_id} AND ${missing}`);
      const cdr = rows[0];
      if (!cdr) return;
      if (
        cdr.reconcile_attempts >= options.alertAttempts &&
        !cdr.reconcile_alerted
      ) {
        await tx.execute(sql`INSERT INTO system_alerts (tenant_id, kind, description, affected_calls)
          VALUES (${candidate.tenant_id}, 'cdr_failed', ${`${candidate.call_uuid}: 扣费对账持续失败，请人工处理`}, 1)`);
        await tx.execute(sql`UPDATE cdrs SET reconcile_alerted = true
          WHERE call_uuid = ${candidate.call_uuid} AND tenant_id = ${candidate.tenant_id}`);
      }
      // 同时识别升级前没有 singleton_key 的存量任务。
      const active = await tx.execute(sql`SELECT 1 FROM pgboss.job
        WHERE name = ${CHARGE_QUEUE} AND data->>'callUuid' = ${candidate.call_uuid}
          AND state IN ('created', 'retry', 'active') LIMIT 1`);
      if (active.rows.length) return;
      await chargeQueue(boss).enqueue(
        tx,
        {
          tenantId: candidate.tenant_id,
          callUuid: candidate.call_uuid,
        },
        cdr.reconcile_attempts + 1,
      );
      await tx.execute(sql`UPDATE cdrs SET reconcile_attempts = reconcile_attempts + 1, reconciled_at = now()
        WHERE call_uuid = ${candidate.call_uuid} AND tenant_id = ${candidate.tenant_id}`);
    });
  }
}

export async function startReconciliation(
  boss: PgBoss,
  db: Db,
  options: ReconcileOptions,
) {
  await boss.work(RECONCILE_QUEUE, async () => {
    await reconcileCharges(db, boss, options);
  });
  await boss.schedule(RECONCILE_QUEUE, '* * * * *', null, {
    tz: 'Asia/Shanghai',
  });
}
