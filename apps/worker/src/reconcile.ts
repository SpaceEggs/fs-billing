import { sql } from 'drizzle-orm';
import {
  AlertKeys,
  lockTenants,
  raiseAlert,
  withSystem,
  type Db,
} from '@fs-billing/db';
import type { PgBoss } from 'pg-boss';
import type { FastifyBaseLogger } from 'fastify';
import {
  CHARGE_QUEUE,
  RECONCILE_QUEUE,
  chargeJobId,
  chargeQueue,
} from './queue.js';

export interface ReconcileOptions {
  minAgeMinutes: number;
  alertAttempts: number;
  lookbackDays: number;
}

/** 只补应收费而无流水的话单；零费率、未接通不应产生负值流水。 */
export async function reconcileCharges(
  db: Db,
  boss: PgBoss,
  options: ReconcileOptions,
  logger: Pick<FastifyBaseLogger, 'error'>,
) {
  const missing = sql`c.started_at >= now() - ${options.lookbackDays} * interval '1 day'
    AND c.charge > 0 AND NOT EXISTS (
    SELECT FROM ledger_entries l WHERE l.tenant_id = c.tenant_id
      AND l.kind = 'call_charge' AND l.idempotency_key = 'call:' || c.call_uuid::text
  ) AND c.received_at < now() - ${options.minAgeMinutes} * interval '1 minute'
    AND (c.reconciled_at IS NULL OR c.reconciled_at < now() - ${options.minAgeMinutes} * interval '1 minute')`;
  const candidates = await withSystem(db, (tx) =>
    tx.execute<{ tenant_id: string; call_uuid: string; started_at: string }>(
      sql`SELECT c.tenant_id, c.call_uuid, c.started_at::text FROM cdrs c WHERE ${missing}`,
    ),
  );
  const errors: unknown[] = [];
  for (const candidate of candidates.rows) {
    try {
      await withSystem(db, async (tx) => {
        // 沿用扣费所需的租户锁；拿锁后重查，多个实例不会累计同一次补投。
        await lockTenants(tx, [candidate.tenant_id]);
        const { rows } = await tx.execute<{
          reconcile_attempts: number;
          reconcile_alerted: boolean;
        }>(sql`
        SELECT c.reconcile_attempts, c.reconcile_alerted FROM cdrs c
        WHERE c.call_uuid = ${candidate.call_uuid} AND c.tenant_id = ${candidate.tenant_id}
          AND c.started_at = ${candidate.started_at}::timestamptz AND ${missing}`);
        const cdr = rows[0];
        if (!cdr) return;
        if (
          cdr.reconcile_attempts >= options.alertAttempts &&
          !cdr.reconcile_alerted
        ) {
          // 一通话一条（reconcile_alerted 保证只告警一次）；流水写出时由 chargeCall 恢复。
          await raiseAlert(tx, {
            kind: 'cdr_failed',
            subjectKey: AlertKeys.chargeReconcile(candidate.call_uuid),
            tenantId: candidate.tenant_id,
            description: `${candidate.call_uuid}: 扣费对账持续失败，请人工处理`,
            calls: 1,
          });
          await tx.execute(sql`UPDATE cdrs SET reconcile_alerted = true
          WHERE call_uuid = ${candidate.call_uuid} AND tenant_id = ${candidate.tenant_id}
            AND started_at = ${candidate.started_at}::timestamptz`);
        }
        // 按主键查当前轮次，兼容没有 singleton_key 的存量确定性任务。
        const active = await tx.execute(sql`SELECT 1 FROM pgboss.job
        WHERE name = ${CHARGE_QUEUE} AND id = ${chargeJobId(candidate.call_uuid, cdr.reconcile_attempts)}
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
        WHERE call_uuid = ${candidate.call_uuid} AND tenant_id = ${candidate.tenant_id}
          AND started_at = ${candidate.started_at}::timestamptz`);
      });
    } catch (error) {
      logger.error(
        {
          err: error,
          tenantId: candidate.tenant_id,
          callUuid: candidate.call_uuid,
        },
        '话单扣费对账失败',
      );
      errors.push(error);
    }
  }
  if (errors.length) throw new AggregateError(errors, '话单扣费对账未全部完成');
}

export async function startReconciliation(
  boss: PgBoss,
  db: Db,
  options: ReconcileOptions,
  logger: Pick<FastifyBaseLogger, 'error'>,
) {
  await boss.work(RECONCILE_QUEUE, async () => {
    await reconcileCharges(db, boss, options, logger);
  });
  await boss.schedule(RECONCILE_QUEUE, '* * * * *', null, {
    tz: 'Asia/Shanghai',
  });
}
